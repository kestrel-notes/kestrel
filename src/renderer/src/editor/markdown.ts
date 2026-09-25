/** Markdown ⇄ 富文本树：全应用只有这一套转换规则，两个编辑器共用。
 *
 *  Tiptap 的文档是一棵富文本树，Markdown 只是它的**序列化格式**——这点和 Typora /
 *  Obsidian 实时预览不一样，那边的文档本身就是 Markdown 源码（见
 *  docs/功能与架构设计.md §五 选型修订 3）。所以在两棵表示之间来回过一趟，
 *  顺手会动一些写法：`* 项目符号` 变 `-`、`__粗体__` 变 `**粗体**`。
 *
 *  往返前后的**树**一样，就说明一个字都没丢，只是写法被规范了 —— 这是
 *  roundTrip() 里那道闸门的判据。 */

import { InputRule, Node, mergeAttributes, type AnyExtension, type JSONContent } from '@tiptap/core'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { ListItem, TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'
import { TagRefs } from '@/editor/tagRefs'
import { Callout } from '@/editor/callout'
import { MathBlock, MathInline } from '@/editor/math'
import { FootnoteDef, FootnoteRef } from '@/editor/footnote'
import { MermaidBlock } from '@/editor/mermaidBlock'
import { Embed, 换整行嵌入 } from '@/editor/embed'
import { 停上, 移开 } from '@/editor/hoverPreview'
import { normalizeLinkKey, resolveDateRef, splitLinkInner } from '../../../shared/links'
import type { EmbedAsk, EmbedCard, OutgoingLink, PreviewAsk } from '../../../shared/types'

/** `[[x#小节]]` / `[[x^块id]]` 里那半截落点（期-05f 乙）。
 *  `同页` 为真时指的是**当前这一篇**，那一头没有 nodeKey 可开。 */
export interface LinkJump {
  anchor: string | null
  block: string | null
  samePage: boolean
}

/** 渲染进程这边给双链节点接的两根线：怎么染色、点了去哪。
 *  用注入而不是让 markdown.ts 直接 import store：store 要用 roundTrip() 做闸门，
 *  反过来再 import 就成环了。 */
export interface LinkBridge {
  /** 正文里的写法（如 `昨天`、`Kestrel 设计`）→ 落点；悬空返回 null */
  resolve(targetRaw: string): OutgoingLink | null
  /** 点链接。nodeKey 为 null 表示目标还不存在（或压根不指别处），只提示不跳。
   *  `落点` 不带就是"打开那一头"，带了还要落到那一节 / 那一段上 */
  open(nodeKey: string | null, label: string, 落点?: LinkJump): void
  /** 出链落点变了要重新染色：节点视图是裸 DOM，React 不会替它重画 */
  subscribe(cb: () => void): () => void
  /** 点正文里的 `#标签`（§6）：切到标签视图并选中它。走的是 store，不碰文档 */
  openTag(name: string): void
  /** 按住 `Ctrl` 悬停要问库的那一问（期-05d）。
   *
   *  **它是可选的，而且这是判据 7 的结构保证**：节点视图只在拿到这根线的时候才挂
   *  `mouseenter`，所以没给它的编辑器实例（幻灯片那一棵）连"弹卡"这条代码路径都不存在——
   *  不靠运行时开关，也不靠"记得在里面写个 if" */
  preview?(targetRaw: string, 显示: string): PreviewAsk | null
  /** 期-05f 丙：`![[…]]` 要的那一截正文。**与 `preview` 同一条结构保证**：节点视图只在拿到
   *  这根线的时候才去取值、才开第二棵，所以没给它的编辑器（幻灯片那一棵）压根不存在
   *  "展开嵌入"这条代码路径——不靠运行时开关，也不靠"记得在里面写个 if"（§18.5 第 3 条） */
  embed?(问: EmbedAsk): Promise<EmbedCard>
  /** 从最外层那一篇到我这一头的嵌入链（`e:12` / `t:3`）。环检测与深度上限都读它，
   *  所以**每一层新建编辑器时要把自己的落点放进去**，否则嵌套那一层看不见上面是谁 */
  嵌链?: string[]
}

/** §9.1 的四种形态：实线日记 / 双线文章 / 药丸底主题 / 虚线悬空。
 *  第五种「灰点未链接提及」是 v2 的未链接提及，这里出不来。 */
export function linkClass(hit: OutgoingLink | null): string {
  if (!hit || hit.targetType === null) return 'wl-dangling'
  if (hit.targetType === 'topic') return 'wl-topic'
  return hit.targetType === 'diary' ? 'wl-diary' : 'wl-article'
}

/** 正文里的写法 → 出链表里的那一行。
 *
 *  日期引用得先按**源记录自己的 entry_date** 换算绝对日期（见 shared/links.ts）：
 *  翻去年的日记时正文里的「昨天」指的是那一天的昨天，用 today 会查错目标，
 *  链接就会从实线掉成虚线。 */
export function resolveLink(
  outgoing: OutgoingLink[],
  targetRaw: string,
  entryDate: string
): OutgoingLink | null {
  const key = linkKey(targetRaw, entryDate)
  return key ? linkByKey(outgoing, key) : null
}

/** 写法 → 规范化查找键（与 `Link.target_raw` 同一把尺）。
 *
 *  拆出来是给悬浮预览那一问用的：悬空的写法 `resolveLink` 回 null，而卡片上那个
 *  "这个写法被写了几处"按的就是这个键。两处各算一次早晚会漂（同族教训见 §10.3）。 */
export function linkKey(targetRaw: string, entryDate: string): string {
  return resolveDateRef(targetRaw, entryDate) ?? normalizeLinkKey(targetRaw)
}

/** 按规范化查找键取落点。源码模式拿到的就是键（findLinkRanges 已经算好了），
 *  不用再过一遍日期换算 */
export function linkByKey(outgoing: OutgoingLink[], key: string): OutgoingLink | null {
  return outgoing.find((l) => l.key === key) ?? null
}

/** `[[ 目标 #锚点 |别名 ]]` → 节点属性。
 *
 *  拆不出目标的形状（`[[#小节]]`、`[[ ]]`）**也返回一份属性**，只是 target 是空的：
 *  这一串字要原样留在树上，不能不认得就没有了。返回 null 只发生在这压根不是 `[[…]]` 形状。
 *
 *  导出是给 `[[` 补全用的（期-05b）：补全选中之后落进正文的那一个节点，
 *  必须与 InputRule 那一条走同一把规范化——两处各拆一次竖线与锚点，早晚会漂。 */
export function wikiAttrs(raw: string): WikiAttrs | null {
  const inner = /^\[\[([^[\]\n]*)\]\]$/.exec(raw)?.[1]
  if (inner === undefined) return null
  const parts = splitLinkInner(inner)
  return parts
    ? {
        raw,
        target: parts.target,
        alias: parts.alias,
        anchor: parts.anchor,
        block: parts.block,
        samePage: !parts.target,
      }
    : { raw, target: '', alias: null, anchor: null, block: null, samePage: false }
}

export interface WikiAttrs {
  raw: string
  target: string
  alias: string | null
  anchor: string | null
  block: string | null
  /** 目标为空而锚点/块非空：指的是当前这一篇（`[[#小节]]`） */
  samePage: boolean
}

/** 屏幕上那一串字。认得出的用目标/别名，同页锚点用那一节的名字，都不认得就把源码原样摆出来。
 *
 *  最后那一个 `|| a.raw` 是承重的：`[[#小节]]` 这种拆不出目标的形状，
 *  以前既不成节点也不留字，整串在所见即所得里就地蒸发（期-05f §十五）。 */
export function wikiLabel(a: Partial<WikiAttrs>): string {
  return a.alias || a.target || a.anchor || a.raw || ''
}

/** `[[Kestrel 设计|这个项目]]` 在界面上显示成什么：有别名用别名，否则用目标（去掉锚点）。
 *  与 `wikiAttrs` 共用同一把拆分——两处各拆一次竖线与锚点，早晚会漂。 */
export function rawLabel(raw: string): string {
  const a = wikiAttrs(raw)
  return a ? wikiLabel(a) : raw
}

/** 双链节点：inline atom。
 *
 *  必须是真节点，不能只靠文本样式：marked 序列化时会把 `[` 转义成 `\[`，
 *  存回去就成了 `\[\[x\]\]`，链接层的解析器要的是字面 `[[`，那一篇的双链会
 *  在第一次保存时全掉，而且每存一次多一层反斜杠。做成 atom 并让
 *  renderMarkdown 逐字吐回 raw，往返才逐字节一致。 */
const WikiLink = Node.create<{ bridge: LinkBridge | null }>({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  markdownTokenName: 'wikiLink',

  addOptions() {
    return { bridge: null }
  },

  addAttributes() {
    return {
      raw: { default: '' },
      target: { default: '' },
      alias: { default: null },
      anchor: { default: null },
      // 这两样必须登记在这里：Tiptap 会把 `addAttributes` 没列出的键从节点上抹掉，
      // 于是 `samePage` 一路走到节点视图时已经是 undefined——同页锚点会被染成
      // "不是链接"，点了不动（判据 1a/1b 红过之后才看出来）
      block: { default: null },
      samePage: { default: false },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-wl]' }]
  },

  renderHTML({ HTMLAttributes }) {
    // 复制粘贴走的是 HTML 这条路，raw 得带上，否则粘出去的链接粘回来会散架
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-wl': '',
        class: 'wl wl-dangling',
        'data-key': HTMLAttributes.target,
      }),
      wikiLabel(HTMLAttributes),
    ]
  },

  addNodeView() {
    const bridge = this.options.bridge
    return ({ node }) => {
      const dom = document.createElement('span')
      const attrs = node.attrs as WikiAttrs
      const label = wikiLabel(attrs)
      const target = attrs.target
      dom.textContent = label

      let nodeKey: string | null = null
      /** 有锚点/块/同页任一样，才谈得上"落点"；光 `[[目标]]` 那种不带 */
      const 落点: LinkJump | null =
        attrs.anchor || attrs.block ? { anchor: attrs.anchor, block: attrs.block, samePage: attrs.samePage } : null
      const 跳 = 落点 ? (落点.anchor ? `，跳到「${落点.anchor}」` : 落点.block ? `，跳到那一段` : '') : ''

      const paint = (): void => {
        if (!bridge) return
        if (attrs.samePage) {
          // 指的是当前这一篇：库里没有、也不该有这一行（parseLinks 把它挡了），
          // 所以不查 resolve、不染色成悬空——它是"这一篇里的另一处地方"
          nodeKey = null
          dom.className = 'wl wl-page'
          dom.title = `跳到这一篇的「${label}」`
          return
        }
        if (!target) {
          // 甲那六种拆不出目标的形状：字要留着，但它压根不是链接，别染成"还没写"
          nodeKey = null
          dom.className = 'wl wl-plain'
          dom.title = '这一串不是链接：没拆出目标'
          return
        }
        const hit = bridge.resolve(target)
        nodeKey = hit?.nodeKey ?? null
        dom.className = `wl ${linkClass(hit)}`
        dom.title = nodeKey ? `打开「${label}」${跳}` : `「${label}」还没有创建`
      }
      paint()
      const off = bridge?.subscribe(paint)

      const onClick = (e: MouseEvent): void => {
        e.preventDefault()
        bridge?.open(nodeKey, label, 落点 ?? undefined)
      }
      dom.addEventListener('click', onClick)

      // 期-05d：按住 Ctrl 悬停弹卡。**这根线没给就一个监听都不挂**——
      // 幻灯片那一棵因此不存在"弹卡"这条代码路径，而不是在里面写了个 if 把它关掉
      const onEnter = (e: MouseEvent): void => {
        if (!e.ctrlKey) return
        const 问 = bridge?.preview?.(target, label)
        if (问) 停上(dom, 问)
      }
      const onLeave = (): void => 移开(dom)
      if (bridge?.preview) {
        dom.addEventListener('mouseenter', onEnter)
        dom.addEventListener('mouseleave', onLeave)
      }

      return {
        dom,
        update: (next) => {
          if (next.type.name !== node.type.name) return false
          if (wikiLabel(next.attrs as WikiAttrs) !== label) return false
          return true
        },
        // 分型色是 paint() 直接改 dom.className/title 上去的，ProseMirror 并不管这块 DOM。
        // 不声明忽略的话它会把这类改动当成「DOM 被外力改了」，做一次 recover：那一趟会
        // 重新序列化整篇（末尾多一个空行）并标脏落库——只是点一下链接也会写盘。
        ignoreMutation: () => true,
        destroy: () => {
          off?.()
          移开(dom)
          dom.removeEventListener('click', onClick)
          dom.removeEventListener('mouseenter', onEnter)
          dom.removeEventListener('mouseleave', onLeave)
        },
      }
    }
  },

  /** 边打边认：光标前刚好凑出 `[[…]]` 就换成链接节点。
   *  不做这一步的话，所见即所得里手打的 `[[x]]` 要等到下一次从 Markdown
   *  解析（切模式或重开这篇）才会变成链接，同一篇文档看起来前后不一致。
   *
   *  先问一句 `换整行嵌入`：那一整行是 `![[x]]` 的话这一发该落成嵌入而不是链接。
   *  问句放这里而不是给嵌入再注册一条规则，理由写在 `embed.ts` 那段头顶上（两条规则抢同一发 `]]`）。
   *  **换成了就不能回 `null`**：Tiptap 那头的判据是 `handler(...) === null || !tr.steps.length`
   *  就整发丢弃（`@tiptap/core` `run$1`），回 null 等于"我这什么都没做"，事务会被原样扔掉 */
  addInputRules() {
    return [
      new InputRule({
        find: /\[\[([^[\]\n]*)\]\]$/,
        handler: ({ state, range, match }) => {
          if (换整行嵌入(state, range, match[0])) return
          const attrs = wikiAttrs(match[0])
          if (!attrs) return null
          state.tr.replaceWith(range.from, range.to, this.type.create(attrs))
        },
      }),
    ]
  },

  markdownTokenizer: {
    name: 'wikiLink',
    level: 'inline',
    start: (src) => src.indexOf('[['),
    tokenize(src) {
      const m = /^\[\[([^[\]\n]*)\]\]/.exec(src)
      if (!m) return undefined
      return { type: 'wikiLink', raw: m[0], text: m[0] }
    },
  },

  parseMarkdown: (token, helpers) => {
    const attrs = wikiAttrs(token.raw ?? '')
    // 兜底那一支现在到不了（`[[…]]` 形状一定拆得出 attrs），留着是因为这条路上丢过一次用户的字：
    // 返回 `[]` 会让 tiptap 落进 parseFallbackToken 的 default 分支，而自定义 token 没有
    // `.tokens` ⇒ 直接 null，整串就地蒸发。谁再往这里写 `[]`，同一跤重摔一遍。
    return attrs
      ? helpers.createNode('wikiLink', attrs)
      : helpers.createTextNode(token.raw ?? '')
  },

  renderMarkdown: (node) => node.attrs?.raw ?? '',
})

