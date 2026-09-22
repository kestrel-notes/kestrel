/** Obsidian 风格的 Callout：`> [!type][+|-] 标题`，期-04 §4.2。
 *
 *  实现路线：**接管** `blockquote` 节点，不新起一种类型。理由有三：
 *  1. 树的形状不变（还是 `blockquote > paragraph`），闸门（`roundTrip` 的 `sameTree`）
 *     只看 type + attrs，不会因为多一种节点类型给每一种写法多一条序列化路径。
 *  2. 语法上 `> [!note] x` 本来就长得像引用；不叫 Callout 的编辑器（Obsidian 之外
 *     的一堆 markdown 工具）会把它降级为一段引用——这是好事，不看不明白。
 *  3. 折叠状态就是 attrs 上三个字段（`calloutType` / `calloutTitle` / `calloutFold`），
 *     普通的 blockquote 三个都是默认值，Gate 判据仍然只认「解析出来的是不是同一棵树」。
 *
 *  marked 的 blockExtensions（我们自己登记的 tokenizer）跑在内置 blockquote 之前，
 *  `> [!note] x` 会先被这里截住；不是 callout 形状的引用（`> 一段引文`）落到内置那条，
 *  内置出来的 token 里没有 calloutType，parseMarkdown 就走 attrs=undefined 那条。 */

import { Node, mergeAttributes, type Attribute, type MarkdownToken } from '@tiptap/core'

/** 一期支持八个 tone。色板走期-2 那 8 个 `--tag-*`；不新造 token。 */
export const CALLOUT_TYPES = [
  'note', 'tip', 'warning', 'danger', 'info', 'bug', 'example', 'quote'
] as const
export type CalloutType = (typeof CALLOUT_TYPES)[number]

/** Obsidian 的默认标题（用户没写 `[!x] 标题` 时显示的那个） */
const DEFAULT_TITLE: Record<string, string> = {
  note: '备注', tip: '提示', warning: '警告', danger: '危险',
  info: '信息', bug: '缺陷', example: '示例', quote: '引用',
}

/** `> [!type][+|-] 标题` 首行。type 大小写不敏感；折叠符可选；标题可到行尾。 */
const HEAD = /^>[ \t]*\[!([A-Za-z]+)\]([+-]?)[ \t]*([^\n]*)/

interface CalloutMatch {
  raw: string
  type: string
  fold: '' | '+' | '-'
  title: string
  inner: string
}

/** 从源码切出 callout 的整个块。首行必须匹 HEAD；剩下按行取，`>` 开头的行或后面还有 `>` 行的空行都算续行。 */
function matchCallout(src: string): CalloutMatch | null {
  const head = HEAD.exec(src)
  if (!head) return null
  let consumed = head[0].length
  if (src[consumed] === '\n') consumed += 1
  const rest = src.slice(consumed)
  const body: string[] = []
  let offset = 0
  while (offset < rest.length) {
    const nl = rest.indexOf('\n', offset)
    const end = nl === -1 ? rest.length : nl + 1
    const line = rest.slice(offset, end)
    // 空行终止 callout；段中留白请用 `>` 起一行（这是 Obsidian 的写法，也是内部
    // 有多个 paragraph 时的规范形式）
    if (line.trim() === '') break
    if (!/^[ \t]*>/.test(line)) break
    body.push(line)
    offset = end
  }
  const rawBody = body.join('')
  const inner = rawBody
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => l.replace(/^[ \t]*>[ \t]?/, ''))
    .join('\n')
  const raw = src.slice(0, consumed + rawBody.length)
  return {
    raw,
    type: head[1].toLowerCase(),
    fold: (head[2] || '') as '' | '+' | '-',
    title: head[3].trim(),
    inner,
  }
}

/** 逐行前缀 `> `（空行只写 `>`）；引用块的 body 用这个包住子节点序列化出来的 md。 */
function quoteBody(md: string): string {
  return md
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n')
}

/** attrs 上的 parseHTML/renderHTML 参数在 @tiptap/core 里是 any-ish，
 *  这里显式收窄一次，避免 noImplicitAny 报。 */
const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' ? v : fallback

