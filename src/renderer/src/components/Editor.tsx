import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { TextSelection } from '@tiptap/pm/state'
import { countChars, formatDateZh, relativeTime } from '../../../shared/date'
import { useStore, entryLabel, type SearchJump } from '@/store'
import { outlineLines } from '@/outline'
import { getCmView } from '@/editor/cmView'
import { getRichView } from '@/editor/richView'
import { RichEditor } from '@/editor/RichEditor'
import { SourceEditor } from '@/editor/SourceEditor'
import { TabBar } from '@/components/TabBar'
import { useBookmarkedCurrent } from '@/components/Bookmarks'
import { IconCode, IconPromote, IconStar, IconTrash } from '@/components/Icons'

/** 期-09a 之后一屏底下挂着好几棵编辑器（每个标签一棵），所以**量 DOM 的那几处必须先挑出
 *  看得见那一格**：`display:none` 的那些照样能被 `querySelectorAll` 捞到，
 *  而它们的 `getBoundingClientRect()` 全是 0——大纲高亮会直接量歪。 */
function 看得见那一格(box: HTMLElement | null): HTMLElement | null {
  if (!box) return null
  return box.querySelector<HTMLElement>('.tab-pane[data-active="1"]') ?? box
}

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
    const 那格 = 看得见那一格(box)
    if (!那格) return []
    return [...那格.querySelectorAll<HTMLElement>('.md-prose h1, .md-prose h2, .md-prose h3')].map(
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
    看得见那一格(box)
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

/** 搜索结果的命中定位（§4.4）。返回 false = 这一拍没动着任何东西，调用方可以换一帧再试。
 *
 *  两条路各用各的坐标，因为两边拿到的根本不是同一个东西：
 *   - 源码模式：`pos` 是 Markdown 原文里的下标，而 CM 的文档**就是**那份原文，直接用。
 *   - 所见即所得：`pos` 对不上——渲染出来的 DOM 里没有 `#`、`**` 这些语法字符，
 *     偏移天然错开。所以这一边只认命中词，在摊平的文本节点里找它出现的位置。
 *     同一个词在别处先出现过也会滚到那儿：那也是同一个词，不是别的词。
 *
 *  两种情况都允许失败，失败就只是不滚（设计稿那句「定位失败不影响打开」）。 */
function locateHit(jump: SearchJump, rich: boolean, box: HTMLElement | null): boolean {
  return rich ? locateInProse(box, jump.needle) : locateInCm(jump.pos, jump.needle)
}

function locateInCm(pos: number | null, needle: string | null): boolean {
  const v = getCmView()
  if (!v || pos === null || !needle) return false
  // `pos` 是主进程在**库里那一份正文**上量出来的下标。写路径上任何一次规范化
  // （markdown 转义、行尾处理）都会让它和 CM 文档错开一位——错一位就选到邻字上。
  // 所以先拿 needle 自证：对不上就照字符串再找一次，两边都找不到才放弃
  const len = needle.length
  const lower = needle.toLowerCase()
  const direct = v.state.doc.slice(pos, pos + len).toString().toLowerCase()
  const at = direct === lower ? pos : indexOfCm(v, lower)
  if (at < 0) return false
  v.dispatch({
    selection: { anchor: at, head: Math.min(at + len, v.state.doc.length) },
    effects: EditorView.scrollIntoView(at, { y: 'start' }),
  })
  // 面板关掉时输入框从 DOM 里消失了，不主动把焦点要回来的话光标会掉在地上
  v.focus()
  return true
}

/** 在 CM 文档里按字符串找命中词（`pos` 对不上时的兜底）。文档是几 KB 量级，逐行找够用。
 *  两边都 downcase 再比：ASCII 的大小写折叠不变长，下标仍然对得上 */
function indexOfCm(v: EditorView, lowerNeedle: string): number {
  const doc = v.state.doc
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const at = line.text.toLowerCase().indexOf(lowerNeedle)
    if (at >= 0) return line.from + at
  }
  return -1
}

