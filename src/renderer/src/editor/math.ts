/** 公式：行内 `$x$` 与块级 `$$…$$`，KaTeX 渲染（期-05 §4.1）。
 *
 *  两条纪律决定了这块的形状：
 *  1. **`tex` 逐字存、逐字吐**（`renderMarkdown` 只拼回 `$` + tex + `$`）。不这么做的话
 *     marked 会把 `\int_0^1 x\,dx` 改写成 `\int\_0^1 x,dx`——`\,` 的反斜杠被吃掉、下划线
 *     多一层转义（设计稿 §2.1 第 3 行的实测）。逐字回吐之后闸门（`roundTrip`）不需要为
 *     公式新增任何判据：解析出来是同一棵树，序列化回去是同一串字节。
 *  2. **不 innerHTML**。`katex.renderToString` 给的是字符串，喂给 DOMParser 变成 inert
 *     节点再搬进文档，并自己过一遍属性白名单（§3 D5：不假设上游净化可靠）。 */

import { Node, mergeAttributes, InputRule, type Attribute } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { htmlToInert } from '@/editor/inert'

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/

/** 行内公式的边界判据（期-05 §3 D1 那五条）。`src[pos]` 必须是 `$`，返回吃掉长度（含两侧 `$`）。 */
function inlineMathAt(src: string, pos: number): number {
  if (src[pos] !== '$') return 0
  const next = src[pos + 1]
  if (next === undefined || next === '$' || /\s/.test(next)) return 0
  for (let end = pos + 2; end <= src.length; end++) {
    if (src[end - 1] !== '$') continue
    const body = src.slice(pos + 1, end - 1)
    if (!body || /[ \t]$/.test(body)) continue
    if (/[0-9]/.test(src[end] ?? '')) continue
    // 中文日记里 `$30与$` 这种不是公式：body 带中日韩文字又没有任何 `\` 命令，判死
    if (CJK.test(body) && !body.includes('\\')) continue
    let bs = 0
    for (let i = end - 2; i >= pos + 1 && src[i] === '\\'; i--) bs++
    if (bs % 2 === 1) continue
    return end - pos
  }
  return 0
}

/** 找 src 里**第一个判据通过**的行内公式。
 *  不能只 `indexOf('$')` 就交出去：marked 拿那个下标 slice 之后，被拒的那一截会整段跳过
 *  后面的真公式——`汇率1$=7¥，然后$x$` 实测就是这个坑。 */
function findInlineMath(src: string): { at: number; len: number } | null {
  for (let i = src.indexOf('$'); i !== -1; i = src.indexOf('$', i + 1)) {
    const len = inlineMathAt(src, i)
    if (len > 0) return { at: i, len }
  }
  return null
}

/** 块级：开 `$$` 必须在行首（允许 0~3 格缩进，4 格以上是代码块，不抢）；
 *  要么 `$$` 独占一行、闭 `$$` 到行尾，要么整段就一行 `$$x$$`。 */
function findBlockMath(src: string): { at: number; len: number; tex: string } | null {
  for (let i = src.indexOf('$$'); i !== -1; i = src.indexOf('$$', i + 1)) {
    const lineHead = src.lastIndexOf('\n', i - 1) + 1
    if (!/^[ \t]{0,3}$/.test(src.slice(lineHead, i))) continue
    const body = src.slice(i)
    const multi = /^\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$(?=\n|$)/.exec(body)
    if (multi) return { at: i, len: multi[0].length, tex: multi[1] }
    const oneLine = /^\$\$([^\n$]*)\$\$(?=\n|$)/.exec(body)
    if (oneLine) return { at: i, len: oneLine[0].length, tex: oneLine[1] }
  }
  return null
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

/** NodeView 共用件：画 KaTeX → 双击换输入位 → 失焦/Enter 落回 attrs。
 *  atom 节点本身不可编辑，改的是 attrs，所以「编辑公式」不动文档形状。
 *  返回的 `setTex` 给 `update()` 用：节点被换掉（撤销 / 外部改）时重画。 */
function mathView(
  initialTex: string,
  view: EditorView,
  getPos: (() => number | undefined) | undefined,
  dom: HTMLElement,
  block: boolean
): { setTex: (tex: string) => void } {
  let tex = initialTex

  const paint = (): void => {
    if (!tex.trim()) {
      // 斜杠命令刚插进来的空公式总得看得见，否则用户以为没插上（阅读视图里没「双击」可说）
      const empty = document.createElement('span')
      empty.className = 'md-math-empty'
      empty.textContent = view.editable ? '双击输入公式（TeX）' : '（空公式）'
      dom.replaceChildren(empty)
      return
    }
    dom.replaceChildren(
      // displayMode 决定 KaTeX 吐 `.katex-display`（居中、\frac 按展示尺寸排），
      // 不给的话块级公式看着就是行内公式放大了一档
      htmlToInert(
        katex.renderToString(tex, {
          output: 'html',
          throwOnError: false,
          displayMode: block,
        })
      )
    )
  }
  paint()

  const openEditor = (e: MouseEvent): void => {
    e.preventDefault()
    // 听 always 挂、editable 现查：同一棵 PM 实例会从阅读态翻成可编辑（换模式不重建），
    // 建视图那一刻的 `view.editable` 不是这件事的判据
    if (!view.editable) return
    if (dom.querySelector('input,textarea')) return
    const field = document.createElement(block ? 'textarea' : 'input')
    field.className = 'md-math-input'
    field.value = tex
    if (!block) field.setAttribute('spellcheck', 'false')
    dom.replaceChildren(field)
    field.focus()
    if (block || field instanceof HTMLInputElement) field.select()

    // 一次性的：blur 与 Enter/Escape 可能前后脚都到，别提交两遍
    let closed = false
    const close = (commit: boolean): void => {
      if (closed) return
      closed = true
      const next = field.value
      const pos = getPos?.()
      if (commit && next !== tex && pos != null) {
        // 提交走事务，重画交给 update()；其余情形（取消 / 没改）自己收回输入位。
        // 先把输入位摘掉：`setTex` 见到 `input/textarea` 还挂着就不重画（怕抽掉用户正在
        // 打的字），blur 又不会把节点移走——不摘的话画面会永远停在输入框上。
        field.remove()
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { tex: next }))
      } else {
        paint()
      }
    }
    field.addEventListener('blur', () => close(true))
    field.addEventListener('keydown', (ev) => {
      const k = ev as KeyboardEvent
      k.stopPropagation()
      // 块级用 Shift+Enter 提交（Enter 留给换行）；行内 Enter 直接提交
      if (k.key === 'Enter' && (!block || k.shiftKey || k.metaKey || k.ctrlKey)) {
        k.preventDefault()
        close(true)
      } else if (k.key === 'Escape') {
        k.preventDefault()
        close(false)
      }
    })
  }
  dom.addEventListener('dblclick', openEditor)

  return {
    setTex: (next) => {
      tex = next
      // 正在改（DOM 里是输入位）时不重画，免得把用户输入框抽掉
      if (!dom.querySelector('input,textarea')) paint()
    },
  }
}

