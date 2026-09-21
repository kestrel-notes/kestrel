/** 升格（日记 → 文章）的确认弹层。两次点击里的第二次（设计文档 §3.4）。
 *
 *  只收两样东西：标题、主题。**正文一个字都不动**，所以这里不出现正文预览——
 *  放个预览反而会让人以为"升格"是复制一份。 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { focusEditor } from '@/dom'

export function PromoteCard(): JSX.Element | null {
  const open = useStore((s) => s.promoteOpen)
  const entry = useStore((s) => s.entry)
  const topics = useStore((s) => s.topics)
  const setOpen = useStore((s) => s.setPromoteOpen)
  const promote = useStore((s) => s.promoteCurrent)

  const [title, setTitle] = useState('')
  const [topicId, setTopicId] = useState<number | null>(null)

  // 每次打开都按「当前这一篇」重新起头。依赖只写 open：跟着 topics 变的话，
  // 用户正在敲标题时后台刷了一次主题列表，输入就会被冲掉
  useEffect(() => {
    if (!open) return
    const s = useStore.getState()
    setTitle(s.entry?.entryDate ?? '')
    setTopicId(s.entry?.topicId ?? s.activeTopicId ?? s.topics[0]?.id ?? null)
    return focusEditor
  }, [open])

  if (!open || !entry) return null

  const ready = title.trim() !== '' && topicId !== null

  return (
    <div className="sheet open" onClick={() => setOpen(false)}>
      <div
        className="sheet-card promote-card"
        role="dialog"
        aria-modal="true"
        aria-label="升格为文章"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h3>升格为文章</h3>
            <p>原文一个字都不会动，只是换归属</p>
          </div>
          <button className="close-x" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        <label className="field">
          <span>标题</span>
          <input
            autoFocus
            value={title}
            placeholder="给这篇文章起个名字"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="field">
          <span>主题</span>
          <select
            value={topicId ?? ''}
            onChange={(e) => setTopicId(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">选择主题…</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        {topics.length === 0 && <div className="empty-hint">先在侧栏「主题」那里建一个。</div>}

        <div className="card-actions">
          <button className="chip" onClick={() => setOpen(false)}>
            取消
          </button>
          <button
            className="chip primary"
            disabled={!ready}
            onClick={() => void promote({ title: title.trim(), topicId: topicId as number })}
          >
            升格
          </button>
        </div>
      </div>
    </div>
  )
}