export const Callout = Node.create({
  name: 'blockquote',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes(): Record<string, Attribute> {
    return {
      calloutType: {
        default: null as string | null,
        parseHTML: (el) => el.getAttribute('data-callout'),
        renderHTML: (attrs) =>
          attrs.calloutType ? { 'data-callout': String(attrs.calloutType) } : {},
      },
      calloutTitle: {
        default: '',
        parseHTML: (el) =>
          el.querySelector(':scope > .callout-title')?.getAttribute('data-title') ?? '',
        renderHTML: () => ({}),
      },
      calloutFold: {
        default: '' as '' | '+' | '-',
        parseHTML: (el) => {
          const f = el.getAttribute('data-callout-fold')
          return f === '+' || f === '-' ? f : ''
        },
        renderHTML: (attrs) =>
          attrs.calloutFold ? { 'data-callout-fold': str(attrs.calloutFold, '') } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'blockquote' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const type = node.attrs.calloutType as string | null
    if (!type) {
      return ['blockquote', mergeAttributes(HTMLAttributes), 0]
    }
    const title = str(node.attrs.calloutTitle, '') || DEFAULT_TITLE[type] || type
    const fold = str(node.attrs.calloutFold, '') as '' | '+' | '-'
    const cls = `md-callout tone-${type}${fold === '-' ? ' collapsed' : ''}`
    const extra: Record<string, string> = { class: cls, 'data-callout': type }
    if (fold) extra['data-callout-fold'] = fold
    return [
      'blockquote',
      mergeAttributes(HTMLAttributes, extra),
      ['div', { class: 'callout-title', 'data-title': title }, title],
      ['div', { class: 'callout-body' }, 0],
    ]
  },

  markdownTokenizer: {
    name: 'callout',
    level: 'block' as const,
    start: (src: string) => {
      const m = /(^|\n)>[ \t]*\[!/.exec(src)
      if (!m) return -1
      return m.index === 0 && src[0] === '>' ? 0 : m.index + 1
    },
    tokenize(
      src: string,
      _tokens: MarkdownToken[],
      lexer: { blockTokens: (s: string) => MarkdownToken[] }
    ) {
      const c = matchCallout(src)
      if (!c) return undefined
      let child: MarkdownToken[] = []
      try {
        child = c.inner ? lexer.blockTokens(c.inner) : []
      } catch {
        child = []
      }
      // 复用 blockquote 的 token 名，让 tiptap 的 registry 命中我们这份 parseMarkdown；
      // 自定义字段挂在 token 上供 parseMarkdown 读。
      return {
        type: 'blockquote',
        raw: c.raw,
        calloutType: c.type,
        calloutFold: c.fold,
        calloutTitle: c.title,
        tokens: child,
      } as unknown as MarkdownToken
    },
  },

  parseMarkdown: (token, helpers) => {
    const t = token as unknown as {
      calloutType?: string
      calloutFold?: '' | '+' | '-'
      calloutTitle?: string
      tokens?: MarkdownToken[]
    }
    const parseBlockChildren = helpers.parseBlockChildren ?? helpers.parseChildren
    const attrs =
      t.calloutType !== undefined
        ? {
            calloutType: t.calloutType,
            calloutTitle: t.calloutTitle ?? '',
            calloutFold: t.calloutFold ?? '',
          }
        : undefined
    return helpers.createNode('blockquote', attrs, parseBlockChildren(t.tokens || []))
  },

  renderMarkdown: (node, h) => {
    const attrs = (node.attrs ?? {}) as {
      calloutType?: string | null
      calloutTitle?: string
      calloutFold?: '' | '+' | '-'
    }
    const content = (node.content ?? []) as Array<Record<string, unknown>>
    let body = ''
    if (content.length > 0) {
      const parts: string[] = []
      content.forEach((child, index) => {
        const c =
          h.renderChild?.(child as never, index) ?? h.renderChildren([child as never] as never)
        parts.push(quoteBody(c))
      })
      body = parts.join('\n>\n')
    }
    const type = attrs.calloutType
    if (!type) return body
    const fold = attrs.calloutFold || ''
    const title = attrs.calloutTitle || ''
    const head = `> [!${type}]${fold}${title ? ' ' + title : ''}`
    return body ? `${head}\n${body}` : head
  },
})