const texAttr: Record<string, Attribute> = {
  tex: {
    default: '',
    parseHTML: (el) => el.getAttribute('data-tex') ?? '',
    renderHTML: (attrs) => ({ 'data-tex': str(attrs.tex) }),
  },
}

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  markdownTokenName: 'mathInline',

  addAttributes: () => texAttr,

  parseHTML() {
    return [{ tag: 'span[data-tex]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'md-math', 'data-math-inline': '' }),
      str(HTMLAttributes.tex),
    ]
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('span')
      dom.className = 'md-math'
      dom.setAttribute('contenteditable', 'false')
      const ctl = mathView(str(node.attrs.tex), editor.view, getPos, dom, false)
      // KaTeX 与输入位都是 NodeView 自己改的 DOM，不声明忽略的话 ProseMirror 会当成
      // 「外力改动」去 recover——那一趟会整篇重新序列化并标脏落库（wikiLink 同一条坑）。
      return {
        dom,
        ignoreMutation: () => true,
        update: (next) => {
          if (next.type.name !== 'mathInline') return false
          ctl.setTex(str(next.attrs.tex))
          return true
        },
      }
    }
  },

  /** 边打边认：光标前刚好凑出一个合法 `$…$` 就换成公式节点（与 wikiLink 同一条理由——
   *  不然同一篇里手打的公式要等下次从 Markdown 解析才变样）。 */
  addInputRules() {
    return [
      new InputRule({
        find: /\$((?:\\.|[^$\n])*?[^\s$])\$$/,
        handler: ({ state, range, match }) => {
          const tex = match[1]
          if (CJK.test(tex) && !tex.includes('\\')) return null
          state.tr.replaceWith(range.from, range.to, this.type.create({ tex }))
        },
      }),
    ]
  },

  markdownTokenizer: {
    name: 'mathInline',
    level: 'inline' as const,
    start: (src: string) => findInlineMath(src)?.at ?? -1,
    tokenize(src: string) {
      const hit = findInlineMath(src)
      if (!hit || hit.at !== 0) return undefined
      return {
        type: 'mathInline',
        raw: src.slice(0, hit.len),
        tex: src.slice(1, hit.len - 1),
      }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('mathInline', { tex: str((token as unknown as { tex?: string }).tex) }),

  renderMarkdown: (node) => `$${str(node.attrs?.tex)}$`,
})

/** NodeView 的 update 交给各节点自己写：类型对不上就返回 false，让 ProseMirror 换掉整个视图，
 *  比在这里维护两份 DOM 状态稳。 */
export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',

  addAttributes: () => texAttr,

  parseHTML() {
    return [{ tag: 'div[data-math-block]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { class: 'md-math-block', 'data-math-block': '' }),
      str(HTMLAttributes.tex),
    ]
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div')
      dom.className = 'md-math-block'
      dom.setAttribute('contenteditable', 'false')
      const ctl = mathView(str(node.attrs.tex), editor.view, getPos, dom, true)
      return {
        dom,
        ignoreMutation: () => true,
        update: (next) => {
          if (next.type.name !== 'mathBlock') return false
          ctl.setTex(str(next.attrs.tex))
          return true
        },
      }
    }
  },

  markdownTokenizer: {
    name: 'mathBlock',
    level: 'block' as const,
    start: (src: string) => findBlockMath(src)?.at ?? -1,
    tokenize(src: string) {
      const hit = findBlockMath(src)
      if (!hit || hit.at !== 0) return undefined
      return { type: 'mathBlock', raw: src.slice(0, hit.len), tex: hit.tex }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('mathBlock', { tex: str((token as unknown as { tex?: string }).tex) }),

  renderMarkdown: (node) => `$$\n${str(node.attrs?.tex)}\n$$`,
})
