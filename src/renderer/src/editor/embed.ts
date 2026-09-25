/** `![[…]]` 嵌入（期-05f 丙）：把另一篇（或它的某一节 / 某一段）画进正文里，只读。
 *
 *  两条约束是这个文件存在的全部理由，动它之前先读这两条：
 *
 *  1. **`start` 必须永远返回 -1**（`docs/期-05-设计稿.md` §18.2）。marked 的扩展注册表是**进程级共享**的：
 *     只要这支块级扩展的 `start` 报了位置，同一进程里**每一份** `MarkdownManager`（含闸门那一份单例）
 *     的段落都会被它腰斩——`前面 ![[x]] 后面` 多出一个换行，而闸门照旧报"无损"。
 *     更坏的一头：没有这个节点类型的那一份管理器会把整串 token 直接吞掉（`第一段\n![[x]]` → `第一段`）。
 *     tiptap 在缺省 `start` 时替我们造的那一支**正是报位置的**，所以这个字段不能省。
 *     四档对照的实测与判据：`scratch/p05f-pre5.mjs`。
 *  2. **这一支必须装进 `buildExtensions()`**（`markdown.ts` 里那段"闸门用的就是这一份 schema"的要求）。
 *     只在某一边注册 = 另一边吃字。
 *
 *  为什么嵌一棵只读实例而不是"把渲染好的 HTML 塞进去"：嵌进来的那一截本身是 Markdown，
 *  里面有列表、代码块、双链。再解析一棵才与它原本那一篇长一个样，
 *  顺带白拿 5d 的悬停卡与乙的落点跳转。代价就是 §15.5 那笔账（固定 ≤5 ms、每段 ≈0.43 ms）。 */

import { Editor, Node, mergeAttributes, type AnyExtension, type JSONContent } from '@tiptap/core'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import { Fragment } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { normalizeLinkKey, splitLinkInner } from '../../../shared/links'
import type { EmbedAsk, EmbedCard, OutgoingLink } from '../../../shared/types'
import type { LinkBridge } from '@/editor/markdown'

/** 一篇里最多展开几处嵌入。超出的只画一行链接并**报数**——与 5e 那"最多 20 处、报数不翻页"同一族 */
export const 每篇嵌入上限 = 20
/** 嵌嵌套嵌最多几层（`嵌链` 的长度）。环检测兜住"绕回来"，这一条兜住"一路往下" */
export const 嵌入深度上限 = 3

export interface EmbedAttrs {
  raw: string
  target: string
  anchor: string | null
  block: string | null
}

/** 独占一行的 `![[…]]`（≤3 空格缩进算行首，与 `shared/links.ts` 的 `unwrap` 同一把尺）。
 *  行尾必须有换行或文件尾——`![[x]] 还有字` 是句子里的一条链接，不是嵌入（§18.3） */
const 一行嵌 = /^ {0,3}!\[\[([^[\]\n]*)\]\][ \t]*(?=\n|$)/

/** `![[ 目标 #锚点 ^块 |别名 ]]` → 属性。拆不出目标的一律不是嵌入：
 *  `![[#小节]]` 那种同页写法今天仍是一行 `!` 加一条链接。
 *
 *  `raw` 存的是**传进来的那一段原样**（不 trim）：marked 拿 token.raw 的长度推进源码游标，
 *  少了行首那两个空格就会留半截空白在流里；而 `renderMarkdown` 逐字回吐它，
 *  多 trim 一个空格就是改了用户的字节——§18.3 那一条"缩进也要逐字节"量的就是这个 */
export function embedAttrs(raw: string): EmbedAttrs | null {
  const m = /^!\[\[([^[\]\n]*)\]\]$/.exec(raw.trim())
  if (!m) return null
  const 拆 = splitLinkInner(m[1])
  if (!拆?.target) return null
  return { raw, target: 拆.target, anchor: 拆.anchor, block: 拆.block }
}

/** 那一整行换完之后该长的字：与上面 `一行嵌` 同一把尺（≤3 空格算行首、行尾只许空白），
 *  只是把"往后看到换行"换成"整串到底" */
const 一整行嵌 = /^ {0,3}!\[\[[^[\]\n]*\]\][ \t]*$/

