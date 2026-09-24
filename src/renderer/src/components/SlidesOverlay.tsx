/** 幻灯片演示层（期-09c）。当前这一篇按分页符切开，一屏一页地放。
 *
 *  三条承重的东西：
 *  · **页不落任何东西**：`slideSplit(content)` 是纯函数，读的是库里那一串文本，
 *    所以三档模式（所见即所得 / 源码 / 阅读）走的是同一条切分（设计稿 §一）。
 *  · **每页一棵只读的编辑器实例**：不做「整篇一棵 + CSS 裁到当前页」——那要先量出每个
 *    `<hr>` 的屏幕偏移，一 resize、一折叠就全错（决策 52）。代价是每次翻页付一次解析，
 *    实机量过记在设计稿 §八·结果。
 *  · **键位只在这层里生效**：`Space` 与方向键那一批一旦登记进全局命令表，就会吃掉编辑器
 *    与列表的同名键。所以整层 `stopPropagation`，连 `Ctrl+W` 也不许在演示底下动标签（§三）。
 */

import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { slideSplit } from '../../../shared/slides'
import { useStore, entryLabel } from '@/store'
import { buildExtensions, resolveLink, type LinkBridge } from '@/editor/markdown'
import { Folding } from '@/editor/folding'
import { FootnoteNumbers } from '@/editor/footnote'
import { Attachments } from '@/editor/assets'
import { QueryBlocks } from '@/editor/queryBlock'

/** 一页一棵、只建一次：换页时整个组件按 `key` 重建，所以 `md` 在它活着期间不会变 */
function SlideBody({ md, entryDate }: { md: string; entryDate: string }): JSX.Element {
  const bridge = useMemo<LinkBridge>(
    () => ({
      resolve: (raw) => resolveLink(useStore.getState().outgoing, raw, entryDate),
      open: (nodeKey, label) => {
        const s = useStore.getState()
        // 演示中途点了一个链接就是「我要去看那一头」：先收层再跳。
        // 留层在跳转之后的话，屏幕上还是旧的那一篇，比跳不过去更让人迷糊
        s.closeSlides()
        if (nodeKey) void s.openNode(nodeKey)
        else s.notify(`「${label}」还没有创建`)
      },
      subscribe: (cb) => useStore.subscribe(cb),
      openTag: (name) => {
        const s = useStore.getState()
        s.closeSlides()
        void s.selectTagName(name)
      },
    }),
    [entryDate]
  )
  const extensions = useMemo(
    () => [...buildExtensions(bridge), Folding, FootnoteNumbers, Attachments, QueryBlocks],
    [bridge]
  )

  const editor = useEditor(
    {
      extensions,
      content: md,
      contentType: 'markdown',
      editable: false,
      editorProps: {
        attributes: { class: 'md-prose md-reading', spellcheck: 'false' },
      },
    },
    []
  )

  return <EditorContent editor={editor} />
}

export function SlidesOverlay(): JSX.Element | null {
  const open = useStore((s) => s.slidesOpen)
  const content = useStore((s) => s.content)
  const entry = useStore((s) => s.entry)
  const title = useStore((s) => s.title)
  const closeSlides = useStore((s) => s.closeSlides)

  const pages = useMemo(() => slideSplit(content), [content])
  const [page, setPage] = useState(0)
  const 末 = pages.length - 1

  const step = (d: number): void => setPage((p) => Math.min(Math.max(p + d, 0), 末))

  /** 重开这一层、或者演示中途换了文档都回到第一页。
   *  不拿 `pages` 当依赖：正文一个字没改时它也是新数组，那样每敲一键就跳回第一页 */
  const 回到首页 = (): void => setPage(0)
  useEffect(() => {
    if (open) 回到首页()
  }, [open, entry?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const boxRef = useRef<HTMLDivElement>(null)

  // 焦点拿进来，键才进得了这一层（与 GraphOverlay 同一条路子）
  useEffect(() => {
    if (open) boxRef.current?.focus()
  }, [open])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (open) {
      switch (e.code) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'Space':
        case 'PageDown':
          e.preventDefault()
          step(1)
          break
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'Backspace':
        case 'PageUp':
          e.preventDefault()
          step(-1)
          break
        case 'Home':
          e.preventDefault()
          setPage(0)
          break
        case 'End':
          e.preventDefault()
          setPage(末)
          break
        case 'Escape':
          e.preventDefault()
          closeSlides()
          break
      }
      // 走到这里不论处理没处理都要拦下：这层开着的时候 `Ctrl+W` `Ctrl+Tab` `Ctrl+,`
      // 那一条都不许落到 App.tsx 的全局派发上去（验收第 6 项）
      e.stopPropagation()
    }
  }

  /** 点屏幕左/右半边等于上一页/下一页。点在链接上不翻——那一击已经有自己的意思了 */
  const onClick = (e: React.MouseEvent): void => {
    if ((e.target as Element).closest('a')) return
    if (e.clientX < window.innerWidth / 2) step(-1)
    else step(1)
  }

  if (!open) return null

  const 名 = entry ? entryLabel({ ...entry, title }) : ''

  return (
    <div
      ref={boxRef}
      className="slides-overlay open glass-strong"
      role="dialog"
      aria-modal="true"
      aria-label="幻灯片演示"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="sl-head">
        <span className="sl-title">{名}</span>
        <button type="button" className="sl-close" onClick={closeSlides} aria-label="退出演示">
          退出演示
        </button>
      </header>

      <div className="sl-body" onClick={onClick}>
        <div className="doc">
          <SlideBody key={page} md={pages[page] ?? ''} entryDate={entry?.entryDate ?? ''} />
        </div>
      </div>

      <footer className="sl-foot">
        <span className="sl-count">
          {page + 1} / {pages.length}
        </span>
        {pages.length === 1 ? (
          <span className="sl-hint">
            这一篇没有分页符：在两个段落之间独占一行写 <code>---</code> 就能分页
          </span>
        ) : (
          <span className="sl-hint">
            <code>→</code> <code>↓</code> <code>Space</code> 下一页 · <code>←</code>{' '}
            <code>↑</code> <code>Backspace</code> 上一页 · <code>Home</code> <code>End</code> 首尾 ·
            点屏幕左/右半边也能翻 · <code>Esc</code> 退出
          </span>
        )}
      </footer>
    </div>
  )
}
