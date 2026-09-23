/** 脚注：`[^label]` 引用 + `[^label]: 正文` 定义（期-05 §4.2）。
 *
 *  两件不为别的、只为「闸门不许被弄脏」的取舍：
 *  1. **序号在渲染层算，不进 Markdown**（§3 D6）。把 defs 挪到文末聚合区要么改正文
 *     （用户打开一篇就看到闸门报「排版被重排」），要么在 UI 里凭空插一棵假节点树。
 *     所以 md 里始终是 `[^label]` 原样，序号只是 DOM 上的一行字。
 *  2. **defs 的 content 是 `inline*`，不是 `block+`**。给成 block+ 会让 `- 列表` 这类写法
 *     多一条序列化路径——期-04 §2.1 结论 5 那类「多一条路径多一处漂移」的口子，收益是零。
 *
 *  顺带补掉一个现存口子：`[^1]: 一句话` 单独成篇时，今天会被 marked 的「引用定义」规则
 *  **整行吃掉**（设计稿 §2.1 第 4 行）。这里登记了 block tokenizer，它就成了一种真节点。 */

import { Node, mergeAttributes, InputRule, type Attribute, type MarkdownToken } from '@tiptap/core'
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

/** `[^label]`。后面紧跟 `(` 的是引用式链接 `[^x](…)`，不抢。 */
const REF = /^\[\^([^\][\s]+)\](?!\()/
const DEF_HEAD = /^ {0,3}\[\^([^\][\s]+)\]:[ \t]*/

/** `[^label]: 正文` + 后续缩进行（Obsidian 的续行写法：新行以 4 空格 / 制表符起） */
function matchDef(src: string): { raw: string; label: string; body: string } | null {
  const head = DEF_HEAD.exec(src)
  if (!head) return null
  const lines = src.slice(head[0].length).split('\n')
  const body = [lines[0]]
  let consumed = head[0].length + lines[0].length
  for (let i = 1; i < lines.length; i++) {
    if (!/^(?: {4}|\t)/.test(lines[i])) break
    body.push(lines[i].replace(/^(?: {4}|\t)/, ''))
    consumed += 1 + lines[i].length
  }
  return { raw: src.slice(0, consumed), label: head[1], body: body.join('\n').trim() }
}

/** 文档里 defs 的出现序 → 序号。同一 label 的多个 ref 共享一个号（与 Obsidian 一致）。 */
function footnoteNumbers(doc: PMNode): Map<string, number> {
  const type = doc.type.schema.nodes.footnoteDef
  const map = new Map<string, number>()
  if (!type) return map
  doc.descendants((node) => {
    if (node.type === type) {
      const label = str(node.attrs.label)
      if (label && !map.has(label)) map.set(label, map.size + 1)
    }
    return true
  })
  return map
}

const labelAttr: Record<string, Attribute> = {
  label: {
    default: '',
    parseHTML: (el) => el.getAttribute('data-fn') ?? '',
    renderHTML: (attrs) => ({ 'data-fn': str(attrs.label) }),
  },
}

const numbersKey = new PluginKey<Map<string, number>>('kestrel-footnote-numbers')

/** 引用那颗上标的序号：NodeView 自己画在 `.fn-num` 上，不进文档、不进 md。
 *
 *  def 那一侧**不**走这条路（改走节点装饰，见 `FootnoteNumbers`）：def 有正文，
 *  序号只能画成 `dom` 的前置兄弟元素，浏览器就会把光标丢进那个兄弟里——实测敲两个字，
 *  字进了 `<sup>` 而 doc 里什么都没有，内容静默丢失。 */
function paintOne(map: Map<string, number> | undefined, label: string, num: HTMLElement): void {
  const n = map?.get(label)
  num.textContent = n ? `[${n}]` : '[?]'
  num.title = n ? `脚注 ${n}：${label}` : `没有名为「${label}」的脚注定义`
}

function defDom(view: EditorView, label: string): HTMLElement | null {
  const esc = label.replace(/["\\]/g, '\\$&')
  return view.dom.querySelector<HTMLElement>(`.fn-def[data-fn="${esc}"]`)
}

/** 引用没有对应定义时：在引用所在块之后补一个空定义，光标落进去接着写。 */
function insertDefForRef(editor: Editor, pos: number, label: string): void {
  const { state } = editor.view
  const type = state.schema.nodes.footnoteDef
  if (!type) return
  const $pos = state.doc.resolve(pos)
  const at = $pos.depth >= 1 ? $pos.after(1) : pos
  const tr = state.tr.insert(at, type.create({ label }))
  // 光标送进新定义内部：空 inline* 节点的第一个位置就是 at + 1
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)))
  editor.view.dispatch(tr.scrollIntoView())
}

