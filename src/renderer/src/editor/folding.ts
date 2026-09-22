/** 标题折叠 / 列表折叠（期-04 §4.7）。

 *  和标签 `tagRefs.ts` 同一条路：**只加装饰，不动 schema**。折叠态是插件里一个
 *  「哪些位置被折了」的集合，不进 ProseMirror 节点的 attrs，也就不进 Markdown：
 *  1. 闸门。`roundTrip()` 比的是「再解析一遍得到同一棵树」。往 heading / listItem
 *  上挂一个 `collapsed` attrs，看着无害，实则每多一个字段就多一处「序列化漏没漏」
 *  的悬案；装饰不写进树，往返一个字都不动。
 *  2. 折叠本就是编辑器状态，不该跟着文档走。Obsidian 的标题折叠重开也是展开的；
 *  我们只存 Markdown 全文，折叠态天然活在这一份内存里，换一篇 / 重开就清空。
 *
 *  折叠态用**位置**当键，靠 `tr.mapping` 在文档编辑时平移：删掉的那一段里的键随之
 *  丢弃（`mapResult(...).deleted`）。不追求「重排后仍然记住某节是折的」那种持久化，
 *  那需要一张跨会话 KV 表——§9 本期不做。 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'

const foldKey = new PluginKey<Set<number>>('kestrel-fold')

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList'])

/** 某个列表项里那棵嵌套列表（有则返回它的绝对位置与大小） */
function nestedList(item: PMNode, itemPos: number): { pos: number; size: number } | null {
  let off = itemPos + 1
  let hit: { pos: number; size: number } | null = null
  item.forEach((child) => {
    if (LIST_TYPES.has(child.type.name)) hit = { pos: off, size: child.nodeSize }
    off += child.nodeSize
  })
  return hit
}

/** 一颗列表项是否可折（有嵌套子列表才给三角） */
function foldableListItem(node: PMNode, absPos: number): boolean {
  return node.type.name === 'listItem' && nestedList(node, absPos) !== null
}

/** 折叠三角那颗小控件。它是独立 DOM，`mousedown` 直接翻这一个位置的折叠态——
 *  发一条只带 meta、不改文档的事务，所以不会触发 `onUpdate`（不会被当成编辑而落库）。 */
function chevron(pos: number, folded: boolean): (view: EditorView) => HTMLElement {
  return (view) => {
    const dom = document.createElement('span')
    dom.className = 'fold-chev' + (folded ? ' on' : '')
    dom.setAttribute('contenteditable', 'false')
    dom.title = folded ? '展开' : '折叠本节'
    dom.textContent = folded ? '▸' : '▾'
    dom.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      view.dispatch(view.state.tr.setMeta(foldKey, { toggle: pos }))
    })
    return dom
  }
}

function build(doc: PMNode, folded: Set<number>): DecorationSet {
  const out: Decoration[] = []

  // 一颗可见的非标题块：钻进去给带子列表的列表项加三角，折了的把子列表整棵藏掉
  const foldListsIn = (root: PMNode, rootPos: number): void => {
    root.descendants((node, relPos) => {
      if (!foldableListItem(node, rootPos + 1 + relPos)) return true
      const absPos = rootPos + 1 + relPos
      const sub = nestedList(node, absPos)
      out.push(Decoration.widget(absPos + 1, chevron(absPos, folded.has(absPos))))
      if (sub && folded.has(absPos)) {
        out.push(Decoration.node(sub.pos, sub.pos + sub.size, { class: 'fold-hide' }))
      }
      return true
    })
  }

  // 顶层扫描：标题按层叠规则决定「折起来藏到哪」，非标题块交给 foldListsIn
  let hideUntilLevel: number | null = null
  doc.forEach((node, pos) => {
    if (node.type.name === 'heading') {
      const level = node.attrs.level as number
      if (hideUntilLevel !== null) {
        if (level > hideUntilLevel) {
          // 更深的标题属于被折起来那一节的正文，一起藏
          out.push(Decoration.node(pos, pos + node.nodeSize, { class: 'fold-hide' }))
          return
        }
        hideUntilLevel = null // 同级或更高的标题：上一节的折叠到此为止
      }
      out.push(Decoration.widget(pos + 1, chevron(pos, folded.has(pos))))
      if (folded.has(pos)) hideUntilLevel = level
      return
    }
    if (hideUntilLevel !== null) {
      out.push(Decoration.node(pos, pos + node.nodeSize, { class: 'fold-hide' }))
      return
    }
    foldListsIn(node, pos)
  })

  return DecorationSet.create(doc, out)
}

export const Folding = Extension.create({
  name: 'folding',

  addProseMirrorPlugins() {
    return [
      new Plugin<Set<number>>({
        key: foldKey,
        state: {
          init: () => new Set<number>(),
          apply(tr, prev): Set<number> {
            let set = prev
            if (tr.docChanged) {
              // 折叠态是位置：跟着编辑平移，落在被删区间里的丢掉
              const next = new Set<number>()
              for (const p of prev) {
                const r = tr.mapping.mapResult(p, 1)
                if (!r.deleted) next.add(r.pos)
              }
              set = next
            }
            const meta = tr.getMeta(foldKey) as { toggle?: number } | undefined
            if (meta && meta.toggle != null) {
              const s = new Set(set)
              if (s.has(meta.toggle)) s.delete(meta.toggle)
              else s.add(meta.toggle)
              set = s
            }
            return set
          },
        },
        props: {
          decorations: (state) => build(state.doc, foldKey.getState(state) ?? new Set()),
        },
      }),
    ]
  },
})