const lowlight = createLowlight(common)

/** 图片 src 的渲染白名单：只认自家附件协议与 `data:image`。
 *  其余一律显占位、**不发请求**（期-04 §5.3）——离线是产品红线，`file://` 还留着
 *  本地文件存在性 oracle 的门（设计稿 A④），两条都不给。存储名的形状与主进程
 *  `assetNameFromUrl` 保持同一套：`<40 位小写十六进制>.<2~5 位小写字母后缀>`。 */
const ASSET_SRC = /^kestrel-asset:\/\/[0-9a-f]{40}\.[a-z]{2,5}$/
const DATA_IMG = /^data:image\//i

function assetLabel(src: string): string {
  if (!src) return '附件丢失'
  if (/^https?:\/\//i.test(src)) return '外链图片未加载（离线）'
  if (/^file:/i.test(src)) return '本地文件未加载（越界）'
  return '附件引用无效'
}

/** 只改渲染这一半：parse / serialize 全部沿用 Image，所以 Markdown 往返一字不动，
 *  闸门（`roundTrip` 的 `sameTree`）看不见这里的差别。拦的是「发不发请求」，不是「存不存」。 */
const GuardedImage = Image.extend({
  renderHTML({ node }) {
    const src = (node.attrs.src as string) ?? ''
    if (ASSET_SRC.test(src) || DATA_IMG.test(src)) {
      return ['img', mergeAttributes(node.attrs as Record<string, unknown>)]
    }
    const shown = src.split(/[\\/]/).filter(Boolean).pop() ?? ''
    return [
      'span',
      { class: 'asset-broken', 'data-src': src, contenteditable: 'false' },
      shown ? `${assetLabel(src)}：${shown}` : assetLabel(src),
    ]
  },
})

/** v1 要认的 Markdown 语法全在这里。StarterKit 自带粗体/标题/列表/引用/代码/分割线，
 *  另外几样要单独装：待办（TaskList）、表格（TableKit）、图片、Callout，以及期-05 的
 *  公式 / 脚注 / Mermaid。
 *
 *  **这一份同时是闸门的 schema**（下面的 `manager` 用的就是它）：新语法只要需要新节点，
 *  就必须装在这里，不然 `MarkdownManager` 解析不出那种 token、闸门与编辑器会各自看到
 *  一棵不同的树。只改渲染不改树的插件（SlashMenu / Folding / FootnoteNumbers）反过来
 *  不进门，只挂在 `RichEditor` 上。 */
export function buildExtensions(bridge: LinkBridge | null = null): AnyExtension[] {
  return [
    // #171：列表项允许「嵌入打头」。不放开的话，列表项里单独一行 `![[x]]` 当场换不成卡
    // （`落成嵌入` 问的是 `validContent([嵌入, 空段])`，那一串在 `paragraph block*` 下是否），
    // 而重载之后 markdown 解析出的树本来就是 `listItem > embed`（解析不校验内容式）——
    // 「活着时不换、重载后换」那两副样子就是这么来的。
    // `paragraph` 仍排在第一位，所以 `createAndFill` 造空项长出的还是段落，不是空壳。
    StarterKit.configure({ codeBlock: false, blockquote: false, listItem: false }),
    ListItem.extend({ content: '(paragraph|embed) block*' }),
    CodeBlockLowlight.configure({ lowlight }),
    TaskList,
    // 任务项**不跟着放开**（离线实测 `scratch/p171-off.mjs`【二】）：`- [ ] ![[x]]` 经 markdown
    // 那一条解析出来是 `taskItem>paragraph>(text,wikiLink)`——那一行从来不是嵌入。
    // 放开内容式只会让"当场换成卡、重载之后退回成一行 `!` 加链接"，那正是 #167 定的判据
    // 里最坏的一档（反向的两副样子）。任务项里认不出嵌入是**解析**那一半的缺口，另账记着。
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    GuardedImage,
    Callout,
    MathInline,
    MathBlock,
    FootnoteRef,
    FootnoteDef,
    MermaidBlock,
    WikiLink.configure({ bridge }),
    // 期-05f 丙：`装配件` / `解链` 递的是本文件这两样——embed.ts 只在类型上依赖这里，
    // 反向再 import 一次就成环了（§18.4 第 1 条：这一支**必须**装进这一份 schema，
    // 只挂在编辑器上而漏在这里 = 闸门那一棵没有这个节点类型 = 它吃字）
    Embed.configure({ 桥: bridge, 装配件: buildExtensions, 解链: resolveLink }),
    TagRefs.configure({ openTag: bridge ? (name) => bridge.openTag(name) : null }),
    Markdown.configure({ indentation: { style: 'space', size: 2 } }),
  ]
}

/** 闸门用的管理器：只做解析与序列化，不画界面，所以不带 bridge */
const manager = new MarkdownManager({
  extensions: buildExtensions(),
  indentation: { style: 'space', size: 2 },
})

export interface RoundTrip {
  /** 重新序列化出来的 Markdown。无损时这才是切过去以后会存进去的内容 */
  out: string
  /** 树没变 ⇒ 只是写法被规范，一个字没丢 */
  lossless: boolean
  /** 规范化的说明（人话），没有就空 */
  notes: string[]
  /** 拦住时：到底会丢什么 */
  lost: string[]
}

/** 「只是写法被规范了」的说明。判据是同一个特征在改前改后各出现几次，
 *  差出来的那几次就是被规范掉的。用差值而不是逐行 diff：代码块里的 `* 星号`
 *  两边都算一次，自然抵消，不会误报。 */
const NORMALIZED: { re: RegExp; label: string }[] = [
  { re: /^[ \t]{0,3}[*+][ \t]+/gm, label: '项目符号统一为 -' },
  { re: /^[ \t]{0,3}\d+\)[ \t]+/gm, label: '有序编号统一为 1.' },
  { re: /__[^_\n]+__/g, label: '下划线粗体改为 **' },
  { re: /_[^_\n]+_/g, label: '下划线斜体改为 *' },
  { re: /^[ \t]{0,3}~{3,}/gm, label: '波浪线围栏改为 ```' },
]