export const FootnoteRef = Node.create({
  name: 'footnoteRef',
  group: 'inline',
  inline: true,
  atom: true,
  markdownTokenName: 'footnoteRef',

  addAttributes: () => labelAttr,

  parseHTML() {
    return [{ tag: 'sup[data-fn]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes(HTMLAttributes, { class: 'fn-ref' }), str(HTMLAttributes.label)]
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('sup')
      dom.className = 'fn-ref'
      dom.setAttribute('contenteditable', 'false')
      let label = str(node.attrs.label)
      dom.dataset.fnKind = 'ref'
      dom.dataset.fnLabel = label
      const num = document.createElement('span')
      num.className = 'fn-num'
      dom.appendChild(num)
      paintOne(numbersKey.getState(editor.state), label, num)

      const onClick = (e: MouseEvent): void => {
        e.preventDefault()
        const target = defDom(editor.view, label)
        if (target) {
          target.scrollIntoView({ block: 'center' })
          return
        }
        const pos = getPos?.()
        if (editor.isEditable && pos != null) insertDefForRef(editor, pos, label)
      }
      dom.addEventListener('click', onClick)

      return {
        dom,
        // 序号是这条路自己画的；不声明忽略，ProseMirror 会当成外力改动去 recover
        // （wikiLink 那条老坑：recover 会整篇重新序列化并标脏落库）
        ignoreMutation: () => true,
        update: (next) => {
          if (next.type.name !== 'footnoteRef') return false
          const l = str(next.attrs.label)
          if (l !== label) {
            label = l
            dom.dataset.fnLabel = l
            paintOne(numbersKey.getState(editor.state), l, num)
          }
          return true
        },
        destroy: () => dom.removeEventListener('click', onClick),
      }
    }
  },

  /** 边打边认：收尾那个 `]` 一敲就换成引用节点（wikiLink / 公式同一条理由——不然同一篇里
   *  手打的脚注要等下次从 Markdown 解析才变样）。
   *  **不**顺手补定义：那会在用户没打算写正文时凭空多一行，而且 label 撞上已有定义会
   *  出现两个同号。缺定义走点击那条路补（见 addNodeView 里的 onClick）。 */
  addInputRules() {
    return [
      new InputRule({
        find: /\[\^([^\][\s]+)\]$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ label: match[1] }))
        },
      }),
    ]
  },

  markdownTokenizer: {
    name: 'footnoteRef',
    level: 'inline' as const,
    /** 交出去的位置必须**判据也过**：`[^ 空]` 这种先占住 `[^` 会让同一串里后面的真
     *  `[^1]` 一起丢（marked 只认 start 给的那个下标）。与公式同一条纪律。 */
    start: (src: string) => {
      for (let i = src.indexOf('[^'); i !== -1; i = src.indexOf('[^', i + 1)) {
        if (REF.test(src.slice(i))) return i
      }
      return -1
    },
    tokenize(src: string) {
      const m = REF.exec(src)
      if (!m) return undefined
      return { type: 'footnoteRef', raw: m[0], label: m[1] }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('footnoteRef', {
      label: str((token as unknown as { label?: string }).label),
    }),

  renderMarkdown: (node) => `[^${str(node.attrs?.label)}]`,
})

