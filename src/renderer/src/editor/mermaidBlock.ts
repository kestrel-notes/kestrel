/** Mermaid 图：` ```mermaid ` 围栏渲成 SVG（期-05 §4.3）。
 *
 *  **为什么是另一种节点，而不是接管 `codeBlock` 的视图**：原计划挂在
 *  `CodeBlockLowlight` 的 `addNodeView` 上代理一层，实测 `@tiptap/extension-code-block`
 *  与 `-code-block-lowlight` 两个 dist 里都没有 `addNodeView`（只有 highlight 那条链），
 *  要接管就得在自己的 NodeView 里重写 lowlight 着色——那是给所有代码块加风险面，
 *  而不只是给图。所以只截 ```` ```mermaid ```` 这一种围栏，普通代码块一个字都不碰。
 *
 *  闸门（`roundTrip`）不需要为它新增判据，理由和公式一样：`code` **逐字存、逐字吐**。
 *  解析出 mermaidBlock → 序列化回同一段围栏 → 再解析还是 mermaidBlock，同一棵树。
 *  到了不认 mermaid 的编辑器里它就是一个代码块——降级方向是对的。
 *
 *  渲染侧两条：`securityLevel: 'strict'`（mermaid 自己先洗一遍）+ `svgToInert`
 *  （我们再过一遍属性白名单，不假设上游可靠）。SVG 里的颜色是**渲染时烤进去的**，
 *  所以主题一换必须重画，见 `watchTheme`。 */

import { Node, mergeAttributes, type Attribute } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'
import type { Mermaid, MermaidConfig } from 'mermaid'
import { blockEnd } from '@/editor/blockBound'
import { svgToInert } from '@/editor/inert'

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

/** 开围栏：≤3 格缩进、` 或 ~ 三种以上、语言名就叫 mermaid。
 *  闭围栏同字符、不短于开头、独占一行。未闭合的一律不抢——留给普通代码块。
 *  （marked 的块词法器会先把 CRLF 折成 LF，这里仍按可能带 `\r` 处理，别依赖那一条。） */
const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid[ \t]*\r?\n/i
/** 只看行首：OPEN 最长得 3 格缩进 + 一串围栏字符 + mermaid + 行尾空白，64 足够包住。 */
const OPEN_WINDOW = 64

/** 找 `src` 里第一个**闭合了**的 mermaid 围栏。
 *
 *  `止` 只限"找开头"那一圈（`start` 用它把边界收到本段，见 `blockBound.ts`）；
 *  闭围栏照旧往后读到哪算哪 —— 图里的空行是合法内容，把串剪短会让"开在本段、闭在段外"那一档认不出。 */
function findMermaidFence(
  src: string,
  止: number = src.length
): { at: number; len: number; code: string } | null {
  for (let at = 0; at < 止; at = nextLine(src, at)) {
    const open = OPEN.exec(src.slice(at, at + OPEN_WINDOW))
    if (!open) continue
    const body = at + open[0].length
    const closed = closeOf(src, body, open[1])
    if (closed === null) continue
    // raw 必须把闭围栏整行一起吃掉：留着的下半截会被 marked 的 code 规则当成「新开的围栏」
    // 一路吞到文末，闸门再解析一遍就对不上树（实测：单放一个 mermaid 围栏 →「内容对不上」）
    const nl = src.indexOf('\n', closed)
    const end = nl === -1 ? src.length : nl + 1
    return {
      at,
      len: end - at,
      code: src.slice(body, closed).replace(/\r?\n$/, ''),
    }
  }
  return null
}

/** 从代码体第一行的行首往后找闭围栏，命中就返回它那一行的行首。 */
function closeOf(src: string, from: number, marker: string): number | null {
  const bar = marker[0] === '`' ? '`' : '~'
  // 闭围栏：同一字符、不短于开头、行首 ≤3 格缩进、其后只有空白（CRLF 的话允许一个 \r）
  const close = new RegExp('^ {0,3}[' + bar + ']{' + marker.length + ',}[ \\t]*\\r?$')
  for (let line = from; ; line = nextLine(src, line)) {
    const nl = src.indexOf('\n', line)
    if (close.test(src.slice(line, nl === -1 ? src.length : nl))) return line
    if (nl === -1) return null
  }
}

/** 下一行的行首；到底返回 src.length，让调用方的循环自然退出。 */
function nextLine(src: string, at: number): number {
  const nl = src.indexOf('\n', at)
  return nl === -1 ? src.length : nl + 1
}

let loading: Promise<Mermaid> | null = null

/** 整个渲染层共享一份 mermaid：图是懒的（首屏不背这 1MB+），但一旦打开第一篇有图的
 *  笔记，同会话内后面的图就不该再等一次 chunk 下载。 */
function mermaidOnce(): Promise<Mermaid> {
  if (!loading) {
    loading = import('mermaid').then((m) => m.default ?? (m as unknown as Mermaid))
  }
  return loading
}