/** 带样式或事件属性的 HTML 标签。富文本树里没有「样式」也没有「事件」这个位置：
 *  `<span style="color:red">` 被拆开只留文字，树的形状一点没变，所以「树相等」这条
 *  判据看不见它——但它是真丢东西，而且切过去时原文会被就地改写，style 再也回不来。
 *  `onclick` / `onerror` 这类事件属性同一栏，理由一样。所以单独查一遍、单独拦住。
 *  只认 style/class/id/on*：`<a href>`、`<img src>` 这些是 Markdown 本身能表达的，不算丢。 */
const STYLE_ATTR = /<[a-zA-Z][^>]*\s(?:style|class|id|on[a-z]+)\s*=/g

/** schema 认得的标签：round-trip 之后要么原样回、要么等价改写，不算丢。名单外的标签
 *  （`<svg>` / `<math>` / `<iframe>` / 用户自己写的自定义元素）会被 `parse(md)` 整块吃光，
 *  `parse(serialize(tree))` 自然也吃光——两棵树相等、Gate 报「无损」，但用户手写的东西
 *  在切 rich 之后确实消失了（2026-09-22 的 A③ 实测：`<p onmouseover>悬停</p>` +
 *  `<svg onload>...</svg>` + `<math>...</math>` 一篇 → Gate 放行 → 落库变成 `悬停` 加
 *  几行 escaped text）。这一栏就是补上那个口子：只要 md 里出现过名单外的标签，就拦。
 *  代码围栏里的 `<circle>` 这类两边都算一次，自然抵消，不误报。 */
