/** 正文里的 `#标签`：两个编辑器共用的那一套「哪里算一个标签」判据（期-02-设计 §6）。
 *
 *  与双链不同，这里**不动 schema**——标签不是节点也不是 mark，只是从正文现算出来的装饰。
 *  三个理由：
 *  1. 闸门。`roundTrip()` 比的是「再解析一遍得到同一棵树」，往树里加一种节点就等于给
 *     每一种写法都多一条序列化路径。装饰不写进树，往返一个字都不动。
 *  2. 标签是**可编辑文字**，做成 atom 节点的话光标进不去、删除一次掉一整串，
 *     而那正是用户手打 `#工作/项目A` 的地方。
 *  3. 判据只有一份。库里数标签用的是 `shared/tags.findTagRanges`，这里还是它，
 *     不会出现「界面上能点、树上没有」的第三种答案。
 *
 *  代码区仍然不算：围栏代码块在富文本树里是 `codeBlock` 节点（整块跳过），
 *  行内代码是 `code` mark（那几格填空格喂给解析器）。双链在树里是 atom 节点、
 *  不贡献文字，所以 `[[某篇#小节]]` 里的锚天生进不来。 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { findTagRanges, tagColorIndex } from '../../../shared/tags'

interface Scan {
  text: string
  /** `text` 里第 i 个字符在文档里的位置。inline atom 不贡献文字却占位，
   *  所以下标不能直接当位置用 */
  at: number[]
}

/** 一个 textblock 的可见文字 + 每个字符的文档位置。带 `code` mark 的片段填空格。 */
function scanBlock(node: PMNode, base: number): Scan {
  let text = ''
  const at: number[] = []
  let cursor = base
  node.forEach((child) => {
    const size = child.nodeSize
    const chunk = child.isText && child.text ? child.text : ''
    const code = child.marks.some((m) => m.type.name === 'code')
    for (let i = 0; i < chunk.length; i++) at.push(cursor + i)
    text += code ? ' '.repeat(chunk.length) : chunk
    cursor += size
  })
  return { text, at }
}

/** 一个 textblock 里的 `#tag` 区间，已经换算成文档位置。`codeBlock` 整块不算标签。 */
function blockTags(node: PMNode, base: number): { from: number; to: number; name: string }[] {
  if (node.type.name === 'codeBlock') return []
  const { text, at } = scanBlock(node, base)
  if (!text.includes('#')) return []
  return findTagRanges(text)
    .map((r) => ({ from: at[r.from], to: at[r.to - 1] + 1, name: r.name }))
    .filter((r) => r.from !== undefined && r.to !== undefined)
}

function tagDecorations(doc: PMNode): DecorationSet {
  const out: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    for (const r of blockTags(node, pos + 1)) {
      out.push(
        Decoration.inline(r.from, r.to, {
          class: 'tag-ref',
          'data-tag': r.name,
          style: `--tc: var(--tag-${tagColorIndex(r.name) + 1})`,
          title: `#${r.name} · Ctrl+点击筛出带它的记录`,
        })
      )
    }
    return false
  })
  return DecorationSet.create(doc, out)
}

/** 文档位置 → 它所在的那枚标签（用于点击判定，与源码模式同一套路：装饰身上不带处理器） */
export function tagAtPos(doc: PMNode, pos: number): string | null {
  const $p = doc.resolve(Math.min(pos, doc.content.size))
  const node = $p.node($p.depth)
  if (!node.isTextblock) return null
  const hit = blockTags(node, $p.before() + 1).find((r) => pos >= r.from && pos <= r.to)
  return hit?.name ?? null
}

const key = new PluginKey('kestrel-tag-refs')

export const TagRefs = Extension.create<{ openTag: ((name: string) => void) | null }>({
  name: 'tagRefs',

  addOptions() {
    return { openTag: null }
  },

  addProseMirrorPlugins() {
    const openTag = this.options.openTag
    /** 只在文档真的变了时重算：光标移动也会走到 decorations()，那时无整篇扫一遍不值 */
    let lastDoc: PMNode | null = null
    let last: DecorationSet = DecorationSet.empty

    return [
      new Plugin({
        key,
        props: {
          decorations: (state) => {
            if (state.doc !== lastDoc) {
              lastDoc = state.doc
              last = tagDecorations(state.doc)
            }
            return last
          },
          handleDOMEvents: {
            // 按 Ctrl 才跳：平点是在放光标，那和「点一下标签就换视图」是两件事
            mousedown: (view, event) => {
              const e = event as MouseEvent
              if (!(e.ctrlKey || e.metaKey)) return false
              const at = view.posAtCoords({ left: e.clientX, top: e.clientY })
              if (!at) return false
              const name = tagAtPos(view.state.doc, at.pos)
              if (!name) return false
              e.preventDefault()
              openTag?.(name)
              return true
            },
          },
        },
      }),
    ]
  },
})
