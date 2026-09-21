import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { EditorView } from '@codemirror/view'
import { countChars, formatDateZh, relativeTime } from '../../../shared/date'
import { useStore, entryLabel } from '@/store'
import { outlineLines } from '@/outline'
import { getCmView } from '@/editor/cmView'
import { RichEditor } from '@/editor/RichEditor'
import { SourceEditor } from '@/editor/SourceEditor'
import { useBookmarkedCurrent } from '@/components/Bookmarks'
import { IconCode, IconPromote, IconStar, IconTrash } from '@/components/Icons'

/** 第 n 个标题现在在屏幕上的 y（相对视口）。竖向位置在两种模式下取法不同：
 *
 *  - 所见即所得：ProseMirror **不虚拟化**，整篇都在 DOM 里，照 `.md-prose h1..h3` 量。
 *  - 源码模式：CM6 **是虚拟化的**，DOM 里只有视口附近那几十行，照 `.cm-line` 数会数错、
 *    远处的标题根本不存在。所以走 CM 自己的度量：文档坐标 → 视口坐标靠 `documentTop`。
 *
 *  两边的**序号规则是同一个**（outline.ts 的 outlineLines），否则点击会滚到别的标题。 */
function headingYs(box: HTMLElement | null, rich: boolean, content: string): number[] {
  if (!box) return []
  if (rich) {
    return [...box.querySelectorAll<HTMLElement>('.md-prose h1, .md-prose h2, .md-prose h3')].map(
      (el) => el.getBoundingClientRect().top
    )
  }
  const v = getCmView()
  if (!v) return []
  const doc = v.state.doc
  return outlineLines(content)
    .filter((h) => h.line + 1 <= doc.lines)
    .map((h) => v.documentTop + v.lineBlockAt(doc.line(h.line + 1).from).top)
}

/** 滚到第 n 个标题。**不动光标位置**：改选区会打断正在打字的人（设计文档 §3.5）
 *
 *  源码模式交给 CM 自己滚，别换成「量一下再写 scrollTop」：CM6 只渲染视口附近那几十行，
 *  滚动会让它往上下补占位高度，文档总高跟着变，一次性的位移必然算不准——实测差 46px，
 *  结果标题停在容器底下 46px，高亮就落到上一节去了。CM 的 scrollIntoView 会在随后的
 *  测量帧里自己校正。（代价：窗口不在前台时那一帧不来，点了像没反应——验证时先把窗口调出来。） */
function scrollToHeading(box: HTMLElement | null, rich: boolean, content: string, index: number): void {
  if (rich) {
    box
      ?.querySelectorAll<HTMLElement>('.md-prose h1, .md-prose h2, .md-prose h3')
      [index]?.scrollIntoView({ block: 'start' })
    return
  }
  const v = getCmView()
  const h = outlineLines(content)[index]
  if (!v || !h || h.line + 1 > v.state.doc.lines) return
  v.dispatch({
    effects: EditorView.scrollIntoView(v.state.doc.line(h.line + 1).from, { y: 'start' }),
  })
}

