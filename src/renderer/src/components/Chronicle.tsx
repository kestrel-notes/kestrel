/** 主题编年史（期-06b-2 §一）。
 *
 *  一条主题的时间线摊在右栏：散落的日记是原料，文章是成品，两样按时间串成一条生产线。
 *  这就是 §5.3 那条"主题编年史"的落点——用户挑的是右栏这一块，不是多一个全屏页。
 *
 *  为什么升格那批只占一行：升格是**原地改 kind**（`main/db/entries.ts` 的 `promote`，
 *  「原文一字不动」），库里没有第二行。所以这一行自己带着两个时间点（原料日与成文时刻），
 *  不必像 §5.4 那样画一条"日记 → 文章"的边——那条边在这个模型里根本不存在。 */

import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/store'
import { RailBlock } from '@/components/RailBlock'
import type { ChronicleRow } from '../../../shared/types'

/** 摊在台面上的行数。超过它折起来，给一个「展开完整时间线」——
 *  右栏还有五块别的东西要地方，一条长编年史不该把「当日信息」顶出可视区。
 *  折的是**早的那头**：留在台面上的永远是这条线最近的一段。 */
const FOLD_AT = 8
/** 展开之后这块的内高度上限。再长就在这块里滚 */
const MAX_H = 300

/** 相隔多少天。两端都是 'YYYY-MM-DD'，按 UTC 零点数着算——
 *  本地时区会让夏令时那两天差一小时，`Math.round` 之后就差一天。 */
function gapDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

export function Chronicle(): JSX.Element | null {
  const entry = useStore((s) => s.entry)
  const topicId = entry?.topicId ?? null
  const topic = useStore((s) => s.topics.find((t) => t.id === s.entry?.topicId))
  const savedAt = useStore((s) => s.savedAt)
  const openEntry = useStore((s) => s.openEntry)

  const [rows, setRows] = useState<ChronicleRow[]>([])
  const [expanded, setExpanded] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // 换主题、换这一篇、或刚存过一笔（标题与归属都可能变）都要重取。
  // 一次带 `idx_entry_topic` 的查询，值不起缓存那笔钱。
  useEffect(() => {
    if (topicId === null) {
      setRows([])
      return
    }
    let live = true
    setExpanded(false)
    void window.kestrel.entries
      .chronicle(topicId)
      .then((r) => live && setRows(r))
      .catch(() => live && setRows([]))
    return () => {
      live = false
    }
  }, [topicId, entry?.id, savedAt])

  // 编年史读的是"这条线现在到哪了"，所以收起时给最近那一段、展开后停在末尾
  useEffect(() => {
    const box = boxRef.current
    if (box && expanded) box.scrollTop = box.scrollHeight
  }, [expanded, rows.length])

  if (topicId === null || !topic || rows.length === 0) return null

  const written = rows.reduce((n, r) => n + (r.promotedAt !== null ? 1 : 0), 0)
  const shown = expanded ? rows : rows.slice(-FOLD_AT)
  const hidden = rows.length - shown.length
  const span = gapDays(rows[0].sortAt.slice(0, 10), rows[rows.length - 1].sortAt.slice(0, 10))

  return (
    <RailBlock title="编年史" count={rows.length}>
      <div className="ch-sub">
        <em className="net-cur">{topic.name}</em>
        <span>
          {written} 段成文{rows.length > 1 ? ` · 这条线跨了 ${span} 天` : ''}
        </span>
      </div>
      {hidden > 0 && (
        <button className="ch-more" onClick={() => setExpanded(true)}>
          展开完整时间线 · 更早 {hidden} 条
        </button>
      )}
      <div className="ch-list" ref={boxRef} style={expanded ? { maxHeight: MAX_H } : undefined}>
        {shown.map((r) => (
          <ChronicleLine
            key={r.id}
            row={r}
            current={r.id === entry?.id}
            onOpen={() => void openEntry(r.id)}
          />
        ))}
      </div>
      {expanded && rows.length > FOLD_AT && (
        <button className="ch-more" onClick={() => setExpanded(false)}>
          收起
        </button>
      )}
    </RailBlock>
  )
}

/** 一行 = 一个条目。升格来的那行把两个日期都画出来，中间那截写"隔了多少天"——
 *  这一列要说的就是"沉淀了多久"，那个数得直接读到，不该让用户自己去减。
 *
 *  日记那行**不写标题**：它的标题就是那个日期，日期已经在左边了，
 *  再来一份就是「2026-08-25 日记 日记」这种重复（第一版实机截图上抓到的）。 */
function ChronicleLine({
  row,
  current,
  onOpen,
}: {
  row: ChronicleRow
  current: boolean
  onOpen: () => void
}): JSX.Element {
  const made = row.promotedAt?.slice(0, 10) ?? ''
  const gap = made ? gapDays(row.entryDate, made) : 0
  const title = row.kind === 'diary' ? null : (row.title ?? '未命名')
  const tag = made ? '成文' : row.kind === 'diary' ? '日记' : '文章'

  return (
    <button
      className={`ch-line ${made ? 'is-written' : ''} ${current ? 'on' : ''}`}
      data-entry={row.id}
      onClick={onOpen}
      title={
        made
          ? `${row.entryDate} 记下 · 隔 ${gap} 天成文`
          : `${row.entryDate} · ${title ?? '日记（标题就是这一天）'}`
      }
    >
      <span className="ch-when mono">{made ? `${row.entryDate} → ${made}` : row.entryDate}</span>
      <span className="ch-what">
        <i className={`ch-tag ${made ? '' : 'dim'}`}>{tag}</i>
        {title && <span className="ch-title">{title}</span>}
      </span>
    </button>
  )
}
