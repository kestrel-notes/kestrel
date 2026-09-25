/** 单篇离线分享：把**当前这一格已经画好的那棵 DOM** 洗成一个能双击打开的 .html。
 *
 *  为什么走"拍 DOM"而不是 `editor.getHTML()`：公式、Mermaid、代码高亮、双链的颜色、`#标签`、
 *  脚注那一枚编号、查询块的结果——这七样全活在 NodeView 与装饰插件里，schema 的
 *  `renderHTML` 一样都带不出来（设计稿 §〇 M2 那张表逐条给了行号）。
 *  **这不是两种导出风格，是一种能看、一种不能看。**（决策 79）
 *
 *  代价也在这儿付清楚：拍下来的是编辑器的内脏，`contenteditable`、六颗按钮、
 *  十一处 `ProseMirror-widget` 全跟着来了 ⇒ 中间那道清理（`shared/shareFormat.ts` 的 `洗那棵`）
 *  才是本期最大的一块。判据全在 shared 那一层离线问遍，这里只负责取原料。
 *
 *  样式是**从 CSSOM 现抽的**那一份（决策 81）：手抄一份 share.css 是必然漂移的做法
 *  （#77、#128 那几次都是同一族错）。抽的时候伪元素先剥再判，脚注那一枚编号才带得走。 */

import katex from 'katex'
import { getRichEditor } from '@/editor/richView'
import { useStore } from '@/store'
import { formatDateZh } from '../../shared/date'
import type { ShareAsset } from '../../shared/types'
import {
  换公式,
  换附件,
  落双链,
  洗那棵,
  用到的属性,
  钉查询,
  挑规则,
  变量名,
  变量不许,
  超限,
  骨架,
  转义,
  分享文件名,
  type 式,
  type 规则,
} from '../../shared/shareFormat'

export interface 分享的账 {
  file: string
  bytes: number
  ms: number
  名字改了: boolean
  内联: number
  缺图: string[]
  公式: number
  双链: number
  悬空: number
  查询块: number
  清掉的: Record<string, number>
  样式: { 规则数: number; KB: number; 变量数: number }
}