const KNOWN_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'samp', 'small',
  'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'var',
])
const TAG_PATTERN = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/g

/** md 里出现了但 out 里没有的、schema 不认的标签名（含次数）。差分而不是绝对计数：
 *  代码围栏里的 `<circle>` 两边都数一次，diff = 0，不误报。 */
function diffUnknownTags(md: string, out: string): { n: number; names: string[] } {
  const before = new Map<string, number>()
  for (const m of md.matchAll(TAG_PATTERN)) {
    const tag = m[2].toLowerCase()
    if (KNOWN_TAGS.has(tag)) continue
    before.set(tag, (before.get(tag) ?? 0) + 1)
  }
  const after = new Map<string, number>()
  for (const m of out.matchAll(TAG_PATTERN)) {
    const tag = m[2].toLowerCase()
    if (KNOWN_TAGS.has(tag)) continue
    after.set(tag, (after.get(tag) ?? 0) + 1)
  }
  let n = 0
  const names: string[] = []
  for (const [tag, cnt] of before) {
    const lost = cnt - (after.get(tag) ?? 0)
    if (lost > 0) {
      n += lost
      names.push(`<${tag}>`)
    }
  }
  return { n, names }
}

const TYPE_NAMES: Record<string, string> = {
  paragraph: '段落',
  heading: '标题',
  codeBlock: '代码块',
  blockquote: '引用',
  bulletList: '无序列表',
  orderedList: '有序列表',
  taskList: '待办列表',
  taskItem: '待办项',
  table: '表格',
  tableRow: '表格行',
  tableCell: '单元格',
  image: '图片',
  horizontalRule: '分隔线',
  hardBreak: '强制换行',
  wikiLink: '双链',
  embed: '嵌入',
  code: '行内代码',
  text: '文字',
}

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0
}