export const FootnoteDef = Node.create({
  name: 'footnoteDef',
  group: 'block',
  content: 'inline*',
  defining: true,

  addAttributes: () => labelAttr,

  parseHTML() {
    return [{ tag: 'div[data-fn]' }]
  },

  renderHTML({ HTMLAttributes }) {
    // 内容洞（0）必须是父节点唯一的孩子：再挂一个 `<sup>n</sup>` 进去，
    // prosemirror-model 的 renderSpec 直接抛「Content hole must be the only child」。
    // 序号本来就不进 Markdown（§3 D6），画面上的号是节点装饰写的 `data-n` + `::before`。
    return ['div', mergeAttributes(HTMLAttributes, { class: 'fn-def' }), 0]
  },

  markdownTokenizer: {
    name: 'footnoteDef',
    level: 'block' as const,
    start: (src: string) => (DEF_HEAD.test(src) ? 0 : -1),
    tokenize(
      src: string,
      _tokens: MarkdownToken[],
      lexer: { inlineTokens?: (s: string) => MarkdownToken[] }
    ) {
      const d = matchDef(src)
      if (!d) return undefined
      return {
        type: 'footnoteDef',
        raw: d.raw,
        label: d.label,
        tokens: lexer.inlineTokens ? lexer.inlineTokens(d.body) : [],
      } as unknown as MarkdownToken
    },
  },

  parseMarkdown: (token, helpers) => {
    const t = token as unknown as { label?: string; tokens?: MarkdownToken[] }
    const kids = helpers.parseInline(t.tokens ?? [])
    return helpers.createNode('footnoteDef', { label: str(t.label) }, kids)
  },

  renderMarkdown: (node, h) => {
    const body = h.renderChildren((node.content ?? []) as never).replace(/\s+$/, '')
    return `[^${str(node.attrs?.label)}]: ${body}`
  },
})

/** 文档变了就重算序号：def 的号交给节点装饰，ref 的号由各 NodeView 画。
 *  与 folding / tagRefs 同一条纪律：纯渲染层，不动 doc、不动事务、不进 md。 */
export const FootnoteNumbers = Extension.create({
  name: 'footnoteNumbers',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: numbersKey,
        state: {
          init: (_c, state) => footnoteNumbers(state.doc),
          apply: (tr, prev) => (tr.docChanged ? footnoteNumbers(tr.doc) : prev),
        },
        props: {
          // def 的序号 + tooltip 画成**节点属性**。装饰是 ProseMirror 自己写进 DOM 的，
          // DOMObserver 不会把它当成外力改动；自定义 NodeView 要画序号就得多挂一个前置
          // 兄弟元素，浏览器会把光标拐进那个元素——打进来的字就此静默丢失。
          decorations: (state) => {
            const map = numbersKey.getState(state)
            const type = state.doc.type.schema.nodes.footnoteDef
            const decos: Decoration[] = []
            if (type) {
              state.doc.descendants((node, pos) => {
                if (node.type !== type) return true
                const label = str(node.attrs.label)
                const n = map?.get(label)
                decos.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    'data-n': n ? String(n) : '?',
                    title: n ? `脚注 ${n}：${label}` : `没有名为「${label}」的脚注定义`,
                  })
                )
                return true
              })
            }
            return DecorationSet.create(state.doc, decos)
          },
        },
        view: (view) => ({
          // PM 在每次状态更新后调它；`view.state` 已经是新状态，所以不用接参数。
          // 定义补出来之后引用要从 `[?]` 变成 `[1]`——那枚上标是 ref 的 NodeView 画的，
          // 它自己的 `update` 只在 label 变了才重画，所以这里兜一遍。
          update: () => {
            const map = numbersKey.getState(view.state)
            for (const num of Array.from(
              view.dom.querySelectorAll<HTMLElement>('.fn-ref .fn-num')
            )) {
              const host = num.closest<HTMLElement>('[data-fn-label]')
              if (host) paintOne(map, host.dataset.fnLabel ?? '', num)
            }
          },
        }),
      }),
    ]
  },
})