function locateInProse(box: HTMLElement | null, needle: string | null): boolean {
  // 只认看得见那一格：隐藏的那几棵里也可能有同一个词，先量到谁全凭 DOM 顺序
  const prose = 看得见那一格(box)?.querySelector<HTMLElement>('.md-prose')
  if (!prose || !needle) return false

  const nodes: Text[] = []
  let flat = ''
  const walk = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n as Text
    if (!t.data) continue
    nodes.push(t)
    flat += t.data
  }
  const at = flat.indexOf(needle)
  if (at < 0) return false

  const range = document.createRange()
  const tail = at + needle.length
  let started = false
  let ended = false
  let cur = 0
  for (const t of nodes) {
    const end = cur + t.data.length
    if (!started && at >= cur && at < end) {
      range.setStart(t, at - cur)
      started = true
    }
    if (started && !ended && tail > cur && tail <= end) {
      range.setEnd(t, tail - cur)
      ended = true
      break
    }
    cur = end
  }
  if (!started || !ended) return false

  const view = getRichView()
  if (!view) return false
  // 换成 PM 的文档坐标再派发。直接写 window.getSelection() 的话 PM 会把自己那份
  // selection 同步回来，选区塌成一个点——看着就是"没选中"（实机验收抓到的）
  const from = view.posAtDOM(range.startContainer, range.startOffset)
  const to = view.posAtDOM(range.endContainer, range.endOffset)
  if (from < 0 || to < 0 || from === to) return false
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)).scrollIntoView()
  view.dispatch(tr)
  // 面板关掉时输入框从 DOM 里消失了，不主动把焦点要回来的话下一次打字打到空处
  view.focus()
  return true
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
  const searchJump = useStore((s) => s.searchJump)
  const bookmarked = useBookmarkedCurrent()
  const toggleBookmark = useStore((s) => s.toggleBookmark)

  const scrollRef = useRef<HTMLDivElement>(null)
  // `rich` 在这里的语义是「挂着 ProseMirror 的那两档」（rich 或 reading），不是特指 rich
  const rich = editorMode === 'rich' || editorMode === 'reading'

  const tabs = useStore((s) => s.tabs)
  const live = useStore((s) => s.live)
  const activeTab = useStore((s) => s.activeTab)
  /** 此刻真该挂着实例的那几篇：`live` 里可能还留着刚从标签上摘掉的那一篇 */
  const 挂着的 = useMemo(() => {
    const 有 = new Set(tabs.map((t) => t.entryId))
    return live.filter((id) => 有.has(id))
  }, [live, tabs])

  // 切标签 / 换档 / 换篇之后，把这一格该在的滚动位置放回去。
  // 为什么需要专门做这一件事：§〇 M2 量到滚动容器是同一个 DOM 节点，切过去那一帧
  // 量到的还是**上一篇**的 scrollTop（露 164335 那种），下一帧才归位。
  //
  // 用 layout effect 而不是 passive：归位必须赶在浏览器派发那一发 scroll 事件之前做完，
  // 否则下面 `onScroll` 里那一记会把「被 `display:none` 夹出来的中间值」当成这一格的位置存进去。
  const 归位中 = useRef(false)
  const 要回的滚动 = `${entry?.id ?? '-'}:${activeTab}:${editorMode}`
  useLayoutEffect(() => {
    const box = scrollRef.current
    const s = useStore.getState()
    const 格 = s.tabs[s.activeTab]
    // 源码模式底下 `.panes` 整块不显示，容器没有位置可言（那一格存的还是富文本那一档的）
    if (!box || !格 || !rich) return
    归位中.current = true
    box.scrollTop = 格.scroll
    // 第一次挂出来的那一棵要到下一帧才量得准高度（与大纲跳转同一类），补一次就收手。
    // 松闸刻意放在补那一发之后：这两帧里的 scroll 事件都是归位自己引起的，记下来是白记
    let 第二帧 = 0
    const 第一帧 = requestAnimationFrame(() => {
      if (Math.abs(box.scrollTop - 格.scroll) > 1) box.scrollTop = 格.scroll
      第二帧 = requestAnimationFrame(() => {
        归位中.current = false
      })
    })
    return () => {
      cancelAnimationFrame(第一帧)
      cancelAnimationFrame(第二帧)
      归位中.current = false
    }
    // 依赖刻意用那一串键而不是 `格.scroll`：回报滚动位置的那一步会改 tabs，
    // 把它列进来就成了「记完就跳回去」的自激
  }, [要回的滚动, rich])

  // 期-04 §4.10：选区字数。走原生 selectionchange——Tiptap 与 CodeMirror 都会把
  // 各自的选区反映到 DOM 的 selection 上，`toString()` 拿到的就是选中的字；
  // 不需要在两个编辑器里各装一份回调。0 = 光标（不算选中），也不显示。
  const [selChars, setSelChars] = useState(0)
  useEffect(() => {
    const onSel = (): void => {
      const s = window.getSelection()
      const text = s ? s.toString() : ''
      setSelChars(text ? countChars(text) : 0)
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

  // 大纲点击 → 滚过去
  useEffect(() => {
    if (!headingJump) return
    scrollToHeading(scrollRef.current, rich, useStore.getState().content, headingJump.index)
  }, [headingJump, rich])

  // 搜索命中 → 滚过去并选中那一串字（§4.4）
  useEffect(() => {
    if (!searchJump) return
    const s = useStore.getState()
    // 换文档与定位请求是两次 set：这一拍可能还没切过来，也可能已经切到别的一篇了。
    // 认 entryId 而不是认「最新一次请求」，才不会把上一篇文章的坐标打到当前这篇上
    if (s.entry?.id !== searchJump.entryId) return
    if (locateHit(searchJump, rich, scrollRef.current)) return
    // 试不动多半是刚换完模式、编辑器还没排版完（与大纲跳转同一类：CM6 与 Tiptap
    // 都到下一帧才量得准）。再试一次就收手——第二次还失败，这篇里确实没有那一串字
    const raf = requestAnimationFrame(() => {
      const now = useStore.getState()
      if (now.searchJump?.at !== searchJump.at || now.entry?.id !== searchJump.entryId) return
      locateHit(searchJump, rich, scrollRef.current)
    })
    return () => cancelAnimationFrame(raf)
  }, [searchJump, rich])

  // 滚动时回报「当前所在的标题」，右栏据此高亮
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return

    const onScroll = (): void => {
      // 谁在眼前，这一发 scrollTop 就算谁的（§〇 M2：容器是同一个 DOM 节点）。
      // 两件事要挡：归位那两帧里的中间值、以及源码模式——后者 `.panes` 整块不显示，
      // 容器量到 0，记进去就把这一格富文本那一档的位置冲掉了
      const s = useStore.getState()
      if (rich && !归位中.current) {
        const 格 = s.tabs[s.activeTab]
        if (格) s.setTabScroll(格.entryId, Math.round(box.scrollTop))
      }
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
      <TabBar />
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
            onClick={() => void switchEditorMode(editorMode === 'reading' ? 'rich' : editorMode === 'rich' ? 'source' : 'reading')}
            title="Ctrl+Shift+M · 阅读 → 所见即所得 → 源码 → 阅读"
          >
            <IconCode />
            {editorMode === 'reading' ? '编辑（所见即所得）' : editorMode === 'rich' ? '源码模式' : '阅读'}
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

          {rich || 挂着的.length > 0 ? (
            /* 期-09a：一个标签一棵，切走的只是看不见，不重建（设计稿 §五 ①——重建一次是 7 秒）。
               源码模式下这一整块也留着挂着：切档只重建看得见那一棵，别把整排标签都解析一遍。 */
            <div className="panes" style={rich ? undefined : { display: 'none' }}>
              {挂着的.map((id) => (
                <div className="tab-pane" key={id} data-active={id === entry.id && rich ? '1' : undefined}>
                  <RichEditor
                    entryId={id}
                    visible={rich && id === entry.id}
                    readOnly={editorMode === 'reading'}
                  />
                </div>
              ))}
            </div>
          ) : null}
          {!rich && <SourceEditor key={entry.id} />}
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
        {selChars > 0 && <span className="sel-count"> · 选中 {selChars} 字</span>}
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
          title="切换编辑器模式（Ctrl+Shift+M · 阅读 → 所见即所得 → 源码 → 阅读）"
          onClick={() => void switchEditorMode(editorMode === 'reading' ? 'rich' : editorMode === 'rich' ? 'source' : 'reading')}
        >
          {editorMode === 'reading' ? '阅读' : editorMode === 'rich' ? '所见即所得' : '源码'}
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