/** 本地时刻，到分。界面上、产物里、查询块那句「数截止于」用的是同一个格式与同一个数 */
export function 本地时刻(d: Date = new Date()): string {
  const 补 = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${补(d.getMonth() + 1)}-${补(d.getDate())} ${补(d.getHours())}:${补(d.getMinutes())}`
}

/** 按**文档顺序**把式子收齐。快照里 `.md-math` 那个 NodeView 的 DOM 上不带 `data-tex`
 *  （那是 schema 那条路才写的属性，实测 0 处），所以只能靠顺序对——`换公式` 那边对不上就抛。 */
function 收公式(): 式[] {
  const 编辑器 = getRichEditor()
  const 出: 式[] = []
  编辑器?.state.doc.descendants((n) => {
    if (n.type.name !== 'mathInline' && n.type.name !== 'mathBlock') return true
    const tex = typeof n.attrs.tex === 'string' ? n.attrs.tex : ''
    if (!tex.trim()) {
      出.push({ tex, mathml: '<span class="s-tex">（空公式）</span>' })
      return true
    }
    出.push({
      tex,
      mathml: katex.renderToString(tex, {
        output: 'mathml',
        throwOnError: false,
        displayMode: n.type.name === 'mathBlock',
      }),
    })
    return true
  })
  return 出
}

/** 把一棵 CSSOM 摊平成 `{选择器, 声明, 条件}`。`@font-face` 与 keyframes 直接跳过：
 *  字体那 1 MB 不带（决策 83），而 `@font-face` 是那一 MB 的入口。 */
function 摊平(表: CSSStyleSheet): 规则[] {
  const 出: 规则[] = []
  const 走 = (规则们: CSSRuleList, 条件: string | undefined): void => {
    for (const r of 规则们) {
      if (r instanceof CSSStyleRule) 出.push({ 选择器: r.selectorText, 声明: r.style.cssText, 条件 })
      else if (r instanceof CSSMediaRule) 走(r.cssRules, r.conditionText)
      else if (r instanceof CSSSupportsRule) 走(r.cssRules, `(supports(${r.conditionText}))`)
    }
  }
  try {
    走(表.cssRules, undefined)
  } catch {
    return []
  }
  return 出
}

/** 那棵上出现过的 token：类名、标签名、属性名。用来判一条规则要不要带走。
 *  这是**往宽了判**的：多带进来的那几条在产物里也匹配不到东西，是无害的；
 *  漏一条就是"样式凭空少一块"，那种错不会报错，只会让人看见一份丑文件。 */
function 有的东西(根: HTMLElement): { 类: Set<string>; 标签: Set<string>; 属性: Set<string> } {
  const 类 = new Set<string>()
  const 标签 = new Set<string>()
  const 属性 = new Set<string>()
  const 看 = (el: Element): void => {
    标签.add(el.tagName.toLowerCase())
    for (const c of el.classList) 类.add(c)
    for (const a of el.getAttributeNames()) 属性.add(a)
  }
  看(根)
  for (const el of 根.querySelectorAll('*')) 看(el)
  return { 类, 标签, 属性 }
}

/** 挑规则那一刀用的"能配"。注意传进来的选择器已经过了 `剥伪`（伪元素剥掉了） */
function 能配者(有: { 类: Set<string>; 标签: Set<string>; 属性: Set<string> }): (s: string) => boolean {
  return (选择器: string): boolean => {
    for (const m of 选择器.matchAll(/\.([\w-]+)/g)) if (!有.类.has(m[1])) return false
    for (const m of 选择器.matchAll(/\[([\w-]+)/g)) if (!有.属性.has(m[1].toLowerCase())) return false
    // 标签名只看那几段复合选择器里出现的最左一个：`p.md-prose` 里 p 是真要求，
    // 而 `.md-prose p` 里的 p 也是——两边都过这一个判据，判宽了不影响正确性
    for (const 段 of 选择器.split(/[\s>+~]+/)) {
      const m = /^(b|blockquote|br|code|col|div|em|h[1-6]|hr|i|li|ol|p|pre|s|span|strong|sub|sup|table|tbody|td|tfoot|th|thead|tr|ul|a|img|input|label)\b/.exec(
        段
      )
      if (m && !有.标签.has(m[1])) return false
    }
    return true
  }
}

/** 当前生效的那一套自定义属性。名单从"定义了 `--x` 的那些规则"里来（`:root` 与
 *  `[data-theme=…]`），值一律现读 `getComputedStyle(对着)`——读到的是**这一台机器这一会儿**
 *  那一份，主题切到 midnight 导出的就是 midnight。
 *
 *  `对着` 必须是主题那一条链**下面**的元素：`data-theme` 挂在 `<body>` 上
 *  （`App.tsx:44` 那一句 `document.body.dataset.theme = theme`），读 `documentElement`
 *  量到的是没有主题的裸 `:root`——颜色那一批全是空串，`if (v && …)` 一声不响地把它们丢掉，
 *  产物就成了白底黑字的壳（2026-09-25 实机量到的正是这一种：19 个变量里没有一个 bg 或 text）。 */
function 现变量(全部规则: 规则[], 对着: HTMLElement): { 变量: Record<string, string>; 配色: 'light' | 'dark' } {
  const 名 = new Set<string>()
  for (const r of 全部规则) if (/^:root|^\[data-theme|\s,?\s?:root/.test(r.选择器)) for (const n of 变量名(r.声明)) 名.add(n)
  const cs = getComputedStyle(对着)
  const 变量: Record<string, string> = {}
  for (const n of 名) {
    const v = cs.getPropertyValue(n).trim()
    if (v && !变量不许(v)) 变量[n] = v
  }
  const scheme = cs.colorScheme
  return { 变量, 配色: scheme === 'dark' ? 'dark' : 'light' }
}

/** 取一份附件的字节（主进程那一条通道只认闭集的 sha1 名字，路径给不出去） */
async function 取附件(名: string): Promise<ShareAsset> {
  try {
    return await window.kestrel.share.asset(名)
  } catch (e) {
    return { name: 名, bytes: 0, data: null, note: e instanceof Error ? e.message : String(e) }
  }
}

/** 全流程。`目录` 只能来自 `transfer.pickDirectory('share')` 那一次系统对话框。
 *  任何一步不过关都**抛**，且抛在人话这一档——半份文件比没有文件更坏。 */
export async function 导出去(目录: string): Promise<分享的账> {
  const s = useStore.getState()
  const 编辑器 = getRichEditor()
  if (!编辑器) throw new Error('这一篇现在没有画在屏幕上：先切回所见即所得（Ctrl+Shift+M）再分享')
  if (s.editorMode === 'source')
    throw new Error(
      '源码模式那一档没有"已经画好的那棵树"可拍。切回所见即所得（Ctrl+Shift+M）再分享——公式、图、查询结果都是那一档才渲出来的'
    )
  const 根 = 编辑器.view.dom as HTMLElement

  /* 一、样式：先抽（对着未洗的那棵活 DOM 量，属性全在） */
  const 全部 = [...document.styleSheets].flatMap((x) => (x instanceof CSSStyleSheet ? 摊平(x) : []))
  if (全部.length === 0)
    throw new Error('读不到应用自己的样式表（CSSOM 是空的）——导出来的那一份会没有样子，不如不导')
  const 现 = 现变量(全部, 根)
  const 命中的 = 挑规则(全部, 能配者(有的东西(根)), ['.md-prose', '.asset-broken'])
  const 留 = 用到的属性(命中的.css)

  /* 二、拍 */
  const 快照 = 根.innerHTML

  /* 三、附件：先把要内联的字节取回来，超线就在这里拦住，一份文件都不写 */
  const 名单 = [...new Set([...快照.matchAll(/kestrel-asset:\/\/([^"'?\s#]+)/g)].map((m) => m[1]))]
  const 取回 = await Promise.all(名单.map(取附件))
  const 那句 = 超限(取回.map((z) => ({ 名字: z.name, 字节: z.bytes })))
  if (那句) throw new Error(那句)
  const 表: Record<string, string> = {}
  for (const z of 取回) if (z.data) 表[z.name] = z.data

  /* 四、洗（顺序是有讲究的：先换得走内容的，最后再做那遍总清理） */
  const 式子 = 收公式()
  const 换完公式 = 换公式(快照, 式子)
  const 换完附件 = 换附件(换完公式.正文, 表)
  const 落了链 = 落双链(换完附件.正文)
  const 钉了 = 钉查询(落了链.正文, 本地时刻())
  const 洗 = 洗那棵(钉了.正文, 留)

  /* 五、装进骨架，交给主进程落盘（它落盘前自己再跑一遍自检） */
  const 标题 = (s.title ?? '').trim() || (s.entry ? formatDateZh(s.entry.entryDate) : '未命名')
  const html = 骨架({
    标题,
    css: 命中的.css,
    变量: 现.变量,
    正文: 洗.正文,
    时刻: 本地时刻(),
    主题: s.settings.theme,
    配色: 现.配色,
    内联张数: 换完附件.内联,
    // rem 那把尺的零点。抽走的样式表里全是 rem，不带这一句的话「我调到 18 那一档」
    // 分享出去就成了「别人看到 16 那一档」——现读根元素，而不是抄 settings 里那个数：
    // 片段（09b）里真有人写 `html{font-size:…}`，那一条也得跟着进产物
    根字号: getComputedStyle(document.documentElement).fontSize,
  })
  const r = await window.kestrel.share.write(目录, 标题, html)
  return {
    file: r.file,
    bytes: r.bytes,
    ms: r.ms,
    名字改了: r.renamed,
    内联: 换完附件.内联,
    缺图: 换完附件.缺失,
    公式: 换完公式.数,
    双链: 落了链.条数,
    悬空: 落了链.悬空,
    查询块: 钉了.块数,
    清掉的: 洗.清掉的,
    样式: {
      规则数: 命中的.命中数,
      KB: +(命中的.css.length / 1024).toFixed(1),
      变量数: Object.keys(现.变量).length,
    },
  }
}

/** 界面上那一行「会写成什么名字」。真名字由主进程定（撞车要接 `·2`），这里只是先给人看一眼 */
export function 会叫这个名字(标题: string): string {
  return 分享文件名(标题)
}

/** 给预览用：把标题那一句转义好（界面上直接插 HTML 的那几处一个都不许有） */
export function 那一句(标题: string): string {
  return `这会写出一个文件，里面是《${转义(标题 || '未命名')}》的全部内容`
}
