/** 全文索引那台虚表的数据侧：什么时候建、怎么建、建到哪一步了。
 *
 *  为什么这些代码不写在迁移里，两条都是实测出来的硬理由（docs/期-03-设计.md §2.6 / §2.7）：
 *
 *  1. **建索引很慢**：6 万条 × 600 字（34 MiB 正文）分批要 33~39 秒，而迁移跑在
 *     `createWindow()` 之前——同步建等于大库升级之后窗口半分钟不出现。所以分批、
 *     每批之间让出主线程，并且**必须在首帧之后**开始。
 *  2. **索引不全时不能装触发器**：对外部内容表执行 FTS5 的 `'delete'` 时，如果那个 rowid
 *     不在索引里（或传进去的旧值与索引里的 token 对不上），SQLite 不报「找不到」而是抛
 *     `database disk image is malformed`；发生在触发器里就是**整条用户写操作回滚**——
 *     回填窗口里用户随手改一篇还没索引的旧笔记，保存会直接失败。这是内容损失，红线。
 *     所以触发器由这里在索引追平之后装上，回填期间它们不存在。
 *
 *  「追平」靠一个廉价的水印（行数 / id 之和 / max(updated_at)）：一轮灌完水印没动，
 *  说明这一轮里没有任何写进来，才敢装触发器。动过就重来一轮。
 *  重来一轮**不是**把差的那几行补上，而是整表清空重灌（`delete-all` 只要 157ms），
 *  因为「重插同一 rowid」不会清掉旧 token——MATCH 还能搜到改前的词、LIKE 却搜不到，
 *  两条路给出不同答案，而 `integrity-check` 对这种残留报 ok（§2.7）。留着残留的索引
 *  比没有索引坏得多。 */

import { getDatabase } from './index'

export type FtsState = 'pending' | 'building' | 'ready'

/** 状态位存在 Setting 表里。settings.ts 的 coerce 只认它那四个设置键，
 *  多出来的键读时忽略、写时不碰，所以这里直接用 SQL 读写，不绕道 settings.ts——
 *  这不是用户配置，是引擎的进度。 */
const KEY = 'fts.backfill'

/** 500 条一批：34 MiB 那种极端库上单批中位 232ms、最慢 565ms（§2.6）。
 *  再小到 200 条只是把总时长从 37 秒拖到 39 秒，换不到什么。 */
const BATCH = 500

/** 一轮 = 清空 + 全量分批 + 水印比对。连续 8 轮都没等到一个安静的窗口就收工，
 *  状态留在 building：搜索走原表 LIKE 兜底，下次启动或下次开搜索面板再试。 */
const ROUNDS = 8

/** 触发器：Entry 的写入分散在 entries / promote / restore / purge / 重命名改写正文
 *  等六七处，靠每个调用点记得补一句索引更新一定会漏，靠触发器不会。
 *
 *  title 一律 coalesce 兜空：Entry.title 可空（未命名文章），而 'delete' 是按传进去的
 *  旧值重算 token 的，NULL 与 '' 分词结果都是空——两边不一致就会留下删不掉的幽灵条目。 */
export const FTS_TRIGGERS = `
  create trigger EntryFts_ai after insert on Entry begin
    insert into EntryFts(rowid, title, content)
      values (new.id, coalesce(new.title, ''), new.content);
  end;

  create trigger EntryFts_au after update on Entry begin
    insert into EntryFts(EntryFts, rowid, title, content)
      values ('delete', old.id, coalesce(old.title, ''), old.content);
    insert into EntryFts(rowid, title, content)
      values (new.id, coalesce(new.title, ''), new.content);
  end;

  create trigger EntryFts_ad after delete on Entry begin
    insert into EntryFts(EntryFts, rowid, title, content)
      values ('delete', old.id, coalesce(old.title, ''), old.content);
  end;
`

const DROP_TRIGGERS = `
  drop trigger if exists EntryFts_ai;
  drop trigger if exists EntryFts_au;
  drop trigger if exists EntryFts_ad;
`

type Watermark = { rows: number; sum: number; touched: string }

const unchanged = (a: Watermark, b: Watermark) =>
  a.rows === b.rows && a.sum === b.sum && a.touched === b.touched