export function Editor(): JSX.Element {
  const entry = useStore((s) => s.entry)
  const title = useStore((s) => s.title)
  const content = useStore((s) => s.content)
  const setTitle = useStore((s) => s.setTitle)
  const removeCurrent = useStore((s) => s.removeCurrent)
  const saveState = useStore((s) => s.saveState)
  const savedAt = useStore((s) => s.savedAt)
  const saveError = useStore((s) => s.saveError)
  const topics = useStore((s) => s.topics)
  const activeTopicId = useStore((s) => s.activeTopicId)
  const editorMode = useStore((s) => s.editorMode)
  const switchEditorMode = useStore((s) => s.switchEditorMode)
  const gateNote = useStore((s) => s.gateNote)
  const gateBlocked = useStore((s) => s.gateBlocked)
  const focus = useStore((s) => s.focus)
  const toggleFocus = useStore((s) => s.toggleFocus)
  const setPromoteOpen = useStore((s) => s.setPromoteOpen)
  const promotedOnDate = useStore((s) => s.promotedOnDate)
  const openEntry = useStore((s) => s.openEntry)
  const openDate = useStore((s) => s.openDate)
  const headingJump = useStore((s) => s.headingJump)
  const bookmarked = useBookmarkedCurrent()
  const toggleBookmark = useStore((s) => s.toggleBookmark)

  const scrollRef = useRef<HTMLDivElement>(null)
  const rich = editorMode === 'rich'

  // 大纲点击 → 滚过去
  useEffect(() => {
    if (!headingJump) return
    scrollToHeading(scrollRef.current, rich, useStore.getState().content, headingJump.index)
  }, [headingJump, rich])

  // 滚动时回报「当前所在的标题」，右栏据此高亮
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return

    const onScroll = (): void => {
      const nodes = headingYs(box, rich, useStore.getState().content)
      if (nodes.length === 0) {
        useStore.getState().setActiveHeading(null)
        return
      }
      const top = box.getBoundingClientRect().top
      // 已经滚到底：最后一节再短也是「正在看它」。不特殊处理的话，短尾节永远高亮在上一节——
      // scrollTop 被夹在 max 上，那一节的标题根本到不了容器顶部
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 8) {
        useStore.getState().setActiveHeading(nodes.length - 1)
        return
      }
      let active = 0
      for (let i = 0; i < nodes.length; i++) {
        // 越过容器顶部才算「到了这一节」。留 8px 容差，免得贴边时来回跳
        if (nodes[i] - top <= 8) active = i
      }
      useStore.getState().setActiveHeading(active)
    }

    onScroll()

    // 挂载或换模式后的第一次量往往是废的：CM6 与 Tiptap 都到下一帧才排完版，
    // 那时 rect 全是 0，每个标题都"在容器上方"，算出来是最后一个。
    // 而且滚动位置没变就不会再来 scroll 事件，错了就一直错到用户滚一下为止。
    let raf = 0
    const remeasure = (): void => {
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(onScroll)
      })
    }
    remeasure()

    box.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      box.removeEventListener('scroll', onScroll)
    }
  }, [rich, entry?.id, content])

  if (!entry) {
    return (
      <main className="editor-wrap">
        <div className="editor-bar">
          <div className="crumb">主题</div>
        </div>
        <div className="editor-scroll">
          <div className="doc">
            <div className="empty-hint" style={{ padding: '40px 0', fontSize: 13 }}>
              {activeTopicId === null
                ? '还没有主题。点侧栏「主题」右边的 + 建一个，文章就归到主题下。'
                : '这个主题下还没有打开的文章。点侧栏「文章」右边的 + 新建一篇。'}
              <br />
              日记那边随时可以写——切回「今天」就行。
            </div>
          </div>
        </div>
      </main>
    )
  }

  const isDiary = entry.kind === 'diary'
  const topic = topics.find((t) => t.id === entry.topicId)
  const chars = countChars(content)

  return (
    <main className="editor-wrap">
      <div className="editor-bar">
        <div className="crumb">
          {isDiary ? '今天' : '主题'}
          <span style={{ opacity: 0.5 }}>/</span>
          <b>{isDiary ? formatDateZh(entry.entryDate) : (title || '未命名文章')}</b>
        </div>
        <div className="editor-actions">
          {isDiary && (
            <button
              className="chip"
              onClick={() => setPromoteOpen(true)}
              title="原文一个字都不动，只是换归属到一个主题"
            >
              <IconPromote />
              升格为文章
            </button>
          )}
          <button
            className="chip"
            onClick={() => void switchEditorMode(editorMode === 'rich' ? 'source' : 'rich')}
            title="Ctrl+Shift+M"
          >
            <IconCode />
            {editorMode === 'rich' ? '源码模式' : '所见即所得'}
          </button>
          {/* 设计与 §10 第 11 项只点了 Ctrl+D 这一个入口，但那样鼠标用户根本收藏不了东西，
              所以这里留一枚看得见的星。判据与快捷键是同一份 store，不会漂出第二套状态 */}
          <button
            className={`chip ${bookmarked ? 'on' : ''}`}
            onClick={() => void toggleBookmark('entry', entry.id, entryLabel(entry))}
            title="Ctrl+D"
          >
            <IconStar filled={bookmarked} />
            {bookmarked ? '已收藏' : '收藏'}
          </button>
          <button className="chip" onClick={() => void removeCurrent()} title="软删除，进回收站">
            <IconTrash />
            删除
          </button>
        </div>
      </div>

      <div className="editor-scroll" ref={scrollRef}>
        <div className="doc">
          {isDiary ? (
            <h1 className="doc-title">{formatDateZh(entry.entryDate)}</h1>
          ) : (
            <input
              className="doc-title"
              value={title}
              placeholder="给这篇文章起个名字"
              onChange={(e) => setTitle(e.target.value)}
            />
          )}

          {isDiary && promotedOnDate.length > 0 && (
            <div className="banner">
              <span>
                {promotedOnDate.length === 1
                  ? `这一天的记录已升格为《${promotedOnDate[0].title}》`
                  : `这一天升格出了 ${promotedOnDate.length} 篇文章`}
              </span>
              {promotedOnDate.map((p) => (
                <button
                  key={p.id}
                  className="banner-go"
                  title={`打开《${p.title}》`}
                  onClick={() => void openEntry(p.id)}
                >
                  {promotedOnDate.length === 1 ? '→' : (p.title ?? '未命名文章')}
                </button>
              ))}
            </div>
          )}

          {/* 升格不改 entry_date，所以文章页的 entryDate 就是来源那天的日记 */}
          {!isDiary && entry.promotedAt && (
            <div className="banner">
              <span>源自 {formatDateZh(entry.entryDate)} 的日记</span>
              <button
                className="banner-go"
                title={`打开 ${formatDateZh(entry.entryDate)} 的日记`}
                onClick={() => void openDate(entry.entryDate)}
              >
                →
              </button>
            </div>
          )}

          <div className="meta-row">
            {isDiary ? (
              <span className="pill">日记</span>
            ) : (
              <span className="pill">{topic?.name ?? '未归主题'}</span>
            )}
            {!isDiary && <span className="pill">{entry.status === 'draft' ? '草稿' : '已发布'}</span>}
            <span className="pill">创建于 {entry.entryDate}</span>
          </div>

          {rich ? <RichEditor key={entry.id} /> : <SourceEditor key={entry.id} />}
        </div>
      </div>

      <div className="statusbar">
        <span className={`live ${saveState === 'saved' && !saveError ? '' : 'idle'}`} />
        {saveState === 'saving' && <span>保存中…</span>}
        {saveState === 'saved' && !saveError && <span>已保存 · {relativeTime(savedAt ?? entry.updatedAt)}</span>}
        {saveError && (
          <span className="err" title={saveError}>
            保存失败：{saveError}
          </span>
        )}
        <span className="sep">|</span>
        <span>{chars} 字</span>
        {gateNote && (
          <>
            <span className="sep">|</span>
            <span className={gateBlocked ? 'gate blocked' : 'gate'} title={gateNote}>
              {gateNote}
            </span>
          </>
        )}
        {/* 这两项可点：状态栏是"当前在哪"的显示，顺手能切换才不白占位置 */}
        <span className="sep">|</span>
        <button
          className="sb-btn"
          title="切换编辑器模式（Ctrl+Shift+M）"
          onClick={() => void switchEditorMode(rich ? 'source' : 'rich')}
        >
          {rich ? '所见即所得' : '源码'}
        </button>
        {focus && (
          <button className="sb-btn" title="退出专注模式" onClick={toggleFocus}>
            专注
          </button>
        )}
      </div>
    </main>
  )
}
