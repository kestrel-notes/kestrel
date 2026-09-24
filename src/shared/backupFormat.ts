/** 备份快照的文件名与保留判据（期-08 §四）。
 *
 *  为什么单独一层：这一档里最贵的一刀是**删文件**——滚动保留要删最旧的那几份，而删错了
 *  没有任何东西能把它找回来。判据放在纯函数里，才能离线一条一条问遍（「留 3 份时该删哪几份」
 *  「恢复前那份自保到底算不算托管快照」），而不是等真机上跑一次碰运气。
 *  落盘、`VACUUM INTO`、重开库都在 `src/main/db/backup.ts`，那一半只有实机验。 */

/** 一天一份：`kestrel-2026-09-24.db` */
const 每日 = /^kestrel-(\d{4}-\d{2}-\d{2})\.db$/
/** 同日的手动那份：`kestrel-2026-09-24-153012.db` */
const 带时刻 = /^kestrel-(\d{4}-\d{2}-\d{2})-(\d{6})\.db$/
/** 换库之前对当前库的那份自保。它也放在 backups/ 里，但**永不进滚动保留那一档** */
const 换库前 = /^kestrel-before-restore-(\d{4}-\d{2}-\d{2})-(\d{6})\.db$/

export const KEEP_DEFAULT = 7
export const KEEP_MIN = 3
export const KEEP_MAX = 30

/** 回收站与历史版本的保留期（#76 那笔账）。设计里写死 30 天，不给人调 */
export const RETENTION_DAYS = 30

const p2 = (n: number): string => String(n).padStart(2, '0')

/** 「今天备过没有」的“今天”是**本地**那一天：文件名是给人看的，判据也得跟人对日历的
 *  那一天一致。库里那些时间戳（`created_at` / `deleted_at`）走的是 UTC ISO，两件事不冲突。 */
export function dayKey(now: Date): string {
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
}

/** 同日多份靠这个分先后，同样是本地时刻 */
export function stampKey(now: Date): string {
  return `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`
}

/** 一一天一份那一档：当天还没有任何快照时，文件名不带时刻。
 *  当天已经有份了（人手动导过）才给新的一份接上时刻——同一天的第二份要是也叫
 *  `kestrel-2026-09-24.db`，就会把早上那份直接盖掉，而那份正是"今天还没崩过"的唯一凭据。 */
export function snapshotName(now: Date, 当天已有: number): string {
  const d = dayKey(now)
  return 当天已有 === 0 ? `kestrel-${d}.db` : `kestrel-${d}-${stampKey(now)}.db`
}

/** 名字里那串数字得真是个日期。不校验的话，用户自己丢进 backups/ 的一份
 *  `kestrel-9999-99-99.db` 会被当成自家快照计进保留名额，然后被自动删掉——
 *  「认不出的名字一概不动」这条要有牙齿，判据就不能只看前缀。 */
function 是个时刻(日: string, 时: string | undefined): boolean {
  const [y, mo, d] = 日.split('-').map(Number)
  if (!(y >= 1970 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return false
  if (时 === undefined) return true
  const h = Number(时.slice(0, 2)), mi = Number(时.slice(2, 4)), s = Number(时.slice(4, 6))
  return h <= 23 && mi <= 59 && s <= 59
}

export function isSnapshot(name: string): boolean {
  const m = 每日.exec(name) ?? 带时刻.exec(name)
  return m !== null && 是个时刻(m[1], m[2])
}

/** 「一天一份」那一种（名字里只有日期）。认出来只为了一件事：它的文件名里没有时刻，
 *  界面上就不该编一个 00:00 出来给人看。 */
export function isDailyName(name: string): boolean {
  const m = 每日.exec(name)
  return m !== null && 是个时刻(m[1], undefined)
}

export function isBeforeRestore(name: string): boolean {
  const m = 换库前.exec(name)
  return m !== null && 是个时刻(m[1], m[2])
}

/** 托管 = 会被滚动保留管到。自保那份不归它管：它的名字开头就不是日期（`before-restore-`），
 *  进不了 `isSnapshot`，所以这一条只需要认那两种快照名。 */
export function isManaged(name: string): boolean {
  return isSnapshot(name)
}

/** 名字本身可排序：字典序 == 时间序。每日那份补 `000000`，于是同一天里它排在所有
 *  手动那份之前（它确实是当天最早的一份——早上开屏时建的）。 */
export function sortKeyOf(name: string): string {
  const m = 带时刻.exec(name) ?? 每日.exec(name) ?? 换库前.exec(name)
  if (!m) return ''
  return m[1] + (m[2] ?? '000000')
}

/** 新→旧。认的是文件名里的时间戳，不是 mtime：文件被同步盘复制过一遍 mtime 就变了，
 *  而名字跟着内容走。 */
export function newestFirst(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const k = sortKeyOf(b).localeCompare(sortKeyOf(a))
    return k !== 0 ? k : b.localeCompare(a)
  })
}

/** 滚动保留：留最新的 `keep` 份，其余报名字。
 *
 *  三条边界都是这一刀能不能放心自动跑的关键：
 *  - 认不出的名字（用户自己丢进去的一份 `我的库.db`）一概不动；
 *  - `kestrel-before-restore-*` 不动——它是换库之前唯一的退路，删它就等于把恢复变成单向门；
 *  - `keep` 少于当前份数才动手，`keep` 给到非法值当作默认值，不会因为一行坏设置全删光。 */
export function toPrune(names: string[], keep: number): string[] {
  const 留 = keepClamp(keep)
  const 托管 = newestFirst(names.filter(isManaged))
  // 反过来说：删的时候从最旧那一份开始删，报出来的清单也按这个顺序给人看
  return 托管.length <= 留 ? [] : 托管.slice(留).reverse()
}

/** 当天是否已经有那一份。有就不必再建——「一份 = 一天」是这一档的判据，
 *  而它得能从目录本身读出来：`Setting` 里那一行会跟着库走，快照不会。 */
export function hasSnapshotForDay(names: string[], day: string): boolean {
  return names.some((n) => isSnapshot(n) && sortKeyOf(n).slice(0, 10) === day)
}

export function keepClamp(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : KEEP_DEFAULT
  return Math.min(KEEP_MAX, Math.max(KEEP_MIN, n))
}

/** 裁剪的时间线：`now - days`，格式与库里的 `created_at` / `deleted_at` 一致
 *  （`new Date().toISOString()`，恒定三位小数 + `Z`），所以库里直接拿它做字符串比较。 */
export function cutoffIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86400000).toISOString()
}