const cssVar = (name: string, fallback: string): string =>
  getComputedStyle(document.body).getPropertyValue(name).trim() || fallback

/** `theme: 'base'` + 从设计 token 现取的颜色：图里的字要和正文同色阶，否则暗主题下
 *  一张亮底图就是页面上最大的一块噪声。`background: 'transparent'` 让图坐在编辑区底色上。 */
function mermaidConfig(): MermaidConfig {
  const panel = cssVar('--bg-panel', '#ffffff')
  const line = cssVar('--text-3', '#707680')
  return {
    // startOnLoad 是 mermaid 的默认 true——不关的话它会自己去正文里找 .mermaid 节点
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: cssVar('--font-ui', 'sans-serif'),
    themeVariables: {
      background: 'transparent',
      mainBkg: panel,
      primaryColor: panel,
      primaryTextColor: cssVar('--text-1', '#171a20'),
      primaryBorderColor: line,
      secondaryColor: cssVar('--accent-soft', panel),
      tertiaryColor: panel,
      lineColor: line,
      edgeLabelBackground: panel,
      clusterBkg: cssVar('--hover', panel),
      clusterBorder: cssVar('--border-strong', line),
      titleColor: cssVar('--text-1', '#171a20'),
    },
  }
}

let seq = 0

/** mermaid 把 id 写进 SVG 内的 `<style>` 选择器（`#id .node ...`）。同一段源码在两个
 *  节点里、或者重画两次都复用同一个 id 的话，后插入的那份样式会去改前一张图。 */
const nextId = (): string => `kestrel-mmd-${++seq}`

/** 活动视图的登记表：主题（含自定义强调色）一变就把所有图重画一遍。
 *  挂在 body 的属性上而不是 import store：编辑层与 store 之间不许有反向依赖
 *  （`markdown.ts` 那条 import 环的同一个理由）。 */
const live = new Set<() => void>()
let themeWatch: MutationObserver | null = null

function watchTheme(rerender: () => void): () => void {
  live.add(rerender)
  if (!themeWatch) {
    themeWatch = new MutationObserver(() => {
      for (const fn of [...live]) fn()
    })
    themeWatch.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    })
  }
  return () => void live.delete(rerender)
}

function sourceBox(code: string, error: string): HTMLElement {
  const box = document.createElement('pre')
  box.className = 'mermaid-source'
  box.append(code)
  if (error) {
    const why = document.createElement('div')
    why.className = 'mermaid-error'
    why.textContent = error
    box.append('\n', why)
  }
  return box
}

/** NodeView：画 SVG → 双击换 textarea → 提交走事务改 attrs。
 *  和公式那一套同形状，差别只在渲染是异步的：每次重画领一个号，迟到号小于当前号的
 *  结果直接丢，否则旧主题下的图会盖到新主题之后。 */
function mermaidView(
  initialCode: string,
  view: EditorView,
  getPos: (() => number | undefined) | undefined,
  dom: HTMLElement
): { setCode: (code: string) => void; dispose: () => void } {
  let code = initialCode
  let gen = 0
  let unwatch = (): void => {}

  const draw = (): void => {
    const mine = ++gen
    if (!code.trim()) {
      // 空图不去碰 mermaid：那 1MB+ 的 chunk 只该在真有一张图要画时才下载
      const empty = document.createElement('div')
      empty.className = 'mermaid-empty'
      empty.textContent = view.editable ? '双击输入 Mermaid 源码' : '（空图）'
      dom.replaceChildren(empty)
      dom.dataset.state = 'empty'
      return
    }
    dom.replaceChildren(document.createTextNode(''))
    dom.dataset.state = 'loading'
    void mermaidOnce()
      .then(async (api) => {
        api.initialize(mermaidConfig())
        return api.render(nextId(), code)
      })
      .then(({ svg }) => {
        if (mine !== gen) return
        dom.replaceChildren(svgToInert(svg))
        dom.dataset.state = 'ready'
      })
      .catch((err: unknown) => {
        // 语法错 / 未知图类型：显式退回源码，并说清是为什么。「画不出」和「画错了」
        // 不能长一样，否则用户会以为图丢了。
        if (mine !== gen) return
        const why = err instanceof Error ? err.message.split('\n')[0] : String(err)
        dom.replaceChildren(sourceBox(code, `无法渲染：${why}`))
        dom.dataset.state = 'error'
      })
  }

  const openEditor = (e: MouseEvent): void => {
    e.preventDefault()
    // 阅读态翻成可编辑不会重建这棵视图，所以可编辑性要现查、不能拿建视图那一刻的值
    if (!view.editable) return
    if (dom.querySelector('textarea')) return
    const field = document.createElement('textarea')
    field.className = 'md-mermaid-input'
    field.value = code
    field.setAttribute('spellcheck', 'false')
    dom.replaceChildren(field)
    field.focus()
    field.select()

    // blur 与 Shift+Enter 可能前后脚都到，别提交两遍
    let closed = false
    const close = (commit: boolean): void => {
      if (closed) return
      closed = true
      const next = field.value
      const pos = getPos?.()
      if (commit && next !== code && pos != null) {
        // 提交走事务，重画交给 update()；取消或没改就自己收回输入位。
        // 输入位得先摘掉：`setCode` 见它还挂着就不重画（免得抽掉用户正在打的字），
        // 而 blur 并不会把节点从 DOM 里移走——不摘的话画面永远停在这只框上。
        field.remove()
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { code: next }))
      } else draw()
    }
    field.addEventListener('blur', () => close(true))
    field.addEventListener('keydown', (ev) => {
      const k = ev as KeyboardEvent
      k.stopPropagation()
      // Enter 留给换行（图源码本来是多行），Shift/Ctrl/Meta+Enter 提交
      if (k.key === 'Enter' && (k.shiftKey || k.metaKey || k.ctrlKey)) {
        k.preventDefault()
        close(true)
      } else if (k.key === 'Escape') {
        k.preventDefault()
        close(false)
      }
    })
  }

  // 换主题要重画。这条不挂在 `view.editable` 上：同一块屏可以从阅读态建视图，之后
  // 只是 `setEditable(true)` 翻成可编辑——建的时候不注册，之后怎么翻都不会补上，
  // 于是「换主题图不变色」（实测：`data-theme` 换了、svg 的 id 还是原来那个）。
  unwatch = watchTheme(draw)
  dom.addEventListener('dblclick', openEditor)
  draw()

  return {
    setCode: (next) => {
      code = next
      if (!dom.querySelector('textarea')) draw()
    },
    dispose: () => {
      gen++
      unwatch()
      dom.removeEventListener('dblclick', openEditor)
    },
  }
}

