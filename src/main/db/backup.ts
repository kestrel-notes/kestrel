/** 备份、滚动保留、30 天裁剪与换库（期-08 §四）。
 *
 *  三条判据都来自前置实测 0.4（`scratch/p8-probe-b.mjs` D 段 + `p8-probe-c.mjs`），不是想当然：
 *
 *  1. **备份走 `VACUUM INTO`，不走文件复制。** 应用在跑的时候 WAL 就是真相的一部分——
 *     实测「拷主文件 + 删 -wal」拷走的是一份**缺了最近那些写入**的库，那不是备份，是丢数据。
 *     `VACUUM INTO` 走的是这条连接自己，读得进 WAL，产物是单个不带 `-wal` 的完整文件
 *     （22ms 量级，`integrity_check ok`）。`node:sqlite` 没有在线备份 API，所以只有这一条路。
 *  2. **裁剪跑在备份之后**，顺序是硬的：那几份快照就是 30 天那一刀唯一的回退路径。
 *  3. **换库是同步的一段**（关连接 → 自保 → 换文件 → 重开）。中间不让出事件循环，
 *     否则 IPC 能插进"连接已关、文件还没换上"那一瞬，那正是 0.4 那种坑的孪生兄弟。
 *
 *  哪些判据不在这里：文件名、排序、留几份、时间线——全在 `shared/backupFormat.ts`，
 *  因为「哪一份该删」是不可逆的，它得能在离线套件里被逐条问遍（`scratch/p8-bk-test.mjs`）。 */

import { app } from 'electron'
import { basename, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import type { BackupInfo, BackupRun, BackupStatus, RestoreResult } from '../../shared/types'
import {
  RETENTION_DAYS,
  cutoffIso,
  dayKey,
  hasSnapshotForDay,
  isBeforeRestore,
  isDailyName,
  isSnapshot,
  keepClamp,
  newestFirst,
  snapshotName,
  sortKeyOf,
  stampKey,
  toPrune,
} from '../../shared/backupFormat'
import { purge } from './entries'
import { DatabaseSync, closeDatabase, databaseFile, getDatabase, isOpen, openDatabase } from './index'
import { all as settingsAll } from './settings'

/** 快照目录固定在库旁边。不给渲染进程挑路径的口子：这一档只有"哪一份"，没有"哪儿"。 */
export function backupRoot(): string {
  return join(app.getPath('userData'), 'backups')
}

/** 目录里的候选文件名。目录还不存在 = 一次都没备过，不是错误。 */
function 盘上的(): string[] {
  const dir = backupRoot()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.db'))
    .map((n) => basename(n))
}

function 自家的(): string[] {
  return 盘上的().filter((n) => isSnapshot(n) || isBeforeRestore(n))
}

function 同一天(now: Date): number {
  const d = dayKey(now)
  return 盘上的().filter((n) => isSnapshot(n) && sortKeyOf(n).slice(0, 10) === d).length
}

/** 打开一份快照数一遍篇数。**只读**：这一步要是把 WAL 建在备份目录里，就等于我把
 *  「拷主文件丢数据」那个坑亲手复现了一遍。数不出来就回 null，界面写「数不出来」。 */
function 数一份(path: string): number | null {
  let conn: DatabaseSync | null = null
  try {
    conn = new DatabaseSync(path, { readOnly: true })
    const row = conn
      .prepare('select count(*) as c from Entry where deleted_at is null')
      .get() as unknown as { c: number | bigint }
    return Number(row.c)
  } catch {
    return null
  } finally {
    conn?.close()
  }
}

/** 每日那一份的名字里没有时刻，界面上就不编一个 00:00 出来 */
function 时刻(name: string): string {
  const k = sortKeyOf(name)
  if (!k) return name
  return isDailyName(name)
    ? k.slice(0, 10)
    : `${k.slice(0, 10)} ${k.slice(10, 12)}:${k.slice(12, 14)}`
}

function infoOf(name: string): BackupInfo {
  const path = join(backupRoot(), name)
  return {
    name,
    kind: isBeforeRestore(name) ? 'before' : isDailyName(name) ? 'daily' : 'manual',
    at: 时刻(name),
    size: existsSync(path) ? statSync(path).size : 0,
    entries: existsSync(path) ? 数一份(path) : null,
  }
}

/** 写盘失败要说人话：这一档最坏的结局是"用户以为有备份"。磁盘满、目录只读、
 *  被同步盘占住，都得在按下按钮的那一处报出来，而不是只留一行 errno。 */
function 说人话(err: unknown, 在干什么: string): Error {
  const m = err instanceof Error ? err.message : String(err)
  if (/ENOSPC|磁盘空间|no space/i.test(m)) return new Error(`${在干什么}没写成：磁盘满了。`)
  if (/EPERM|EACCES|read-only|拒绝访问|permission/i.test(m))
    return new Error(`${在干什么}没写成：备份目录写不进去（只读？被别的程序占着？）`)
  return new Error(`${在干什么}没写成：${m}`)
}

/** 落一份快照。`带时刻` = 手动那一档，它总给文件名接上 HHmmss，
 *  于是同一天里第二份不会把早上那份直接盖掉（那是"今天还没崩过"的唯一凭据）。 */
function 落一份(now: Date, 带时刻: boolean): { name: string; ms: number } {
  const dir = backupRoot()
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    throw 说人话(err, '建备份目录')
  }
  // 名字只由 `shared/backupFormat.ts` 那一条规则决定：手动那一档把「当天已有」抬到至少 1，
  // 于是它总带上时刻，绝不会去盖早上那一份
  const name = snapshotName(now, 带时刻 ? Math.max(1, 同一天(now)) : 同一天(now))
  const path = join(dir, name)
  if (existsSync(path)) throw new Error(`这一秒已经有一份了（${name}），隔一秒再按。`)
  const t0 = Date.now()
  try {
    // 路径绑参进去，不拼字符串：`VACUUM INTO` 这一条实测支持占位符（Electron 内置 SQLite）
    getDatabase().prepare('vacuum into ?').run(path)
  } catch (err) {
    if (existsSync(path)) rmSync(path) // 半截的那一份不配留在备份目录里
    throw 说人话(err, '备份')
  }
  return { name, ms: Date.now() - t0 }
}

