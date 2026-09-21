/** 收藏 sheet（期-02-设计 §3.4）。标题栏那一格是入口，这里是被收藏的东西本身。
 *
 *  三条设计约束决定了这个组件的样子：
 *  - **分组按对象类型分**（条目 / 主题 / 标签），不是一张大列表：三者点下去做的事完全不同
 *    （打开一篇 / 切到主题视图 / 切到标签视图），混在一起每一行都得先读类型才知道会去哪。
 *  - 每行显示的是**收藏那一刻**的名字（`Bookmark.title`）。库里那一条后来改了名，这一行不改——
 *    那正是这枚收藏的意思：「我当时指着叫这个名字的东西说记住它」（§4.1）。
 *  - 指向的东西进回收站或整个没了，这一行**留着并标出来**，不会静悄悄消失。
 *    收藏的意义在用户那一次动作，不在被收藏对象的当前状态。 */

import type { JSX } from 'react'
import { useStore } from '@/store'
import { relativeTime } from '../../../shared/date'
import type { BookmarkKind } from '../../../shared/types'

/** 分组顺序就是这里的顺序：条目最常看，标签最少 */
const GROUPS: { kind: BookmarkKind; label: string }[] = [
  { kind: 'entry', label: '条目' },
  { kind: 'topic', label: '主题' },
  { kind: 'tag', label: '标签' },
]

export function Bookmarks(): JSX.Element | null {
  const open = useStore((s) => s.bookmarkOpen)
  const bookmarks = useStore((s) => s.bookmarks)
  const setOpen = useStore((s) => s.setBookmarkOpen)
  const go = useStore((s) => s.openBookmark)
  const toggle = useStore((s) => s.toggleBookmark)

  if (!open) return null

  return (
    <div className="sheet open" onClick={() => setOpen(false)}>
      <div
        className="sheet-card"
        role="dialog"
        aria-modal="true"
        aria-label="收藏"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h3>收藏</h3>
            <p>
              按 <kbd>Ctrl+D</kbd> 收藏或取消收藏正在写的这一篇
            </p>
          </div>
          <button className="close-x" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        {bookmarks.length === 0 && <div className="empty-hint">还没有收藏。</div>}

        {GROUPS.map((g) => {
          const rows = bookmarks.filter((b) => b.kind === g.kind)
          if (rows.length === 0) return null
          return (
            <div key={g.kind}>
              <div className="sec-label">
                {g.label}
                <span>{rows.length}</span>
              </div>
              <div className="bk-list">
                {rows.map((b) => (
                  <div key={b.id} className={`bk-row ${b.state === 'ok' ? '' : 'stale'}`}>
                    <button
                      className="bk-go"
                      onClick={() => void go(b)}
                      title={
                        b.state === 'ok'
                          ? `收藏于 ${relativeTime(b.createdAt)}`
                          : b.state === 'deleted'
                            ? '这一条在回收站里，先恢复才能打开'
                            : '指向的东西已经不在了'
                      }
                    >
                      <b>{b.title}</b>
                      <span className="bk-sub">{relativeTime(b.createdAt)}收藏</span>
                    </button>
                    {b.state !== 'ok' && (
                      <span className="badge draft">{b.state === 'deleted' ? '已删除' : '已失效'}</span>
                    )}
                    <button
                      className="chip"
                      onClick={() => void toggle(b.kind, b.ref, b.title)}
                      title="取消收藏（内容本身不动）"
                    >
                      取消收藏
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 当前这一篇收藏了没有。编辑器右上角那颗星与 `Ctrl+D` 的提示都问它——
 *  列表常驻 store，所以这一问不另开通道（几十行的量级，`some` 一次就够）。 */
export function useBookmarkedCurrent(): boolean {
  const currentId = useStore((s) => s.currentId)
  return useStore(
    (s) => currentId !== null && s.bookmarks.some((b) => b.kind === 'entry' && b.ref === currentId)
  )
}
