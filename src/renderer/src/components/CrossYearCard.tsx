/** 跨年同日关联：右栏那一行静默卡（期-06b-2 §二）。
 *
 *  「静默」是这块的全部难点：它是在提议连一条线，不是通知。所以
 *  - 只在共享标签或共享主题时出现（判据在 `shared/chronicle.ts`，§0.3 量出来的：
 *    三年库里 42% 的日子都有个"去年今天"，真共享标签的只有 29% —— 按前者弹就是噪声）
 *  - 一行一张，不弹层、不抢焦点、不动光标
 *  - `Esc` 或点 × 收掉之后**同一篇不再出现**；这个"收过"只活在组件里，
 *    不落盘也不进 store：跨会话记住"用户三年前那天不想被提醒"是过头的判断 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import type { CrossYearHit } from '../../../shared/types'

/** 卡上那行字的年份说法。1/2 年之外这一列本来就不会出现（只回看两年） */
const YEAR_WORD = ['', '去年今天', '前年今天']

export function CrossYearCard(): JSX.Element | null {
  const entry = useStore((s) => s.entry)
  const hits = useStore((s) => s.crossYear)
  const outgoing = useStore((s) => s.outgoing)
  const openEntry = useStore((s) => s.openEntry)
  const connect = useStore((s) => s.connectCrossYear)

  // 收掉的按「这一篇的 id」记，换文档就重置
  const [gone, setGone] = useState<{ id: number; keys: number[] }>({ id: 0, keys: [] })
  useEffect(() => setGone({ id: 0, keys: [] }), [entry?.id])

  if (!entry || entry.kind !== 'diary' || hits.length === 0) return null

  // 已经连着的不必再提议。`outgoing` 是这篇正文的出链落点，比在卡上再判一次字符串准
  const linked = new Set(outgoing.map((o) => o.nodeKey))
  const shown = hits.filter(
    (h) => !linked.has(`e:${h.entryId}`) && !gone.keys.includes(h.entryId)
  )
  if (shown.length === 0) return null

  return (
    <RailLines
      rows={shown}
      onOpen={(h) => void openEntry(h.entryId)}
      onConnect={(h) => void connect(h)}
      onHide={(h) => setGone((g) => ({ id: g.id, keys: [...g.keys, h.entryId] }))}
    />
  )
}

function RailLines({
  rows,
  onOpen,
  onConnect,
  onHide,
}: {
  rows: CrossYearHit[]
  onOpen: (h: CrossYearHit) => void
  onConnect: (h: CrossYearHit) => void
  onHide: (h: CrossYearHit) => void
}): JSX.Element {
  return (
    <div className="cy-lines">
      {rows.map((h) => (
        <div className="cy-line" key={h.entryId} data-entry={h.entryId} data-years={h.years}>
          <button className="cy-what" onClick={() => onOpen(h)} title="跳过去看那天写了什么">
            <b>{YEAR_WORD[h.years] ?? `${h.years} 年前今天`}</b>
            <span>{h.title ?? h.date}</span>
            <em>
              共享{' '}
              {h.why.kind === 'tag' ? `#${h.why.name}` : `主题「${h.why.name || '未归主题'}」`}
            </em>
          </button>
          {/* 连 = 在正文末尾补一行 `[[那年那条]]`，走正常保存与重解析。
              不直接写 Link 表：那是正文的派生物，绕开正文写进去的边下一次保存就没了 */}
          <button className="cy-do" onClick={() => onConnect(h)} title="连上：在正文末尾加一行双链">
            连
          </button>
          <button className="cy-x" onClick={() => onHide(h)} title="这一篇不再提" aria-label="不再提">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