const codeAttr: Record<string, Attribute> = {
  code: {
    default: '',
    parseHTML: (el) => el.getAttribute('data-mermaid') ?? '',
    renderHTML: (attrs) => ({ 'data-mermaid': str(attrs.code) }),
  },
}

export const MermaidBlock = Node.create({
  name: 'mermaidBlock',
  group: 'block',
  atom: true,

  addAttributes: () => codeAttr,

  parseHTML() {
    return [{ tag: 'div[data-mermaid]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { class: 'md-mermaid', 'data-mermaid-block': '' }),
      str(HTMLAttributes.code),
    ]
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div')
      dom.className = 'md-mermaid'
      dom.setAttribute('contenteditable', 'false')
      const ctl = mermaidView(str(node.attrs.code), editor.view, getPos, dom)
      // 图与输入位都是视图自己改的 DOM：不声明忽略，ProseMirror 会当成外力改动去
      // recover——那一趟整篇重新序列化并标脏落库（wikiLink / 公式同一条坑）。
      return {
        dom,
        ignoreMutation: () => true,
        update: (next) => {
          if (next.type.name !== 'mermaidBlock') return false
          ctl.setCode(str(next.attrs.code))
          return true
        },
        destroy: () => ctl.dispose(),
      }
    }
  },

  markdownTokenizer: {
    name: 'mermaidBlock',
    level: 'block' as const,
    /** 只在本段之内找开围栏（`blockEnd` 那颗函数与它的原因在 `blockBound.ts`）。
     *  边界当**找开头的循环的上限**传进去，不剪串：闭围栏可以跨过段里的空行。 */
    start: (src: string) => findMermaidFence(src, blockEnd(src))?.at ?? -1,
    tokenize(src: string) {
      // 块级 tokenizer 的合同是"只能从第 0 颗字开始 matched"（marked 拿到 raw 就
      // `e.substring(r.raw.length)`，从中间 matched 会把中间那段字整块丢掉）。
      // 所以先只看行首那一小截，不对立刻走人 —— 少了这一句，`findMermaidFence` 会把整条剩余串
      // 一行一行扫完（每行一次 slice + 一次 exec），回来只为判一句 `hit.at !== 0`。
      // 实测（#177，`scratch/p177d.mjs` 按名字记账）：800 段那一趟里这一颗 52.9 ms，占整趟 29%；
      // 换成锚定预检是 108×（`scratch/p177e-anchor.mjs`，两版对 1600 轮的 matched 结论逐轮一致）。
      if (!OPEN.exec(src.slice(0, OPEN_WINDOW))) return undefined
      const hit = findMermaidFence(src)
      if (!hit || hit.at !== 0) return undefined
      return { type: 'mermaidBlock', raw: src.slice(0, hit.len), code: hit.code }
    },
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('mermaidBlock', {
      code: str((token as unknown as { code?: string }).code),
    }),

  renderMarkdown: (node) => '```mermaid\n' + str(node.attrs?.code) + '\n```',
})