/** 边打边认：光标所在那一整行刚好是 `![[…]]`，就把它换成一棵嵌入（期-05f 丙记下的 #167）。
 *
 *  为什么不再自己注册一条输入规则，而是由 `wikiLink` 那条先问一句：`[[x]]` 与 `![[x]]`
 *  的尾部是**同一段字**，两条规则会抢同一发 `]]`，而 Tiptap 里先注册的先赢
 *  （`rules.forEach` 开头就一句 `if (matched) return`），`WikiLink` 又排在 `Embed` 前面
 *  （`markdown.ts:373` 与 `:377`）——抢输的那一条永远轮不到。判"是不是嵌入"只放一处，
 *  顺序就不承载语义了。
 *
 *  不成嵌入一律回 false，让调用方照原样落链接。宁可不换，也不能换出
 *  "界面上是嵌入、下一次解析又不是嵌入"的两副样子。 */
export function 换整行嵌入(state: EditorState, 范: { from: number; to: number }, 中: string): boolean {
  const $从 = state.selection.$from
  if ($从.depth < 1) return false
  /** 那一整行的字要**拼**出来，不能直接读文档：规则看到的是 `textBefore + text`，
   *  而**刚打下的那一发 `]` 还在 `text` 里、没进文档**。所以匹配那一段用 `中`（含那一发），
   *  两头从文档里补。少了这一步，`![[x]]` 永远只被看成 `![[x]`，一条规则都不会命中
   *  （第一版就栽在这儿：屏幕上留下 `!` 加一条链接，库里那一行却已经是嵌入写法） */
  const 写 =
    state.doc.textBetween($从.start($从.depth), 范.from, '￼', ' ') +
    中 +
    state.doc.textBetween(范.to, $从.end($从.depth), '￼', ' ')
  return 落成嵌入(state.tr, $从, 写)
}

/** 补全那一条路的到货：`![[qu` 只打了一半就从菜单里选了一项。
 *  `起` 是那个 `!` 的位置，`写` 是**换完之后那一整行该长的字**（含缩进与行尾空白——
 *  `embedAttrs` 存 raw 存的就是传进去那一串原样，多一个空格都是改了用户的字节）。
 *  整块换掉，所以那一截 `![[qu` 天然被一起吃掉。自己派发，返回"换没换成"。 */
export function 换嵌入补全(view: EditorView, 起: number, 写: string): boolean {
  const $从 = view.state.doc.resolve(起)
  if ($从.depth < 1) return false
  /** `state.tr` 是个 getter，**取一次一个新事务**（PM 的 `EditorState.tr` 就这么写的）。
   *  所以这里抓住那一发递出去，别让调用方再去 `view.state.tr` 摸一遍——它摸到的是空的那个，
   *  于是"换成功了但屏幕上什么都没发生"（第一版的 5.2 就是这么红的） */
  const tr = view.state.tr
  if (!落成嵌入(tr, $从, 写)) return false
  view.dispatch(tr.scrollIntoView())
  return true
}

/** 核心：把 `$从` 所在那一整块换成一棵嵌入，后面留一个空段给光标落脚
 *  （不留的话，整篇可能再没有可写的块，人就被自己刚打的那两下锁住了）。
 *  不成嵌入一律回 false 且**一个字节都不动**——调用方照原样落链接。
 *  事务由调用方给：两头的派发路径不一样（规则那头发给 Tiptap，补全那头自己发） */
function 落成嵌入(tr: Transaction, $从: ResolvedPos, 写: string): boolean {
  // `tr` 上没有 `schema`（PM 只把它挂在 `state` 与 `nodeType` 上），从文档反推一份
  const 型 = tr.doc.type.schema.nodes.embed
  const 段 = tr.doc.type.schema.nodes.paragraph
  const a = 一整行嵌.test(写) ? embedAttrs(写) : null
  if (!型 || !a) return false
  const 父 = $从.node($从.depth - 1)
  const 前 = $从.before($从.depth)
  const 后 = $从.after($从.depth)
  const 节 = 型.create(a)
  const 尾 = 段?.create() ?? null
  const 换 = 尾 ? [节, 尾] : [节]
  /** 问的是「这一串孩子摆在这个父节点下合不合法」，而不是「嵌入这一个能不能当头一个孩子」：
   *  换下去的是 `[嵌入, 空段]` **这一串**，而 `contentMatch.matchType(型)` 只看头一个，
   *  第二块合不合法它答不了。（今天这两把尺在列表项那一档答案一样——都否；
   *  但只有 `validContent` 问的是那个真的问题） */
  if (!父.type.validContent(Fragment.fromArray(换))) return false
  tr.replaceWith(前, 后, 换)
  if (尾) tr.setSelection(TextSelection.near(tr.doc.resolve(前 + 节.nodeSize + 1)))
  return true
}

