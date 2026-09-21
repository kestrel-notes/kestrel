import type { Revision, RevisionReason, RevisionSummary } from '../../shared/types'
import { bindable, getDatabase, parseJsonObject } from './index'

/** 同一篇的自动快照至少隔这么久才写一条。
 *  自动保存是 500ms 一次防抖，不设门槛的话打一段字能产生几百行几乎相同的快照，
 *  历史列表会变成一串"3 秒前 / 6 秒前 / 9 秒前"，等于没有历史。 */
const AUTO_MIN_GAP_MS = 5 * 60 * 1000

/** 每篇最多留这么多条，超出删最旧的。
 *  30 天裁剪留给第 8 期——那时会跟备份清理合到一处统一做，现在做会出现两个清理入口。 */
const MAX_PER_ENTRY = 50

interface RevisionRow {
  id: number
  entry_id: number
  title: string | null
  content: string
  props: string
  reason: RevisionReason
  created_at: string
}

interface StateRow {
  id: number
  title: string | null
  content: string
  props: string
}

function toRevision(r: RevisionRow): Revision {
  return {
    id: r.id,
    entryId: r.entry_id,
    title: r.title,
    content: r.content,
    props: parseJsonObject(r.props),
    reason: r.reason,
    createdAt: r.created_at,
  }
}

/** 历史版本列表。**刻意不带 content**：一篇几千字的文档列 50 条就是几百 KB，
 *  而列表上只需要"什么时候、多长、怎么来的"。正文等预览时用 get() 单独取。 */
export function list(entryId: number): RevisionSummary[] {
  const rows = getDatabase()
    .prepare(
      `select id, title, length(content) as char_count, reason, created_at
       from Revision where entry_id = ?
       order by created_at desc, id desc`
    )
    .all(entryId) as unknown as {
    id: number
    title: string | null
    char_count: number
    reason: RevisionReason
    created_at: string
  }[]

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    charCount: r.char_count,
    reason: r.reason,
    createdAt: r.created_at,
  }))
}

export function get(id: number): Revision | null {
  const row = getDatabase()
    .prepare('select * from Revision where id = ?')
    .get(id) as unknown as RevisionRow | undefined
  return row ? toRevision(row) : null
}

/** 给一篇记录留一份当前状态的快照。
 *
 *  - `auto`：距上一条不足 5 分钟就**跳过**。跳过而不是"改写上一条"——改写会丢掉这个
 *    时间窗开始时的状态，而那份状态才是崩溃恢复真正想要的东西。
 *  - `manual`（Ctrl+S）/ `restore`（恢复前自保）：总是写，用户明确要求过的东西不该被门槛挡掉。
 *
 *  调用方负责事务：本函数只发 insert，不自己开事务（`transact` 不支持嵌套）。 */
export function snapshot(entryId: number, reason: RevisionReason): void {
  const db = getDatabase()
  const state = db
    .prepare('select id, title, content, props from Entry where id = ?')
    .get(entryId) as unknown as StateRow | undefined
  if (!state) return

  if (reason === 'auto') {
    const last = db
      .prepare('select created_at from Revision where entry_id = ? order by created_at desc, id desc limit 1')
      .get(entryId) as unknown as { created_at: string } | undefined
    if (last && Date.now() - Date.parse(last.created_at) < AUTO_MIN_GAP_MS) return
  }

  db.prepare(
    `insert into Revision(entry_id, title, content, props, reason, created_at)
     values(?, ?, ?, ?, ?, ?)`
  ).run(
    entryId,
    bindable(state.title),
    state.content,
    bindable(state.props === '' ? '{}' : state.props),
    reason,
    new Date().toISOString()
  )

  // 裁掉超出的部分。created_at 是 ISO 串，字典序即时间序，可以直接排。
  db.prepare(
    `delete from Revision
      where entry_id = ?
        and id not in (
          select id from Revision where entry_id = ?
          order by created_at desc, id desc limit ${MAX_PER_ENTRY}
        )`
  ).run(entryId, entryId)
}