/** 滚动保留：只删自家那两种快照，`before-restore` 与外来文件一个字都不碰。 */
function 滚一滚(keep: number): string[] {
  const gone = toPrune(盘上的(), keep)
  const dir = backupRoot()
  for (const name of gone) {
    try {
      rmSync(join(dir, name))
    } catch (err) {
      throw 说人话(err, `删掉旧的快照（${name}）`)
    }
  }
  return gone
}

/** 30 天那一刀：历史版本与回收站各一刀。回收站那一刀走既有的 `purge`，
 *  因为 `Link` / `Bookmark` 没有外键，只有那条路把侧账一起收干净（`entries.ts:364` 的注）。
 *
 *  **分批 + 每批之间让出事件循环**。这一刀平时是零行，一旦有活要干就是"库里躺了三百天
 *  的那一整批"：58,809 篇那份大库上实测躺着 1,170 篇，一篇一个事务从头删到尾会把主线程
 *  同步占住 7.6 秒——而它跑在开屏之后 1.2 秒那一档，那正是人刚开始打字的时候，
 *  排在那后面的不只是进度查询，还有自动保存那一发 IPC。
 *  `VACUUM INTO` 那 2.9 秒是单条语句，让不出去，所以本函数的让步只保证自己这一段不叠上去。 */
export async function pruneHistory(
  days: number = RETENTION_DAYS
): Promise<{ revisions: number; entries: number }> {
  const 线 = cutoffIso(new Date(), days)
  const db = getDatabase()
  // 历史版本那一刀也分批：一条 `delete` 删五万行会把 WAL 一口气撑大、主线程一口气占住
  let revisions = 0
  for (;;) {
    const 删 = Number(
      db
        .prepare(
          'delete from Revision where id in (select id from Revision where created_at < ? limit ?)'
        )
        .run(线, 批次).changes
    )
    revisions += 删
    if (删 < 批次) break
    await yieldToLoop()
  }
  const 到期 = (
    db
      .prepare('select id from Entry where deleted_at is not null and deleted_at < ? order by id')
      .all(线) as unknown as { id: number | bigint }[]
  ).map((row) => Number(row.id))
  for (let i = 0; i < 到期.length; i += 批次) {
    for (const id of 到期.slice(i, i + 批次)) purge(id)
    if (i + 批次 < 到期.length) await yieldToLoop()
  }
  return { revisions, entries: 到期.length }
}

/** 一批多少篇。判据是量出来的，不是拍的：大库上一篇 `purge` 约 6.5ms，200 一批会把主线程
 *  一口气占住 1.3 秒——那跟不分批差不了多少。40 一批压在 0.3 秒内，让出点才真的让得出去。 */
const 批次 = 40
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** 界面要摆的那几个数。全是读，没有一处写。 */
export function status(): BackupStatus {
  const s = settingsAll()
  const 线 = cutoffIso(new Date(), RETENTION_DAYS)
  const names = newestFirst(自家的())
  const today = dayKey(new Date())
  return {
    dir: backupRoot(),
    enabled: s.backupEnabled,
    keep: keepClamp(s.backupKeep),
    today,
    hasToday: hasSnapshotForDay(names, today),
    snapshots: names.map(infoOf),
    pending: {
      // 30 天那一刀现在就摆在这儿：#76 的原话是「保留期只是显示」，那就把它数成一个数
      revisions: 数一句('select count(*) as c from Revision where created_at < ?', 线),
      entries: 数一句(
        'select count(*) as c from Entry where deleted_at is not null and deleted_at < ?',
        线
      ),
    },
  }
}