/** 数正文里指向 `file://` 的图片（期-04 §10 第 ④ 项）。先摘掉围栏与行内代码：
 *  用户在代码块里写一段 `![示例](file:///…)` 当文档，那是字面文本、不是要渲染的图。
 *  用绝对存在性判据而不是 md 减 out：Image 会把 file:// 原样往返，两棵树相等、`sameTree`
 *  看不出问题，但这张图根本不该进非源码视图——所以要拦在树相等之前。 */
function countFileImages(md: string): number {
  const bare = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
  return (
    countMatches(bare, /!\[[^\]]*\]\(\s*<?file:/gi) +
    countMatches(bare, /<img\b[^>]*\ssrc\s*=\s*["']?file:/gi)
  )
}

/** 比树时先抹掉的属性。`target`/`rel` 是 Link 扩展给裸 `<a>` 补的默认值，
 *  Markdown 里根本没有写法能表达它，也不是用户写进去的内容；`class`/`style`/`id`
 *  另有 STYLE_ATTR 那一关拦住，放行这里不会悄没声地丢东西。
 *  除此之外的字段（正文、标题层级、代码语言、待办勾选、单元格对齐）都逐字比。 */
const IGNORED_ATTRS = new Set(['target', 'rel', 'class', 'id', 'style'])

function sameAttrs(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  for (const key of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    if (IGNORED_ATTRS.has(key)) continue
    if ((a?.[key] ?? null) !== (b?.[key] ?? null)) return false
  }
  return true
}

/** 树相等。手写深比而不是 `JSON.stringify` 对拍：stringify 受键序影响，
 *  同一棵树只是 `marks` 排在 `text` 前面就会被判成不一样（parseHTML 出来的节点
 *  正是这个键序），那是纯误报。 */
function sameTree(a: JSONContent, b: JSONContent): boolean {
  if (a.type !== b.type || a.text !== b.text) return false
  if (!sameAttrs(a.attrs, b.attrs)) return false

  const am = a.marks ?? []
  const bm = b.marks ?? []
  if (am.length !== bm.length) return false
  if (!am.every((m, i) => m.type === bm[i].type && sameAttrs(m.attrs, bm[i].attrs))) return false

  const ac = a.content ?? []
  const bc = b.content ?? []
  if (ac.length !== bc.length) return false
  return ac.every((child, i) => sameTree(child, bc[i]))
}

function tally(node: JSONContent, acc: Record<string, number>): void {
  if (node.type) acc[node.type] = (acc[node.type] ?? 0) + 1
  for (const child of node.content ?? []) tally(child, acc)
}

function textLength(node: JSONContent): number {
  let n = node.text?.length ?? 0
  for (const child of node.content ?? []) n += textLength(child)
  return n
}

/** 会丢什么。只说「少了」，不说「多了」：表格散成段落时多出来的是段落，
 *  报出来只会让人以为多得了什么。 */
function describeLoss(before: JSONContent, after: JSONContent): string[] {
  const a: Record<string, number> = {}
  const b: Record<string, number> = {}
  tally(before, a)
  tally(after, b)

  const out: string[] = []
  for (const [type, n] of Object.entries(a)) {
    const lost = n - (b[type] ?? 0)
    if (lost > 0) out.push(`${TYPE_NAMES[type] ?? type}（${lost} 处）`)
  }
  const chars = textLength(before) - textLength(after)
  if (chars > 0) out.push(`文字少了 ${chars} 字`)
  return out.length ? out : ['内容对不上']
}

/** `[[…]]` 的形状，与 `findLinkRanges` 那一条同一个写法（不认代码区：md 与 out 两边
 *  各算一次，代码块里的那些自然抵消）。
 *
 *  数的是**个数**，与 STYLE_ATTR / diffUnknownTags 同族——都是「parse 一上来就吃光、
 *  两棵树相等」那一类的第三道口子，期-05f §十五 撞出来的：`[[#小节]]` 拆不出目标，
 *  旧代码让它返回空数组，于是整串字在树上根本不存在，闸门一路绿灯，落库少了六个字。 */
const WIKI_SPAN = /\[\[[^[\]\n]*\]\]/g

/** 把 Markdown 过一遍「解析 → 序列化 → 再解析」，报告这一趟到底动了什么。
 *
 *  无损的判据是**树**相等，不是文本逐字节相等。逐字节相等的判据会把
 *  `* 项目符号`、`__粗体__` 全判成有损，那等于永远进不了所见即所得
 *  （实测见 scratch/md-spike.mjs）。树相等之外还有三个口子：样式属性（STYLE_ATTR）、
 *  未识别标签（diffUnknownTags）、被吃光的 `[[…]]`（WIKI_SPAN）——三个都是
 *  「parse 一上来就吃光、树看不出差别」的那一类。 */
export function roundTrip(md: string): RoundTrip {
  const tree = manager.parse(md)
  const out = manager.serialize(tree)
  // file:// 图片：即便树能原样往返也照样拦——它压根不该出现在非源码视图里（§10 第 ④ 项）
  const fileImg = countFileImages(md)
  if (fileImg > 0) {
    return { out, lossless: false, notes: [], lost: [`${fileImg} 处本地文件图片（file://）`] }
  }
  if (out === md) return { out, lossless: true, notes: [], lost: [] }

  const again = manager.parse(out)
  const lossless = sameTree(tree, again)
  const styles = countMatches(md, STYLE_ATTR) - countMatches(out, STYLE_ATTR)
  const tags = diffUnknownTags(md, out)
  const htmlLost: string[] = []
  if (styles > 0) htmlLost.push(`${styles} 处 HTML 属性（style/class/on*）`)
  if (tags.n > 0) htmlLost.push(`${tags.n} 处 HTML 标签：${tags.names.join(' ')}`)
  const eaten = countMatches(md, WIKI_SPAN) - countMatches(out, WIKI_SPAN)
  if (eaten > 0) htmlLost.push(`${eaten} 处 [[…]] 没能原样出来`)
  if (!lossless) {
    const lost = describeLoss(tree, again)
    return { out, lossless: false, notes: [], lost: [...htmlLost, ...lost] }
  }
  if (htmlLost.length) {
    return { out, lossless: false, notes: [], lost: htmlLost }
  }

  const notes = NORMALIZED.map(({ re, label }) => ({
    n: countMatches(md, re) - countMatches(out, re),
    label,
  }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} 处${x.label}`)
  // 有改动却一条都对不上（比如表格分隔行被补齐），别装作什么都没发生
  return { out, lossless: true, notes: notes.length ? notes : ['排版细节被重排'], lost: [] }
}