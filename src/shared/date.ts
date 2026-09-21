/** 日期工具。主进程与渲染进程共用同一套，避免两边对「今天是哪天」判断不一致。
 *
 *  全部按**本地时间**取年月日。不能用 toISOString().slice(0,10)——
 *  那是 UTC，在东八区凌晨 8 点前会算成前一天，日记就会记到昨天去。 */

export function dateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayKey(): string {
  return dateKey(new Date())
}

/** 'YYYY-MM-DD' → 本地零点的 Date。解析失败返回 null，不抛。 */
export function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

export function addDays(key: string, delta: number): string {
  const d = parseDateKey(key) ?? new Date()
  d.setDate(d.getDate() + delta)
  return dateKey(d)
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

export function weekdayZh(key: string): string {
  const d = parseDateKey(key)
  return d ? WEEKDAYS[d.getDay()] : ''
}

/** '2026-09-16' → '2026-09-16 星期三' */
export function formatDateZh(key: string): string {
  const w = weekdayZh(key)
  return w ? `${key} ${w}` : key
}

/** '2026-09-16' → '9 月 16 日' */
export function formatMonthDayZh(key: string): string {
  const d = parseDateKey(key)
  return d ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : key
}

/** 相对时间。只做到天粒度就够——状态条上写「刚刚」，列表里写具体日期。 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const diff = now.getTime() - t.getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 6) return `${hours} 小时前`
  const key = dateKey(t)
  const today = dateKey(now)
  if (key === today) return `今天 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  if (key === addDays(today, -1)) return '昨天'
  return key
}

export function countChars(text: string): number {
  return [...text].length
}