/** 屏幕上那一行小字：`↗ 玻璃工艺 · 装窑`。落点没有就不加那半个后缀 */
function 抬头(卡: EmbedCard, a: EmbedAttrs): string {
  const 尾 = a.anchor ? ` · ${a.anchor}` : a.block ? ' · 那一段' : ''
  return `↗ ${卡.名字}${尾}`
}

/** 退成一行：没那根线 / 目标不存在 / 成环 / 太深 / 太多。
 *  这五种说的话不一样，所以 `题` 必须由调用方给——在这里编一句漂亮话，就等于替系统撒一次谎 */
function 退成一行(dom: HTMLElement, 写: string, 题: string, 点?: () => void): void {
  dom.className = 'kb-embed kb-flat'
  dom.title = 题
  const 文 = document.createElement('span')
  文.className = 'kb-flat-text wl'
  文.textContent = 写
  dom.replaceChildren(文)
  if (!点) {
    文.classList.add('kb-noop')
    return
  }
  文.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    点()
  })
}

export const Embed = Node.create<{
  桥: LinkBridge | null
  /** 嵌套那一棵要的扩展集。由 `markdown.ts` 把自己的 `buildExtensions` 交进来：
   *  本文件在运行时不 import `markdown.ts`（两边互为依赖会成环），只 import 它的类型 */
  装配件: ((桥: LinkBridge | null) => AnyExtension[]) | null
  /** `resolveLink` 同样由 `markdown.ts` 递进来，理由与上一条一样：
   *  嵌进来的那一截要按**它自己那一篇**的出链染色，而这条换算全应用只许有一把尺 */
  解链: ((outgoing: OutgoingLink[], targetRaw: string, entryDate: string) => OutgoingLink | null) | null
}>({
  name: 'embed',
  group: 'block',

  addOptions() {
    return { 桥: null, 装配件: null, 解链: null }
  },

  addAttributes() {
    return {
      raw: { default: '' },
      target: { default: '' },
      anchor: { default: null },
      block: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-kb]' }]
  },

  renderHTML({ HTMLAttributes }) {
    // 复制粘贴走 HTML 这条路：raw 得带上，粘回来的那一串才是完整的写法
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-kb': '', class: 'kb-embed kb-flat' }),
      HTMLAttributes.raw,
    ]
  },

  addNodeView() {
    const 桥 = this.options.桥
    const 装配件 = this.options.装配件
    const 解链 = this.options.解链

    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div')
      // 这一整颗是只读的：不写这一条的话，头顶那一行与卡片里那些空隙都落在外层
      // `contenteditable=true` 底下，点一下就把光标放进了一个压根不该有光标的地方
      // （与 `math.ts` / `mermaidBlock.ts` 同一手）
      dom.setAttribute('contenteditable', 'false')
      const a = node.attrs as EmbedAttrs
      /** 退回来时原样摆出这一串写法（不重拼）：重拼会把 `|别名` 弄丢，
       *  而那正是"我看不出你写了什么"的那种谎 */
      const 写法 = a.raw.trim()

      /** 视图可能在异步那一趟回来之前就被换掉（切模式、改一个字都会重建） */
      let 活 = true
      let 内: Editor | null = null
      /** 每一趟取值带一个号：订阅会让我们重起，上一趟的响应回来得晚就只能丢掉，
       *  不然旧的"还没有创建"会把新画好的那张卡片盖掉 */
      let 轮 = 0
      /** 上一次取值用的是哪个落点。落点没变就不重取——这一颗的正文是一次渲染，不是一份要跟着
       *  每一次 store 变化刷新的状态（那一头改了正文要等这篇重新解析才看得见，见 §十九那条账） */
      let 上一落: string | null | undefined
      const 链 = 桥?.嵌链 ?? []
      /** 抬头、退回来的那一行，点的是同一条路 */
      const 跳 = (落: string): (() => void) => () =>
        桥?.open(落, a.target, { anchor: a.anchor, block: a.block, samePage: false })

      const 收 = (): void => {
        内?.destroy()
        内 = null
      }

      const 不嵌 = (题: string, 点?: () => void): void => 退成一行(dom, 写法, 题, 点)

      /** `桥住` / `装配` / `解` 由 `起()` 判过非空再递进来：这一棵里"有没有那几根线"是**结构**问题
       *  （幻灯片那一棵压根不给），不是每一趟取值都要重问一遍的运行时问题。
       *  而它必须**在这里**判完：走到半路才发现缺线，就会留下一个有头顶、没正文的空框 */
      const 画 = (
        卡: EmbedCard,
        落: string,
        桥住: LinkBridge,
        装配: (b: LinkBridge | null) => AnyExtension[],
        解: (outgoing: OutgoingLink[], targetRaw: string, entryDate: string) => OutgoingLink | null
      ): void => {
        if (!活) return
        if (卡.是 === 'miss') {
          // 走到这一支意味着**开头明明解析到了落点**、那一头却取不来：它是被送进回收站了，
          // 或者被彻底删了。这与"这篇压根还没创建"（`起()` 里 `落` 为 null 那一条）是两句话说
          // 的地方，别混成一句
          不嵌(`「${a.target}」已经不在库里了（回收站里，或已被彻底删除）`, () => 桥住.open(null, a.target))
          return
        }
        if (!卡.命中) {
          // 目标在、那一处不在。这句话与"还没有创建"不是一回事，别说错
          不嵌(
            `「${卡.名字}」里没有${a.anchor ? `「${a.anchor}」那一节` : '那一段'}`,
            () => 桥住.open(落, 卡.名字)
          )
          return
        }

        dom.className = 'kb-embed'
        const 头 = document.createElement('div')
        头.className = 'kb-head'
        const 链头 = document.createElement('span')
        链头.className = 'kb-go wl'
        链头.textContent = 抬头(卡, a)
        链头.title = `打开「${卡.名字}」${a.anchor ? `，跳到「${a.anchor}」` : a.block ? '，跳到那一段' : ''}`
        链头.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          桥住.open(落, 卡.名字, { anchor: a.anchor, block: a.block, samePage: false })
        })
        const 尾 = document.createElement('span')
        尾.className = 'kb-note'
        尾.textContent = 卡.截了 ? '太长了，只嵌了前一部分' : ''
        头.append(链头, 尾)
        const 身 = document.createElement('div')
        身.className = 'kb-body md-prose'
        dom.replaceChildren(头, 身)

        /** 那一头自己的出链与日期：不带上，嵌进来的那几行里的链接就会拿**这一篇**的出链表去染色，
         *  把"它指向的主题"画成悬空——同一串字在两个地方长成两样（与乙那一条同族） */
        const 嵌 = 桥住.embed
        const 子桥: LinkBridge = {
          resolve: (raw) => 解(卡.出链, raw, 卡.日子 ?? ''),
          open: (key, label, 落点) => 桥住.open(key, label, 落点),
          subscribe: (cb) => 桥住.subscribe(cb),
          openTag: (name) => 桥住.openTag(name),
          ...(桥住.preview
            ? { preview: (raw: string, 显示: string) => 桥住.preview?.(raw, 显示) ?? null }
            : {}),
          ...(嵌 ? { embed: (问: EmbedAsk) => 嵌(问) } : {}),
          // 这一趟递归的全部意义在这一行：链带下去，环与深度才看得见
          嵌链: [...链, 落],
        }
        /** `contentType:'markdown'` 是承重的（与 `RichEditor` 同一手）：那一截本来就是 Markdown，
         *  按 HTML 解析的话标题/列表/代码块/双链全塌成一段字——实机第一跑 1h 红就红在这里，
         *  而嵌套那两层也因此压根认不出第二颗 `![[…]]` */
        内 = new Editor({
          editable: false,
          extensions: 装配(子桥),
          content: 卡.md,
          contentType: 'markdown',
          editorProps: { attributes: { class: 'md-prose' } },
        })
        身.appendChild(内.view.dom)
      }

      const 起 = (): void => {
        const 我 = ++轮
        const 桥住 = 桥
        const 装配 = 装配件
        const 解 = 解链
        const 取 = 桥住?.embed
        if (!桥住 || !装配 || !解 || !取) {
          // 没给这几根线（幻灯片那一棵）⇒ 压根不取正文、也不开第二棵。
          // 这不是"在里面写个 if 关掉"，那条代码路径在这一棵里不存在
          退成一行(dom, 写法, '演示与阅读视图里不展开嵌入')
          return
        }
        const hit = 桥住.resolve(a.target)
        const 落 = hit?.nodeKey ?? null
        上一落 = 落
        if (!落) {
          不嵌(`「${a.target}」还没有创建`, () => 桥住.open(null, a.target))
          return
        }
        if (链.includes(落)) {
          不嵌(
            `成环了：${链.concat(落).map(短).join(' → ')}，到这一层就不再往下嵌`,
            跳(落)
          )
          return
        }
        if (链.length >= 嵌入深度上限) {
          不嵌(`嵌到第 ${嵌入深度上限} 层就停了，再往下只写一行链接`, 跳(落))
          return
        }
        const { 序, 总 } = 数嵌入(editor.state.doc, getPos)
        if (序 > 每篇嵌入上限) {
          不嵌(
            `这一篇里的嵌入只展开前 ${每篇嵌入上限} 处，还有 ${总 - 每篇嵌入上限} 处没展开`,
            跳(落)
          )
          return
        }
        void 取({ nodeKey: 落, key: hit?.key ?? normalizeLinkKey(a.target), 锚点: a.anchor, 块: a.block })
          .then((卡) => {
            if (我 === 轮) 画(卡, 落, 桥住, 装配, 解)
          })
          .catch(() => {
            if (活 && 我 === 轮) 不嵌('那一头取不过来')
          })
      }

      起()
      /** 这一条是实机那一边读出来的（第一跑 15 条红，全红在这上面）：
       *  `outgoing` 是**开这篇之后才异步取回来的**，节点视图建起来那一趟它常常还是空的，
       *  于是 `resolve` 回 null、每一颗嵌入都被误判成"还没有创建"，而且此后再也不回头看一眼。
       *  wikiLink 靠 `subscribe(paint)` 重画才没有这个毛病——这里同一条路：
       *  落点变了就重起一次，落点没变就不动（多的那一趟取值没人要）。 */
      const off = 桥?.subscribe(() => {
        if (!活 || !桥) return
        const 落 = 桥.resolve(a.target)?.nodeKey ?? null
        if (落 !== 上一落) {
          收()
          起()
        }
      })

      return {
        dom,
        // 分型色与里面那棵都是手工挂上去的，PM 不该把它们当成"外力改了 DOM"去 recover
        // （wikiLink 那一档踩过：recover 会重新序列化整篇并标脏落库，只是点一下就写盘）
        ignoreMutation: () => true,
        update: (next) => {
          if (next.type.name !== node.type.name) return false
          const b = next.attrs as EmbedAttrs
          if (b.raw !== a.raw) return false
          return true
        },
        destroy: () => {
          活 = false
          off?.()
          收()
        },
      }
    }
  },

  markdownTokenizer: {
    name: 'embed',
    level: 'block' as const,
    /** 永远 -1。这不是保守，是文件头第 1 条那条硬约束：报位置会改动**别人**的字节 */
    start: () => -1,
    tokenize(src) {
      const m = 一行嵌.exec(src)
      if (!m || m.index !== 0) return undefined
      const a = embedAttrs(m[0])
      if (!a) return undefined
      return { type: 'embed', ...a }
    },
  },

  parseMarkdown: (token, helpers) => {
    const t = token as unknown as Partial<EmbedAttrs>
    return helpers.createNode('embed', {
      raw: t.raw ?? '',
      target: t.target ?? '',
      anchor: t.anchor ?? null,
      block: t.block ?? null,
    })
  },

  /** 逐字吐回原文：与 wikiLink 同一条"原样回吐"的路。
   *  嵌进来的那些字**不属于**这一篇——它住在那一头，这一篇只写着这一串地址 */
  renderMarkdown: (node: JSONContent) => (node.attrs as EmbedAttrs | undefined)?.raw ?? '',
})

/** `e:12` 这种键在 tooltip 里读得懂就行，不必完整 */
function 短(key: string): string {
  return key.startsWith('e:') ? `篇#${key.slice(2)}` : key.startsWith('t:') ? `题#${key.slice(2)}` : key
}

/** 这一处是这一篇里的第几颗嵌入、这一篇一共几颗（都从 1 起）。
 *
 *  数的是"位置在我之前有几颗"，不是整棵总数：上限要**写在前面者优先**，
 *  只拿总数判会把二十颗一起打回一行——那等于上限一超就全塌，而不是超出的那几颗退成链接。
 *  总数同时给出去，因为界面上要说"还有几处没展开"，不能只说"这一处没展开"（5e 同一族）。
 *  嵌进来的那一棵有自己的 `state.doc`，所以这一趟数的只有当前这一篇，天然不跨层。 */
function 数嵌入(doc: PMNode, 位置: () => number | undefined): { 序: number; 总: number } {
  const 我 = 位置()
  let 前 = 0
  let 总 = 0
  doc.descendants((node, p) => {
    if (node.type.name === 'embed') {
      总++
      if (typeof 我 === 'number' && p < 我) 前++
    }
    return true
  })
  return { 序: 前 + 1, 总 }
}
