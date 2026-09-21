/** 主题管理（期-02-设计 §3.5）：一个 sheet 就够，不做页面。
 *
 *  一行一个主题：左边 ↑ ↓ 换位，中间是名字 + 文章数 + 图标 / 颜色 / 归档三个当场能改的字段，
 *  右边三枚动作（收藏 · 改名 · 删除）。
 *
 *  两个动作刻意不走「当场改」：
 *  - **改名** 会动全库正文（§8-D4），所以它不在这行里输入，走 `TopicRenameCard`
 *    那张先把干跑数字摊给人看的弹层。
 *  - **删除** 不可逆（主题没有回收站），所以它要按一次再说一次「确认」。
 *    主题下有文章时那一句话就是「清空 N 篇的归属并删」，这正是 §3.5 要的那条出路。
 *
 *  收藏那一枚是 §3.4 欠的入口：sheet 的分组里早就有「主题」那一组，但一直没有地方能把
 *  一个主题收进去。行本身是按钮，所以这枚星只能待在动作区里，不能嵌在跳转按钮里。 */

import type { JSX } from 'react'
import { useState } from 'react'
import type { Topic } from '../../../shared/types'
import { orderedTopics, topicColorVar, useStore } from '@/store'
import { IconRename, IconStar, IconTrash } from '@/components/Icons'

/** §5 那 8 个色板 token。主题与标签共用同一套，四个主题各自调过对比度 */
const SWATCHES = ['tag-1', 'tag-2', 'tag-3', 'tag-4', 'tag-5', 'tag-6', 'tag-7', 'tag-8']

export function TopicSheet(): JSX.Element | null {
  const open = useStore((s) => s.topicSheetOpen)
  const topics = useStore((s) => s.topics)
  const setOpen = useStore((s) => s.setTopicSheetOpen)
  const onMove = useStore((s) => s.moveTopic)

  if (!open) return null

  const rows = orderedTopics(topics)

  return (
    <div className="sheet open" onClick={() => setOpen(false)}>
      <div
        className="sheet-card topic-card"
        role="dialog"
        aria-modal="true"
        aria-label="主题管理"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h3>主题管理</h3>
            <p>改名会问到正文里的 [[双链]]；删除没有回收站，所以下面有文章时会先拦住</p>
          </div>
          <button className="close-x" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        {rows.length === 0 && <div className="empty-hint">还没有主题。在侧栏「主题」那一格点 + 建一个。</div>}

        <div className="tm-list">
          {rows.map((t) => <Row key={t.id} topic={t} rows={rows} onMove={onMove} />)}
        </div>
      </div>
    </div>
  )
}

function Row({
  topic: t,
  rows,
  onMove,
}: {
  topic: Topic
  rows: Topic[]
  onMove: (id: number, dir: -1 | 1) => Promise<void>
}): JSX.Element {
  const patch = useStore((s) => s.patchTopic)
  const remove = useStore((s) => s.removeTopic)
  const setRename = useStore((s) => s.setTopicRename)
  const select = useStore((s) => s.selectTopic)
  const toggleBookmark = useStore((s) => s.toggleBookmark)
  const bookmarked = useStore((s) => s.bookmarks.some((b) => b.kind === 'topic' && b.ref === t.id))

  const [icon, setIcon] = useState(t.icon ?? '')
  const [confirming, setConfirming] = useState(false)

  // 一层归档（§3.5）：候选只有「别的顶层主题」；自己带着子主题时谁都当不了父级
  const kids = rows.filter((c) => c.parentId === t.id)
  const candidates = kids.length > 0 ? [] : rows.filter((c) => c.id !== t.id && c.parentId === null)
  // ↑ ↓ 只在同一层里有效——子主题永远紧跟它的父主题，跨层换位在界面上看不出区别
  const sameLevel = rows.filter((c) => c.parentId === t.parentId)
  const at = sameLevel.findIndex((c) => c.id === t.id)
  const parentName = t.parentId === null ? null : rows.find((p) => p.id === t.parentId)?.name ?? null

  function commitIcon(): void {
    const next = icon.trim()
    if (next === (t.icon ?? '')) return
    void patch(t.id, { icon: next })
  }

  return (
    <div className={`tm-row ${t.parentId !== null ? 'child' : ''}`}>
      <div className="tm-main">
        <span className="tm-move">
          <button
            disabled={at <= 0}
            title="上移"
            onClick={() => void onMove(t.id, -1)}
          >
            ↑
          </button>
          <button
            disabled={at < 0 || at >= sameLevel.length - 1}
            title="下移"
            onClick={() => void onMove(t.id, 1)}
          >
            ↓
          </button>
        </span>

        <span className="dot" style={{ background: topicColorVar(t.color) }} />
        <button className="tm-name" title="在侧栏选中它" onClick={() => void select(t.id)}>
          {t.name}
        </button>
        {parentName && <span className="badge draft">归档于 {parentName}</span>}
        <span className="tm-cnt">{t.articleCount} 篇</span>

        <span className="tm-acts">
          <button
            className={`tag-act ${bookmarked ? 'on' : ''}`}
            title={bookmarked ? '取消收藏（主题本身不动）' : '收藏这个主题'}
            onClick={() => void toggleBookmark('topic', t.id, t.name)}
          >
            <IconStar filled={bookmarked} />
          </button>
          <button
            className="tag-act"
            title="改名"
            onClick={() => setRename({ id: t.id, from: t.name })}
          >
            <IconRename />
          </button>
          <button
            className="tag-act"
            title="删除主题"
            onClick={() => setConfirming((v) => !v)}
          >
            <IconTrash />
          </button>
        </span>
      </div>

      <div className="tm-fields">
        <label className="tm-field">
          <span>图标</span>
          <input
            className="tm-icon"
            value={icon}
            placeholder="📌"
            maxLength={8}
            onChange={(e) => setIcon(e.target.value)}
            onBlur={commitIcon}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        </label>

        <div className="tm-field">
          <span>颜色</span>
          <div className="tm-swatches">
            {SWATCHES.map((token) => (
              <button
                key={token}
                className={`tm-swatch ${t.color === token ? 'on' : ''}`}
                style={{ background: `var(--${token})` }}
                title={t.color === token ? `${token} · 再点一次取消` : token}
                onClick={() => void patch(t.id, { color: t.color === token ? null : token })}
              />
            ))}
          </div>
        </div>

        <label className="tm-field">
          <span>归档到</span>
          <select
            className="tm-parent"
            value={t.parentId ?? ''}
            disabled={candidates.length === 0}
            title={
              kids.length > 0
                ? '它下面已经挂着别的主题了，只支持一层，所以它自己不能再归到别处'
                : candidates.length === 0
                  ? '没有别的顶层主题可以当父级'
                  : undefined
            }
            onChange={(e) =>
              void patch(t.id, { parentId: e.target.value === '' ? null : Number(e.target.value) })
            }
          >
            <option value="">（顶层）</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {confirming && (
        <div className="tm-confirm">
          <span>
            {t.articleCount > 0
              ? `删掉「${t.name}」？它下面 ${t.articleCount} 篇文章不会跟着没，只是不再归属任何主题。`
              : `删掉「${t.name}」？主题没有回收站。`}
          </span>
          <div className="card-actions">
            <button className="chip" onClick={() => setConfirming(false)}>
              取消
            </button>
            <button
              className="chip danger"
              onClick={() => {
                setConfirming(false)
                void remove(t.id, t.articleCount > 0)
              }}
            >
              {t.articleCount > 0 ? '清空归属并删除' : '删除'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