/** 这一轮中途有没有人写过库。三样都看是因为它们各挡一种：
 *  改正文/标题看 max(updated_at)（entries.ts 的每条写路径都盖这个列），
 *  新建看 id 之和，彻底删除看行数。软删/恢复不动索引内容（§5.1），
 *  但它们也盖 updated_at，所以会被当成脏——多跑一轮而已，不亏。 */
function watermark(): Watermark {
  const row = getDatabase()
    .prepare(
      `select count(*) as rows, coalesce(sum(id), 0) as sum, coalesce(max(updated_at), '') as touched
       from Entry`
    )
    .get() as unknown as Watermark
  return row
}

function readState(): FtsState {
  const row = getDatabase().prepare('select value from Setting where key = ?').get(KEY) as
    | { value: string }
    | undefined
  if (!row) return 'pending'
  let parsed: unknown
  try {
    parsed = JSON.parse(row.value)
  } catch {
    return 'pending'
  }
  return parsed === 'ready' || parsed === 'building' ? parsed : 'pending'
}

function writeState(state: FtsState): void {
  getDatabase()
    .prepare('insert or replace into Setting(key, value) values(?, ?)')
    .run(KEY, JSON.stringify(state))
}

export function isReady(): boolean {
  return readState() === 'ready'
}

/** 面板那句「索引建立中（已完成 N%）」的数据源。done 是当前这一轮的进度，
 *  渲染进程只能轮询这里——回调跨不过 IPC。 */
export function status(): { state: FtsState; done: number; total: number } {
  const total = entryCount()
  return { state: readState(), done: Math.min(done, total), total }
}

function entryCount(): number {
  const row = getDatabase()
    .prepare('select count(*) as c from Entry')
    .get() as unknown as { c: number | bigint }
  return Number(row.c)
}

let active: Promise<FtsState> | null = null
let done = 0

const yieldTick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** 首帧之后调一次。已经在跑就返回同一个 promise——重启应用、打开搜索面板、
 *  上一轮没收敛，都会再触发这里，不该并行跑两份。 */
export function ensureIndex(): Promise<FtsState> {
  if (isReady()) return Promise.resolve('ready')
  if (active) return active
  active = backfill().finally(() => {
    active = null
  })
  return active
}

async function backfill(): Promise<FtsState> {
  const db = getDatabase()
  writeState('building')
  // 上一版迁移就把触发器建在 schema 里，崩溃在半路的库也可能留着它们：先卸掉。
  // 索引没追平之前它们必须不存在，理由见文件头第 2 条。
  db.exec(DROP_TRIGGERS)

  for (let round = 0; round < ROUNDS; round++) {
    db.prepare("insert into EntryFts(EntryFts) values('delete-all')").run()
    const before = watermark()
    done = 0

    let cursor = 0
    for (;;) {
      const ids = db
        .prepare('select id from Entry where id > ? order by id limit ?')
        .all(cursor, BATCH) as unknown as { id: number }[]
      const last = ids[ids.length - 1]
      if (!last) break
      db.prepare(
        `insert into EntryFts(rowid, title, content)
         select id, coalesce(title, ''), content from Entry
          where id > ? and id <= ?`
      ).run(cursor, last.id)
      done += ids.length
      cursor = Number(last.id)
      await yieldTick()
    }

    const after = watermark()
    if (unchanged(before, after)) {
      db.exec(FTS_TRIGGERS)
      writeState('ready')
      return 'ready'
    }
    await yieldTick()
  }

  // 一直没等到安静窗口：状态留在 building，搜索继续走原表 LIKE 兜底，
  // 下次启动或下次调 ensureIndex 再试一轮。
  return 'building'
}

/** 一致性自检。给验收和 dev.sql 用，**不是**运行时代码——6 万条上要 2.7 秒。
 *
 *  它只查「内容表里的每一行在索引里有没有对应条目」，查不出反方向的残留
 *  （旧 token 赖在索引里它照样报 ok，§2.7 第二条），所以这里报 ok 不等于索引干净。
 *  真要保证干净靠的是回填每轮先 delete-all。 */
export function integrityCheck(): string {
  const t = Date.now()
  try {
    getDatabase().prepare("insert into EntryFts(EntryFts) values('integrity-check')").run()
    return `ok (${Date.now() - t}ms)`
  } catch (err) {
    return `failed: ${(err as Error).message}`
  }
}