function 数一句(sql: string, 线: string): number {
  const row = getDatabase().prepare(sql).get(线) as unknown as { c: number | bigint }
  return Number(row.c)
}

/** 手动那一份：总落，落完按名额滚一滚。 */
export function snapshotNow(): BackupRun {
  const s = settingsAll()
  const { name, ms } = 落一份(new Date(), true)
  const pruned = 滚一滚(keepClamp(s.backupKeep))
  return { made: true, name, pruned, ms }
}

/** 开屏之后跑的那一串：先备份、再按名额滚、最后才轮到 30 天那一刀。
 *  顺序在这里是判据本身，不是排版（见文件头第 2 条）。 */
export async function runMaintenance(): Promise<void> {
  if (!isOpen()) return
  const s = settingsAll()
  const keep = keepClamp(s.backupKeep)
  try {
    const today = dayKey(new Date())
    let made: string | null = null
    if (!s.backupEnabled) {
      console.log('[backup] 自动备份被设置关着，这一跑跳过')
    } else if (hasSnapshotForDay(盘上的(), today)) {
      console.log(`[backup] 今天（${today}）已经有那一份了，不重复建`)
    } else {
      made = 落一份(new Date(), false).name
    }
    const pruned = 滚一滚(keep)
    if (made) console.log(`[backup] 落了一份：${made}`)
    if (pruned.length) console.log(`[backup] 超出保留名额 ${keep} 份，删掉：${pruned.join('、')}`)
    if (!isOpen()) return
    const cut = await pruneHistory()
    if (cut.revisions || cut.entries)
      console.log(
        `[backup] 30 天那一刀：历史版本删了 ${cut.revisions} 版、回收站里彻底删了 ${cut.entries} 篇`
      )
  } catch (err) {
    console.error('[backup] 这一跑没成:', (err as Error).message)
  }
}

/** 换到某一份快照。先给当前库存一份自保，再换上，然后重开连接。
 *  全程同步——见文件头第 3 条。返回里带着那份自保的名字，界面上要写出来：
 *  它是「换错了还能回哪去」的唯一答案。 */
export function restore(name: string): RestoreResult {
  const 干净 = basename(name)
  if (!isSnapshot(干净) && !isBeforeRestore(干净))
    throw new Error(`「${name}」不是 Kestrel 的快照名，换库只能从列表里那几份挑`)
  const dir = backupRoot()
  const from = join(dir, 干净)
  if (!existsSync(from)) throw new Error(`没有这一份快照：${干净}`)

  const cur = databaseFile()
  const 自保 = 空位()
  closeDatabase()
  try {
    copyFileSync(cur, join(dir, 自保))
    // 先清掉旧连接的残留，再把快照拷进来。反过来的话万一 rm 挂在中间，
    // 就是"新库 + 上一部库的 WAL"——那正是 0.4 量到的那个丢数据方向
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(cur + suffix)) rmSync(cur + suffix)
    }
    copyFileSync(from, cur)
  } catch (err) {
    openDatabase(cur)
    throw 说人话(err, '换库')
  }
  openDatabase(cur)
  return { from: 干净, saved: 自保, entries: 数一份(cur) }
}

/** 自保那一份的文件名。同一秒里换两次库是可能的（第一次换坏了），所以往后找空位。 */
function 空位(): string {
  const now = new Date()
  const dir = backupRoot()
  mkdirSync(dir, { recursive: true })
  for (let 秒 = 0; 秒 < 60; 秒++) {
    const 试 = new Date(now.getTime() + 秒 * 1000)
    const name = `kestrel-before-restore-${dayKey(试)}-${stampKey(试)}.db`
    if (!existsSync(join(dir, name))) return name
  }
  throw new Error('这一分钟里备份目录里已经全是自保那份了，先清一清再换库')
}

/** 首帧之后再跑（期-03 那条首屏红线 ≤3000ms 是硬的：备份与裁剪都不许挤进首屏那条链）。
 *  延后而不是排队等索引追平——大库的回填要跑几分钟，人可能那时候已经关了窗口。 */
export function scheduleMaintenance(delayMs = 1200): void {
  setTimeout(() => {
    try {
      runMaintenance()
    } catch (err) {
      console.error('[backup] 这一跑没成:', (err as Error).message)
    }
  }, delayMs)
}
