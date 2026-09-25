/** 源码模式那一半（CodeMirror 6）。
 *
 *  这里文档**就是** Markdown 源码本身，所以不存在往返损耗——所见即所存。
 *  所见即所得那边每次切过去都要过一道闸门，就是因为做不到这一点。
 *
 *  双链在这里是「给源码上的色」而不是节点：靠一个 ViewPlugin 把 findLinkRanges()
 *  算出来的下标染成与所见即所得同样的四态（§9.1）。两边的分型规则共用
 *  markdown.ts 的 linkClass()，一个链接在两种模式下不会看起来像两种东西。
 *
 *  点开得按 Ctrl：源码模式下平点是在放光标，不能抢。 */

import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { tags as t } from '@lezer/highlight'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { findLinkRanges } from '../../../shared/links'
import { findTagRanges, tagColorIndex } from '../../../shared/tags'
import { linkByKey, linkClass, rawLabel } from '@/editor/markdown'
import { 滚到锚点源码 } from '@/editor/anchor'
import { setCmView } from '@/editor/cmView'
import type { OutgoingLink } from '../../../shared/types'

/* 出链落点放进 CM 自己的状态里：染色要跟着「落点变了」重算，
   而这条线不经过文档，不给它一个 effect 就没法触发重算。 */
const setOutgoing = StateEffect.define<OutgoingLink[]>()
const outgoingField = StateField.define<OutgoingLink[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setOutgoing)) return e.value
    return value
  },
})

/** 语法着色只上色不改字：颜色全部走 token，换主题不用改这里。
 *  标题不分级：源码模式下这是等宽文本，靠字重和颜色区分层级就够了，
 *  真按 h1/h2/h3 变字号会把行高搅乱，看起来像排版坏了。 */
const mdHighlight = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], class: 'cm-h' },
  { tag: t.strong, class: 'cm-strong' },
  { tag: t.emphasis, class: 'cm-em' },
  { tag: t.monospace, class: 'cm-code' },
  { tag: [t.link, t.url], class: 'cm-link' },
  // `#`、`**`、`>` 这些记号本身
  { tag: [t.processingInstruction, t.labelName, t.escape], class: 'cm-mark' },
])

/** 整篇扫一遍算双链区间。
 *  不按可见区扫：可见区是按行切的，切片边界上围栏代码块的状态会丢，
 *  那块正好落在可见区里时，代码块里的 `[[x]]` 会被误染成链接。 */
function wikiDecorations(view: EditorView): DecorationSet {
  const entryDate = useStore.getState().entry?.entryDate ?? ''
  const outgoing = view.state.field(outgoingField)
  const marks = findLinkRanges(view.state.doc.toString(), entryDate).map((r) => {
    const hit = linkByKey(outgoing, r.link.key)
    const label = rawLabel(r.raw)
    return Decoration.mark({
      class: r.link.samePage ? 'wl wl-page' : `wl ${linkClass(hit)}`,
      attributes: {
        title: r.link.samePage
          ? `跳到这一篇的「${label}」`
          : hit?.nodeKey
            ? `Ctrl+点击打开「${label}」`
            : `「${label}」还没有创建`,
      },
    }).range(r.from, r.to)
  })
  return Decoration.set(marks)
}

/** 正文里的 `#标签`（§6）。与所见即所得那半边共用 `tagRefs.ts` 算区间：
 *  同一篇正文在两种模式下要么两处都能点，要么两处都不能点。 */
function tagDecorations(view: EditorView): DecorationSet {
  return Decoration.set(
    findTagRanges(view.state.doc.toString()).map((r) =>
      Decoration.mark({
        class: 'tag-ref',
        attributes: {
          'data-tag': r.name,
          // 与侧栏那棵树同一个取色函数：同一个标签在树上、正文里、源码里得是一个色
          style: `--tc: var(--tag-${tagColorIndex(r.name) + 1})`,
          title: `#${r.name} · Ctrl+点击筛出带它的记录`,
        },
      }).range(r.from, r.to)
    )
  )
}

const tagPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = tagDecorations(view)
    }
    update(u: ViewUpdate) {
      // 只认 docChanged：标签的样子全篇都是，选区滚出滚回不用重算
      if (u.docChanged) this.decorations = tagDecorations(u.view)
    }
  },
  { decorations: (v) => v.decorations }
)

const wikiPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = wikiDecorations(view)
    }
    update(u: ViewUpdate) {
      const outgoingChanged = u.startState.field(outgoingField) !== u.state.field(outgoingField)
      if (u.docChanged || u.viewportChanged || outgoingChanged) {
        this.decorations = wikiDecorations(u.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)

const theme = EditorView.theme({
  '&': { height: 'auto', fontSize: '0.8125rem', backgroundColor: 'transparent', color: 'var(--text-2)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.95', overflow: 'visible' },
  '.cm-content': { padding: '0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  // 选中色不能吃 CM 的默认值：那是个浅紫，四个暗色主题里几乎看不见
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
})

export function SourceEditor(): JSX.Element {
  const content = useStore((s) => s.content)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  /** 编辑器自己吐出去的那一版，和 store 相同就不回灌（回灌会把光标顶到文首） */
  const emitted = useRef(content)

  useEffect(() => {
    const parent = host.current
    if (!parent) return

    const onUpdate = EditorView.updateListener.of((u) => {
      if (!u.docChanged) return
      const md = u.state.doc.toString()
      if (md === emitted.current) return
      emitted.current = md
      useStore.getState().setContent(md)
    })

    // Tab 不绑缩进：绑了就是个键盘陷阱，按 Tab 出不去编辑区。
    // 需要缩进就打空格——v1 值得为「键盘能走出去」让这一步。
    const base: Extension[] = [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      markdown(),
      syntaxHighlighting(mdHighlight),
      outgoingField,
      wikiPlugin,
      tagPlugin,
      onUpdate,
      theme,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.domEventHandlers({
        mousedown: (e, v) => {
          if (!e.ctrlKey && !e.metaKey) return false
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
          if (pos === null) return false
          const s = useStore.getState()
          // 先问标签再问双链：一个位置同时落在两者里的情况不存在（`#` 在 `[[…]]` 内不算标签），
          // 但顺序稳定一点，读起来不至于以为是竞态在决定点什么
          const tag = findTagRanges(v.state.doc.toString()).find((r) => pos >= r.from && pos <= r.to)
          if (tag) {
            e.preventDefault()
            void s.selectTagName(tag.name)
            return true
          }
          const entryDate = s.entry?.entryDate ?? ''
          const at = findLinkRanges(v.state.doc.toString(), entryDate).find(
            (r) => pos >= r.from && pos <= r.to
          )
          if (!at) return false

          e.preventDefault()
          const label = rawLabel(at.raw)
          const 落点 = { anchor: at.link.anchor, block: at.link.block }
          if (at.link.samePage) {
            // 滚的是**这一格自己的** CM 视图，不是 `getCmView()` 那一棵（一屏底下好几格）
            if (!滚到锚点源码(v, v.state.doc.toString(), 落点.anchor, 落点.block))
              s.notify(`这一篇里没找到「${label}」`)
            return true
          }
          const hit = linkByKey(s.outgoing, at.link.key)
          if (hit?.nodeKey) {
            void s.openNode(hit.nodeKey)
            const id = hit.nodeKey.startsWith('e:') ? Number(hit.nodeKey.slice(2)) : NaN
            if (Number.isFinite(id) && (落点.anchor || 落点.block)) s.jumpToAnchor(id, 落点)
          } else s.notify(`「${label}」还没有创建`)
          return true
        },
      }),
    ]

    const v = new EditorView({ parent, state: EditorState.create({ doc: content, extensions: base }) })
    view.current = v
    setCmView(v)
    v.dispatch({ effects: setOutgoing.of(useStore.getState().outgoing) })
    // 光标落在文末再聚焦：日记是接着写，而且浮层关掉后焦点必须回到这里
    v.dispatch({ selection: { anchor: v.state.doc.length } })
    v.focus()

    // 出链落点变了（保存后重新解析、别的文档认领了悬空链接）就要重染
    const off = useStore.subscribe((s, prev) => {
      if (s.outgoing !== prev.outgoing) v.dispatch({ effects: setOutgoing.of(s.outgoing) })
    })

    return () => {
      off()
      setCmView(null)
      v.destroy()
      view.current = null
    }
    // 只建一次：正文与出链都从 store 现取，换文档时整个组件按 key 重建
  }, [])

  useEffect(() => {
    const v = view.current
    if (!v || content === emitted.current) return
    emitted.current = content
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content } })
  }, [content])

  return <div className="md-body source" ref={host} />
}