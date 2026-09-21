import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { addDays, formatMonthDayZh, parseDateKey, todayKey, weekdayZh } from '../../../shared/date'
import { heatLevel, HEAT_WEEKS, useStore } from '@/store'

/** GitHub 式日历。每列一周，行是周日→周六。
 *  起点对齐到「今天所在周的周日」，格子才会跟星期对齐。
 *  注意用 parseDateKey 而不是 new Date(key)——后者把 'YYYY-MM-DD' 当 UTC 解析，
 *  在东八区会整体偏成前一天，星期就全错位了。 */
function buildDays(today: string): string[] {
  const firstOfWindow = addDays(today, -(HEAT_WEEKS * 7 - 1))
  const startDow = parseDateKey(firstOfWindow)?.getDay() ?? 0
  const start = addDays(firstOfWindow, -startDow)

  const days: string[] = []
  for (let i = 0; i < HEAT_WEEKS * 7 + 7; i++) {
    const key = addDays(start, i)
    if (key > today) break
    days.push(key)
  }
  return days
}

export function Heatmap(): JSX.Element {
  const heat = useStore((s) => s.heat)
  const openDate = useStore((s) => s.openDate)
  const currentDate = useStore((s) => s.entry?.entryDate ?? null)
  const today = todayKey()
  const days = buildDays(today)
  const byDate = new Map(heat.map((d) => [d.date, d]))

  const scroller = useRef<HTMLDivElement>(null)
  // 键盘光标：整块日历只占一个 Tab 位，进了这块再用方向键走格子
  const [cursor, setCursor] = useState(days.length - 1)

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [])

  function onKeyDown(e: ReactKeyboardEvent): void {
    const delta =
      e.key === 'ArrowRight' ? 7 : e.key === 'ArrowLeft' ? -7 : e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (delta !== 0) {
      e.preventDefault()
      setCursor((c) => Math.min(days.length - 1, Math.max(0, c + delta)))
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const key = days[cursor]
      if (key) void openDate(key)
    }
  }

  return (
    <div>
      <div className="sec-label">
        日历
        <span style={{ fontFamily: 'var(--font-mono)' }}>{formatMonthDayZh(today)}</span>
      </div>
      <div
        className="heat"
        ref={scroller}
        style={{ overflowX: 'auto' }}
        tabIndex={0}
        role="grid"
        aria-label="记录日历，方向键选择，回车打开"
        onKeyDown={onKeyDown}
      >
        <div className="heat-grid">
          {days.map((key, i) => {
            const row = byDate.get(key)
            const count = row?.count ?? 0
            const chars = row?.charCount ?? 0
            return (
              <i
                key={key}
                data-l={heatLevel(chars) || undefined}
                className={[key === today ? 'today' : '', i === cursor ? 'cursor' : ''].join(' ')}
                style={
                  key === currentDate
                    ? { borderColor: 'var(--accent)', borderWidth: 1.5 }
                    : undefined
                }
                role="gridcell"
                aria-label={`${key} ${weekdayZh(key)}，${count} 篇，${chars} 字`}
                title={`${key} ${weekdayZh(key)} · ${count} 篇 · ${chars} 字`}
                onClick={() => void openDate(key)}
              />
            )
          })}
        </div>
      </div>
      <div className="heat-legend">
        少
        <i style={{ background: 'var(--hover)' }} />
        <i style={{ background: 'color-mix(in srgb, var(--accent) 22%, transparent)' }} />
        <i style={{ background: 'color-mix(in srgb, var(--accent) 44%, transparent)' }} />
        <i style={{ background: 'color-mix(in srgb, var(--accent) 70%, transparent)' }} />
        <i style={{ background: 'var(--accent)' }} />
        多
        <span style={{ marginLeft: 'auto' }}>按字数</span>
      </div>
    </div>
  )
}