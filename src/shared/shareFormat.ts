/** 单篇离线分享（期-11a）的全部**判定**：把编辑器里那棵已经画好的 DOM 洗成一份能寄给别人的 HTML。
 *
 *  为什么这一层不带 DOM：导出这一路最贵的三条红线——产物里不许有脚本、不许有外链、
 *  不许有本机路径——全部发生在**落盘之前**，而它们必须能在离线套件里被逐条问遍
 *  （`scratch/p11-share-test.mjs`），不能等真机碰运气。理由与 `backupFormat.ts`、
 *  `syncFormat.ts` 同一件：**出网与不可逆的判据不归实机验，归离线那套。**
 *  代价是这里不能用 `DOMParser`，得自带一个够用的 HTML 扫描器（`切元`）。它只需要吃下
 *  应用自己渲染出来的那一种 HTML（`innerHTML` 的产物：属性值都过了转义、文本都过了实体化），
 *  不需要吃下人手写的脏 HTML——那一条由 `自检()` 在落盘前兜住。
 *
 *  `<svg>` 与 `<style>` 整块**不透明**（原样搬走，见 `切元`）：mermaid 那份 SVG 的 `<style>`、
 *  `id`、`data-look`、`filter: url(#…)` 是一整套自洽的东西，动一处就碎。风险由 `自检()`
 *  覆盖全文兜住（它扫的是整串文本，包括 SVG 与 style 里面）。 */

import { safeName } from './exportFormat'

/* ───────────────────────── 扫描：HTML → 元 ───────────────────────── */

type 属 = { 名: string; 值: string | null }
type 开 = { 类: '开'; 名: string; 属性: 属[]; 自闭: boolean }
type 元 = 开 | { 类: '闭'; 名: string; 原文: string } | { 类: '块'; 原文: string }

/** 这些标签里头是**原始文本**（CSS / 占位文字），不能当 HTML 解析：
 *  `<style>` 里一个 `a > b` 就够把只按 `>` 收尾的扫描器带沟里。`svg` 同等待遇（见文件头）。 */
const 原样标签 = new Set(['style', 'script', 'textarea', 'title', 'svg'])

const 名文 = /^[a-zA-Z][^\s/>=]*/

/** 从 `<` 开始找这个标签的结束（引号里的 `>` 不算）。返回闭合 `>` 之后那一位，找不到 -1 */
function 标签结束(html: string, 起: number): number {
  let 引 = ''
  for (let i = 起 + 1; i < html.length; i++) {
    const c = html[i]
    if (引) {
      if (c === 引) 引 = ''
      continue
    }
    if (c === '"' || c === "'") 引 = c
    else if (c === '>') return i + 1
  }
  return -1
}

/** 从 起 往后找到这一层同名标签闭合的位置（嵌套的配掉）。返回闭合 `>` 之后那一位，找不到 -1 */
function 跳配对(html: string, 名: string, 起: number): number {
  let 深 = 1
  let i = 起
  while (i < html.length) {
    const 下 = html.indexOf('<', i)
    if (下 < 0) return -1
    const 闭前缀 = `</${名}`
    if (html.startsWith(闭前缀, 下) && !/[^\s/>]/.test(html[下 + 闭前缀.length] ?? '')) {
      const 收 = html.indexOf('>', 下)
      if (收 < 0) return -1
      深--
      if (深 === 0) return 收 + 1
      i = 收 + 1
      continue
    }
    const m = 名文.exec(html.slice(下 + 1, 下 + 40))
    if (m && m[0].toLowerCase() === 名) {
      const 收 = 标签结束(html, 下)
      if (收 < 0) return -1
      if (!html.slice(下, 收).endsWith('/>')) 深++
      i = 收
      continue
    }
    const 收 = 标签结束(html, 下)
    i = 收 < 0 ? 下 + 1 : 收
  }
  return -1
}

function 解析属性(串: string): 属[] {
  const 出: 属[] = []
  const re = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(串))) {
    const 值 = m[2]
    出.push({ 名: m[1].toLowerCase(), 值: 值 === undefined ? null : 值.slice(1, -1) })
  }
  return 出
}

/** HTML 串 → 元列表。`块` 是「原样搬走」的一段（文本、注释、doctype、SVG、`<style>…</style>`），
 *  不参与改写；`改写` 见到它只往输出里贴。 */
export function 切元(html: string): 元[] {
  /** 传进来的是对象（忘了 `.正文`）时不能静默给出空串：那会产出一份**空白的**分享文件，
   *  而 `自检` 对空串是全过的。离线套件第一跑就撞在这上面。 */
  if (typeof html !== 'string') throw new TypeError(`要的是 HTML 字符串，拿到的是 ${typeof html}`)
  const 元组: 元[] = []
  let i = 0
  while (i < html.length) {
    const 开 = html.indexOf('<', i)
    if (开 < 0) {
      if (i < html.length) 元组.push({ 类: '块', 原文: html.slice(i) })
      break
    }
    if (开 > i) 元组.push({ 类: '块', 原文: html.slice(i, 开) })
    if (html.startsWith('<!--', 开)) {
      const 收 = html.indexOf('-->', 开)
      const 末 = 收 < 0 ? html.length : 收 + 3
      元组.push({ 类: '块', 原文: html.slice(开, 末) })
      i = 末
      continue
    }
    if (html.startsWith('</', 开)) {
      const 收 = html.indexOf('>', 开)
      const 末 = 收 < 0 ? html.length : 收 + 1
      const m = 名文.exec(html.slice(开 + 2))
      元组.push({ 类: '闭', 名: (m?.[0] ?? '').toLowerCase(), 原文: html.slice(开, 末) })
      i = 末
      continue
    }
    const m = 名文.exec(html.slice(开 + 1))
    if (!m) {
      const 收 = html.indexOf('>', 开)
      const 末 = 收 < 0 ? html.length : 收 + 1
      元组.push({ 类: '块', 原文: html.slice(开, 末) })
      i = 末
      continue
    }
    const 名 = m[0].toLowerCase()
    const 末 = 标签结束(html, 开)
    if (末 < 0) {
      元组.push({ 类: '块', 原文: html.slice(开) })
      break
    }
    const 原文 = html.slice(开, 末)
    const 自闭 = 原文.endsWith('/>')
    if (!自闭 && 原样标签.has(名)) {
      // 连开带闭整段当一块搬走：里面的 `<x>` 不是标签，id/data-* 也不许动
      const 结 = 跳配对(html, 名, 末)
      元组.push({ 类: '块', 原文: html.slice(开, 结 < 0 ? html.length : 结) })
      i = 结 < 0 ? html.length : 结
      continue
    }
    元组.push({
      类: '开',
      名,
      属性: 解析属性(原文.slice(名.length + 1, 自闭 ? -2 : -1)),
      自闭,
    })
    i = 末
  }
  return 元组
}

function 序列化(名: string, 属性: 属[], 自闭: boolean): string {
  let s = `<${名}`
  for (const a of 属性) s += a.值 === null ? ` ${a.名}` : ` ${a.名}="${a.值}"`
  return `${s}${自闭 ? ' /' : ''}>`
}

function 取(属性: 属[], 名: string): string | null {
  for (const a of 属性) if (a.名 === 名) return a.值 ?? ''
  return null
}

function 类了(属性: 属[], ...名: string[]): boolean {
  const c = 取(属性, 'class')
  if (!c) return false
  const 有 = new Set(c.split(/\s+/).filter(Boolean))
  return 名.some((n) => 有.has(n))
}

/** 把 class 里指定的几个标记拿掉（其余原样），必要时补上新的。拿空了就整枚属性删掉 */
function 改类(属性: 属[], 删: (类名: string) => boolean, 加: string[] = []): 属[] {
  const 原 = (取(属性, 'class') ?? '').split(/\s+/).filter(Boolean)
  const 新 = [...new Set([...原.filter((c) => !删(c)), ...加])]
  if (新.length === 0) return 属性.filter((a) => a.名 !== 'class')
  return 属性.map((a) => (a.名 === 'class' ? { ...a, 值: 新.join(' ') } : a))
}

/** 编辑面才有的类名。留着它们要么没意义，要么**把内容印没了**：`fold-hide` 是
 *  `display:none !important`（app.css:894），`collapsed` 是提示块收起来那一档（app.css:986）。
 *  一份没有 JS 的产物里，这两样是静默的内容损失。ProseMirror 自己挂的那一批在
 *  `是编辑类` 里按前缀整族拿掉。 */
const 编辑类 = ['fold-hide', 'collapsed', 'md-reading']

/** 这枚类是不是编辑面才有的 */
function 是编辑类(名: string): boolean {
  return 编辑类.includes(名) || 名.startsWith('ProseMirror-')
}

/** 这一棵上挂了几枚编辑面的类（>0 就要动 class 属性） */
function 类名单(属性: 属[], 判: (类名: string) => boolean): number {
  return (取(属性, 'class') ?? '').split(/\s+/).filter(Boolean).filter(判).length
}

export function 转义(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/* ───────────────────────── 改写引擎 ───────────────────────── */

type 动作 =
  | { 做: '保留'; 名?: string; 属性?: 属[] }
  | { 做: '拆壳' }
  | { 做: '删整块' }
  | { 做: '换成'; 文: string }

type 处理 = (元: 开, 栈: 开[]) => 动作 | undefined

function 配对表(元组: 元[]): Map<number, number> {
  const 出 = new Map<number, number>()
  const 栈: { i: number; 名: string }[] = []
  元组.forEach((t, i) => {
    if (t.类 === '开' && !t.自闭) 栈.push({ i, 名: t.名 })
    else if (t.类 === '闭') {
      for (let k = 栈.length - 1; k >= 0; k--)
        if (栈[k].名 === t.名) {
          出.set(栈[k].i, i)
          栈.length = k
          return
        }
      // 对不上的闭合（畸形输入）不在这儿抛——`自检()` 的平衡判据才是拦它的地方
    }
  })
  return 出
}

/** 逐元改写。返回洗过的那一串 + 每类动作各动了多少次 */
function 改写(html: string, 处理: 处理): { 正文: string; 计数: Record<string, number> } {
  const 元组 = 切元(html)
  const 对 = 配对表(元组)
  const 计数: Record<string, number> = {}
  const 增 = (k: string): void => {
    计数[k] = (计数[k] ?? 0) + 1
  }
  const 丢闭 = new Set<number>()
  let 出 = ''
  let 跳 = -1
  const 栈: { 元: 开; 末: number }[] = []
  for (let i = 0; i < 元组.length; i++) {
    if (i < 跳) continue
    while (栈.length && 栈[栈.length - 1].末 <= i) 栈.pop()
    const t = 元组[i]
    if (t.类 === '块') {
      出 += t.原文
      continue
    }
    if (t.类 === '闭') {
      if (!丢闭.has(i)) 出 += t.原文
      continue
    }
    const 末 = 对.get(i) ?? i
    const 动 = 处理(t, 栈.map((s) => s.元))
    if (!动 || 动.做 === '保留') {
      出 += 序列化(动?.名 ?? t.名, 动?.属性 ?? t.属性, t.自闭)
      if (!t.自闭) 栈.push({ 元: { ...t, 名: 动?.名 ?? t.名 }, 末 })
      continue
    }
    if (动.做 === '删整块') {
      增('删整块')
      跳 = 末 + 1
      continue
    }
    if (动.做 === '换成') {
      增('换成')
      出 += 动.文
      跳 = 末 + 1
      continue
    }
    增('拆壳')
    if (!t.自闭) {
      丢闭.add(末)
      栈.push({ 元: t, 末 })
    }
  }
  return { 正文: 出, 计数 }
}

/* ───────────────────────── 一、洗完才算导出（设计稿 §三） ───────────────────────── */

/** 编辑面才有的属性。`title` 一律拿掉：实测真快照那 21 处没有一处是内容，全是
 *  「折叠本节」「打开「X」」「Ctrl+点击筛出带它的记录」这种**只在应用里做得到的事**
 *  （`scratch/p11-audit2.mjs` 列的全清单）。 */
const 编辑属性 = [
  'contenteditable',
  'draggable',
  'title',
  'tabindex',
  'accesskey',
  'spellcheck',
  'autocorrect',
]

/** 拿不准就留的 data-*。`data-n` 是脚注那一枚编号（CSS 用 `content:attr(data-n)` 画它），
 *  `data-checked`/`data-type` 是任务列表的形状，`data-tex` 是这一期自己写进去的原 TEX。
 *  其余按 `用到的属性(抽出来的 CSS)` 动态放行——不在这里抄第二份名单。 */
const 默认留 = ['data-n', 'data-checked', 'data-type', 'data-callout', 'data-title', 'data-tex', 'data-fn']

export interface 洗后 {
  正文: string
  清掉的: Record<string, number>
}

/** §三 那张清单，逐条给去处。`额外留` 传抽 CSS 时命中过的 `data-*`：那些规则要落到产物里，
 *  对应的属性删掉了规则就悬空（脚注编号、任务列表都靠这一条活下来）。 */
export function 洗那棵(html: string, 额外留: string[] = []): 洗后 {
  const 留 = new Set([...默认留, ...额外留])
  const 计数: Record<string, number> = {}
  const 增 = (k: string): void => {
    计数[k] = (计数[k] ?? 0) + 1
  }
  const { 正文 } = 改写(html, (元, 栈) => {
    const { 名, 属性 } = 元
    /* 1. 折叠那颗三角：连字形一起走。它在离线页里既点不动，又冒充「这里可以折叠」 */
    if (名 === 'span' && 类了(属性, 'fold-chev')) {
      增('折叠标记')
      return { 做: '删整块' }
    }
    /* 2. 任务列表那份视觉隐藏的 a11y 文字。它是替一颗**可点的**勾准备的标签，
          勾点不动之后就只剩一串读不到、还占着 DOM 的英文 */
    const style = 取(属性, 'style') ?? ''
    if (名 === 'span' && /position:\s*absolute/.test(style) && /clip:\s*rect\(/.test(style)) {
      增('隐藏标签')
      return { 做: '删整块' }
    }
    /* 3. 按钮分两种：动作（`存为`）删掉；**装着内容的**（查询结果里那一列标题）拆壳留字。
          整颗删会把「5 条记录」的标题栏删成 5 个空格子——那是内容损失 */
    if (名 === 'button') {
      if (类了(属性, 'qres-save')) {
        增('动作按钮')
        return { 做: '删整块' }
      }
      增('解开的按钮')
      return { 做: '拆壳' }
    }
    /* 4. 勾选框：`innerHTML` 里**没有 `checked`**——ProseMirror 写的是 property 不是 attribute
          （实测真快照那两枚 `<input>` 都光秃秃的）。所以勾没勾只认 `<li data-checked>`，
          拿完钉成静态的，并且 `disabled`：一份寄出去的文件里不该有一按就变样的控件。 */
    if (名 === 'input') {
      const 里 = [...栈].reverse().find((s) => s.名 === 'li')
      const 勾 = 里 ? 取(里.属性, 'data-checked') === 'true' : false
      增('勾选框')
      return {
        做: '保留',
        属性: [
          { 名: 'type', 值: 'checkbox' },
          { 名: 'aria-label', 值: 勾 ? '已完成' : '未完成' },
          ...(勾 ? [{ 名: 'checked', 值: null as string | null }] : []),
          { 名: 'disabled', 值: null },
        ],
      }
    }
    /* 5. 其余标签：属性过名单，class 摘掉编辑面那几枚 */
    const 摘 = 类名单(属性, 是编辑类)
    if (摘) 增('编辑面类名')
    if (类了(属性, 'collapsed')) 增('展开的提示块')
    const 留下: 属[] = []
    const 掉的: 属[] = []
    for (const a of 属性) {
      /* 来源可查的三种 src/href 放行：`#…` 是文档内片段、`data:` 是已经内联好的，
         `kestrel-asset:` 是附件——它由 `换附件` 排在清理之后换成 data:，
         在这儿拦住就会**静默**把 img 变成没有 src 的空壳（期-11a 离线第一跑就是这么露的）。
         真留下没换成的，`自检` 那条协议残留会拦下来。 */
      const 放行 = /^(#|data:|kestrel-asset:)/
      const 该摘 =
        编辑属性.includes(a.名) ||
        (a.名.startsWith('on') && a.名.length > 2) ||
        (a.名.startsWith('data-') && !留.has(a.名)) ||
        ((a.名 === 'href' || a.名 === 'src' || a.名 === 'xlink:href') && !放行.test(a.值 ?? ''))
      ;(该摘 ? 掉的 : 留下).push(a)
    }
    for (const a of 掉的) {
      if (编辑属性.includes(a.名)) 增(a.名)
      else if (a.名.startsWith('data-')) 增('data属性')
      else if (a.名.startsWith('on')) 增('事件属性')
      else 增('外链属性')
    }
    if (!摘 && 掉的.length === 0) return undefined
    return { 做: '保留', 属性: 摘 ? 改类(留下, 是编辑类) : 留下 }
  })
  return { 正文, 清掉的: 计数 }
}

/* ───────────────────────── 二、附件换成 data: ───────────────────────── */

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}

export function 附mime(名字: string): string {
  const 点 = 名字.lastIndexOf('.')
  return MIME[名字.slice(点 + 1).toLowerCase()] ?? 'application/octet-stream'
}

export interface 附件后 {
  正文: string
  内联: number
  字节: number
  缺失: string[]
}

/** `kestrel-asset://<sha1>.<ext>` → `data:<mime>;base64,…`。
 *  **取不到字节的整张换掉并留一行说明**（借 `.asset-broken` 那一档既有样式），不留碎图——
 *  寄出去的文件里出现浏览器那个红叉，等于替我们表演一次「附件丢了」。
 *  名单外的 `src`（人手改过、或者从别处粘来的外链图）同样换成说明，绝不把外链带出去。 */
export function 换附件(html: string, 表: Record<string, string>): 附件后 {
  const 缺失: string[] = []
  let 内联 = 0
  let 字节 = 0
  const { 正文 } = 改写(html, (元) => {
    if (元.名 !== 'img') return undefined
    const src = 取(元.属性, 'src') ?? ''
    const m = /^kestrel-asset:\/\/([^/?#]+)/.exec(src)
    const 名 = m?.[1] ?? ''
    const 值 = 名 ? 表[名] : undefined
    if (!值) {
      缺失.push(名 || src || '(没有 src)')
      return {
        做: '换成',
        文: `<span class="asset-broken">${名 ? `那张图没有带出来：附件 <code>${转义(名)}</code> 的字节不在这台机器上。` : '那一张不是这个库里的附件，没有带出来。'}</span>`,
      }
    }
    内联++
    字节 += 值.length
    const alt = 取(元.属性, 'alt')
    return {
      做: '保留',
      属性: [
        { 名: 'src', 值 },
        ...(alt !== null ? [{ 名: 'alt', 值: alt }] : []),
        { 名: 'class', 值: 's-asset' },
      ],
    }
  })
  return { 正文, 内联, 字节, 缺失 }
}

/* ───────────────────────── 三、公式换成 MathML ───────────────────────── */

export interface 式 {
  tex: string
  mathml: string
}

/** KaTeX 那份 HTML markup 换成 MathML（设计稿 M3：484 B vs 3,711 B，而且不必带那 1 MB 字体）。
 *  `式子` 必须按**文档顺序**给：`.md-math` 那个 NodeView 的 DOM 上**没有** `data-tex`
 *  （那是 schema `renderHTML` 那条路才有的属性，实测真快照 0 处），所以只能靠顺序对上。
 *  对不上就抛——宁可不导出，也不能把 A 式的原 TEX 印到 B 式的位置上。 */
export function 换公式(html: string, 式子: 式[]): { 正文: string; 数: number } {
  const 处 = 切元(html).filter(
    (e) => e.类 === '开' && (类了(e.属性, 'md-math') || 类了(e.属性, 'md-math-block'))
  ).length
  if (处 !== 式子.length)
    throw new Error(
      `公式对不上号：屏幕上画了 ${处} 处，文档里数到 ${式子.length} 个式子。请重新打开这一篇再试一次`
    )
  let 用 = 0
  const { 正文 } = 改写(html, (元) => {
    const 独立 = 类了(元.属性, 'md-math-block')
    if (!独立 && !类了(元.属性, 'md-math')) return undefined
    const 一 = 式子[用++]
    if (!一) return { 做: '删整块' }
    const 壳 = `class="${独立 ? 's-tex s-tex-block' : 's-tex'}" data-tex="${转义(一.tex)}"`
    return {
      做: '换成',
      文: 独立 ? `<div ${壳}>${一.mathml}</div>` : `<span ${壳}>${一.mathml}</span>`,
    }
  })
  return { 正文, 数: 处 }
}

/* ───────────────────────── 四、双链与标签落成文字 ───────────────────────── */

/** `[[双链]]` 与 `#标签`：它们在应用里靠点击才成立，产物里没有点击。类换成 `s-wl` / `s-tag`，
 *  字与颜色（`.s-tag` 靠内联 `--tc`，那是 NodeView 现算的，清理不动内联样式）留着。
 *  **`wl-dangling`（悬空）必须一并抹平**：`editor/markdown.ts:132` 那条 `renderHTML` 把类写死成
 *  dangling，而「这一条在这个库里指不指得到」与「那份文件在谁手里」无关（决策 86）——
 *  把「悬空」印进别人手里的副本，是拿一份快照去撒谎。 */
export function 落双链(html: string): { 正文: string; 条数: number; 悬空: number } {
  const 双链类 = ['wl', 'wl-dangling', 'wl-diary', 'wl-article', 'wl-topic']
  let 条数 = 0
  let 悬空 = 0
  const { 正文 } = 改写(html, (元) => {
    if (元.名 !== 'span') return undefined
    const 标签 = 类了(元.属性, 'tag-ref')
    const 链 = 类了(元.属性, 'wl', 'wl-dangling')
    if (!标签 && !链) return undefined
    条数++
    if (类了(元.属性, 'wl-dangling')) 悬空++
    return {
      做: '保留',
      属性: 改类(元.属性, (c) => 双链类.includes(c) || c === 'tag-ref', [标签 ? 's-tag' : 's-wl']),
    }
  })
  return { 正文, 条数, 悬空 }
}

/** 查询块那一段前面加一行「数截止于…」。结果表本身留着——那一刻的数就是内容。
 *  不这么做的话，一份静态的表看起来像是活的（而它查询的那个库在别人手里根本不存在）。 */
export function 钉查询(html: string, 截止: string): { 正文: string; 块数: number } {
  /** 只认那一枚类叫 `qres` 的 div：里面还有 `qres-bar`、`qres-table-wrap`，
   *  按 `\bqres\b` 判会把它们也算进去（实测一次插了三行） */
  const re = /<div\b(?=[^>]*\bclass="(?:[^"]*\s)?qres(?:\s|"))[^>]*>/g
  const 块数 = (html.match(re) ?? []).length
  if (!块数) return { 正文: html, 块数: 0 }
  return {
    正文: html.replace(
      re,
      (m) => `${m}<p class="s-meta">数截止于 ${转义(截止)}——这是一份快照，不会再变</p>`
    ),
    块数,
  }
}

/* ───────────────────────── 五、CSS：从 CSSOM 抽，不手抄第二份 ───────────────────────── */

/** 只剥**伪元素**，为的是拿去 `element.matches()`：`::before` 之类永远匹配不到元素，
 *  不剥就整条漏——脚注那一枚编号正好活在 `::before{content:attr(data-n)}` 里（设计稿 M4 实测）。
 *  伪类（`:hover` / `:focus`）**原样留着**：匹配不到元素的会被自然淘汰，
 *  匹配得到的（`:checked`、`:nth-child`、`:not(...)`）在产物里照样成立。
 *  注意输出用的仍是**原选择器**（见 `挑规则`），否则 `::before` 那条就没了。 */
const 伪元素 =
  /::?(?:before|after|first-line|first-letter|marker|selection|placeholder|backdrop|caret|grammar-error|spelling-error|(?:-webkit|-moz|-ms|-o)-[\w-]+)(?:\([^()]*\))?/g

export function 剥伪(选择器: string): string {
  return 选择器.replace(伪元素, '').replace(/\s{2,}/g, ' ').trim()
}

/** 一段声明里定义了哪些自定义属性（`--x: …`）。用来找 token 名单，不猜 */
export function 变量名(声明文本: string): string[] {
  return [...声明文本.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])
}

/** 这段 CSS 用到了哪些 `data-*`：选择器里的 `[data-x]` 与 `content:attr(data-x)` 两种都算。
 *  产物里要留的属性由它推 ⇒ app.css 改了这里自动跟着改（决策 81 同一条理由）。 */
export function 用到的属性(css: string): string[] {
  return [...css.matchAll(/\[(data-[\w-]+)|attr\(\s*(data-[\w-]+)/g)].map((m) => m[1] ?? m[2])
}

export interface 规则 {
  选择器: string
  声明: string
  /** `@media` 那一层的条件文本；没有就是裸规则 */
  条件?: string
}

/** 只有「那棵树还在编辑」时才成立的选择器。产物是只读的：这类规则一条都不会命中，
 *  留在里面只有两个下场——白占字节，以及让自检在 CSS 里撞见 `contenteditable` 这种词
 *  （它按整串扫，不分 CSS 与 HTML，这是设计如此：`<style>` 与 `<svg>` 是清理时刻意不透明的
 *  两块，正因为不透明才要有人兜着）。所以抽样式这一步就把它们放下。
 *
 *  实测这一刀的理由（2026-09-25 实机）：tiptap 自己注进 document 的那两条
 *  `.ProseMirror [contenteditable="false"]{…}` 会原样进产物 ⇒ 自检拒写。 */
const 编辑面 = /contenteditable|\.ProseMirror|\.fold-(?:chev|hide)|\.wl-dangling|\.md-reading|\.collapsed\b/

/** 把命中那一棵的规则挑出来，按 `@media` 分组拼回一段 CSS。
 *  `能配` 由渲染层给，对着**未洗**的那棵活 DOM 量（所以 `data-*` 全在，匹配得准）；
 *  `必带` 是洗完之后才出现的类（`.asset-broken`、`.md-prose` 外壳这种按名字放行）。 */
export function 挑规则(
  规则表: 规则[],
  能配: (选择器: string) => boolean,
  必带: string[] = []
): { css: string; 命中数: number; 命中: string[] } {
  const 命中 = new Set<string>()
  const 桶 = new Map<string, string[]>()
  let 命中数 = 0
  for (const 条 of 规则表) {
    const 碎 = 条.选择器
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    // 逗号分开的每条各判各的：`能配` 用剥过伪类的那一份去量，写出去仍用原样（决策 81）
    const 留 = 碎.filter(
      (s) => !编辑面.test(s) && (能配(剥伪(s)) || 必带.some((b) => s.includes(b)))
    )
    if (留.length === 0) continue
    命中数++
    for (const s of 留) 命中.add(s)
    const 键 = 条.条件 ?? ''
    if (!桶.has(键)) 桶.set(键, [])
    桶.get(键)!.push(`${留.join(',')}{${条.声明}}`)
  }
  let css = ''
  for (const [条件, 块] of 桶) css += 条件 ? `${条件}{${块.join('\n')}}\n` : `${块.join('\n')}\n`
  return { css, 命中数, 命中: [...命中] }
}

/* ───────────────────────── 六、骨架与自检 ───────────────────────── */

/** 产物自己那一段样式：只服务**洗完之后才存在**的那几个类。
 *  正文的样子一律走 `挑规则` 从 CSSOM 抽来的那一份——这里不抄第二份真相源（决策 81）。 */
const 分享样式 = `
*{box-sizing:border-box}
/* 产物是一份**文档**，不是应用那个窗口。挑规则 判宽不判漏，把 tokens.css 里那两句窗口的话
   （html,body,#root{height:100%} 与 body{overflow:hidden}）一起抽了来——带进文档里，
   读的人就滚不到下半篇。这一段排在抽来的样式之后，明着把话说回来：文档按内容长，超了要能滚。 */
html,body{height:auto;min-height:100%}
body{margin:0;overflow:visible;background:var(--bg-base);background-image:var(--bg-wall);
  color:var(--text-1);font-family:var(--font-ui);font-size:var(--fs-body,15px);line-height:var(--lh-body,1.85)}
main.share{max-width:760px;margin:0 auto;padding:56px 24px 96px}
.s-title{margin:0 0 .15em;font-size:1.7em;line-height:1.35;font-weight:650;letter-spacing:-.01em}
.s-meta{margin:0 0 2.2em;color:var(--text-3);font-size:.85em}
.md-prose .s-meta{margin:0 0 6px}
.s-wl{color:var(--accent);border-bottom:1px dotted var(--border-strong)}
.s-tag{color:var(--tc,var(--accent))}
.s-tex{white-space:normal}
.s-tex-block{display:block;text-align:center;margin:1.1em 0;overflow-x:auto;overflow-y:hidden}
.s-foot{margin-top:4em;padding-top:14px;border-top:1px solid var(--border);
  color:var(--text-3);font-size:.8em;line-height:1.7}
.s-foot code{font-size:.95em}
@media (max-width:640px){main.share{padding:28px 16px 64px}}
@media print{body{background:#fff}.s-foot{display:none}}
`

export interface 骨架入 {
  标题: string
  /** `挑规则` 抽出来的那一份正文样式 */
  css: string
  /** 当前主题的 token 计算值（渲染层从 CSSOM 读来的，不在这里抄第二份） */
  变量: Record<string, string>
  正文: string
  时刻: string
  /** 主题名（`cloud`/`paper`/…）。抽出来的规则里可能有 `[data-theme='paper'] .md-prose{…}`
   *  这种带主题前缀的——不把它挂回 `<html>`，那一条就在产物里失效了（样式凭空少一块，还不报错） */
  主题: string
  /** `color-scheme`：原生控件（那颗静态勾选框）与滚动条跟着它走 */
  配色: 'light' | 'dark'
  内联张数: number
  /** 导出那一台机器上**根元素的计算字号**（#139）。产物里的样式表全是 rem（= 换算前那个 px/16），
   *  而 rem 量的就是根字号——不带这一句，用户把字号调到 18 那档分享出去，别人看到的却是 16 那一档：
   *  「我看到的就是别人看到的」这句话就断了。 */
  根字号?: string
}

/** 一个 token 值能不能进产物：带 `url()` 或本机路径的一律不带。
 *  `--bg-wall` 那种渐变是安全的，但用户 CSS 片段里一句 `--x: url(file:///…)` 就会把
 *  本机路径印到别人手里的那份文件上（§四 第 3 条）。渲染层与 `骨架` 用同一个判据。 */
export function 变量不许(value: string): boolean {
  return /url\(|[a-zA-Z]:[\\/]|\\\\/.test(value)
}

/** 一个文件：没有旁边的 assets/，没有 JS，没有外部请求。
 *  那一条 CSP 是「不联网」由**浏览器执行**的那一半（设计稿 §四 第 1 条）：
 *  `default-src 'none'` 之下，这个文件自己想联也联不了。 */
export function 骨架(o: 骨架入): string {
  const 变量表 = Object.entries(o.变量)
    .filter(([, v]) => !变量不许(v))
    .map(([k, v]) => `${k}:${v}`)
    .join(';')
  // 根字号只认「一个数 + px/rem/%」这一种形状：它是从 `getComputedStyle` 读来的，
  // 正常就是 `18px`，但产物是要在别人机器上打开的单文件——形状不对就退回默认那一档 16px，
  // 而不是把半截 CSS 拼进 `<style>`（拼坏了是整个文件没有样子）
  const 根 = o.根字号 && /^\d+(\.\d+)?(px|rem|%)$/.test(o.根字号) ? o.根字号 : '16px'
  return `<!doctype html>
<html lang="zh-CN" data-theme="${转义(o.主题)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${转义(o.标题)}</title>
<style>:root{color-scheme:${o.配色};${变量表}}html{font-size:${根}}${o.css}${分享样式}</style>
</head>
<body>
<main class="share">
<h1 class="s-title">${转义(o.标题)}</h1>
<p class="s-meta">导出于 ${转义(o.时刻)}${o.内联张数 ? ` · 内含 ${o.内联张数} 张附件` : ''} · 这一份是只读的快照</p>
<div class="md-prose">
${o.正文}
</div>
<footer class="s-foot">
由 Kestrel 导出。这个文件里没有一行 JavaScript，也不联网——断网、换台机器、过十年都照样打开。
<br>正文的样式是从导出那一台机器上的 Kestrel 里现取的那一份，用的是系统字体，看起来与应用里会有差别。
${o.内联张数 ? '<br>附件是以 <code>data:</code> 内联在这一个文件里的，没有旁边那个 assets 夹。' : ''}
</footer>
</main>
</body>
</html>
`
}

export interface 检后 {
  通过: boolean
  问题: string[]
  计数: Record<string, number>
}

/** 允许出现在 `xmlns` 上的那几个命名空间：它们是名字，不是请求。
 *  （设计稿 §四 第 2 条那条教训：不摘掉它就会假红——实测那 7 处 `http://` 全是 xmlns） */
const 命名空间 = [
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1999/xlink',
  /** katex 的 MathML 输出自带这一枚（`<math xmlns="…">`）：它同样是个名字，不是请求 */
  'http://www.w3.org/1998/Math/MathML',
]

function 摘命名空间(原文: string): string {
  return 命名空间.reduce((s, ns) => s.split(ns).join(''), 原文)
}

/** 落盘前那三道闸（设计稿 §四）。**跑不通就不写**，不写半个文件。
 *  扫的是整串文本，包括 `<svg>` 与 `<style>` 里面——那两处清理时刻意不透明，正需要有人兜住。 */
export function 自检(html: string): 检后 {
  const 问题: string[] = []
  const 计数: Record<string, number> = {}
  const 数 = (re: RegExp): number => (html.match(re) ?? []).length
  /** 命中处各带一小段上下文，最多三处。拒绝那一句要指着东西说，光给个数没用。 */
  const 现场 = (re: RegExp, 至多 = 3): string[] => {
    const out: string[] = []
    for (const m of html.matchAll(re)) {
      if (out.length >= 至多) break
      const i = m.index ?? 0
      out.push(html.slice(Math.max(0, i - 28), i + m[0].length + 28).replace(/\s+/g, ' '))
    }
    return out
  }
  const 净 = 摘命名空间(html)

  计数['脚本'] = 数(/<script\b/gi) + 数(/javascript:/gi)
  计数['事件属性'] = 数(/\son[a-z]+\s*=/gi)
  计数['控件'] = 数(/<button\b/gi) + 数(/<textarea\b/gi) + 数(/<select\b/gi) + 数(/<form\b/gi)
  计数['嵌入'] =
    数(/<iframe\b/gi) + 数(/<object\b/gi) + 数(/<embed\b/gi) + 数(/<link\b/gi) + 数(/@import/gi)
  const 外 = 净.match(/https?:\/\/[^\s"'()<>]*/g) ?? []
  计数['外链'] = 外.length
  const css用 = (html.match(/url\(\s*(['"]?)\s*(.*?)\1\s*\)/g) ?? []).filter(
    (u) => !/^url\(\s*['"]?#/.test(u)
  )
  计数['css外链'] = css用.length
  const 盘 = 净.match(/(?:[a-zA-Z]:[\\/]|\\\\)[^\s"'<>]*/g) ?? []
  计数['本机路径'] = 盘.length
  计数['协议残留'] = 数(/kestrel-asset:/g) + 数(/file:/gi)
  const 内脏式 = [
    /contenteditable/gi,
    /class="[^"]*\b(?:fold-chev|fold-hide|ProseMirror-widget|ProseMirror-selectednode|wl-dangling|collapsed)\b/g,
    /<input\b(?! type="checkbox")/g,
  ]
  计数['编辑面残留'] = 内脏式.reduce((n, re) => n + 数(re), 0)
  // 拦下来那一句要能指到地方：只有计数的拒绝，用户读成「应用坏了」，我读成「猜吧」
  const 内脏现场 = 内脏式.flatMap((re) => 现场(re))

  const 拦 = (坏: boolean, k: string, 说: string): void => {
    if (坏) 问题.push(`${说}（计数 ${计数[k]}）`)
  }
  拦(计数['脚本'] > 0, '脚本', '产物里有脚本')
  拦(计数['事件属性'] > 0, '事件属性', '产物里有一按就做事的控件属性')
  拦(计数['控件'] > 0, '控件', '产物里还有编辑器的控件')
  拦(计数['嵌入'] > 0, '嵌入', '产物里有能引外部东西的标签')
  拦(计数['外链'] > 0, '外链', `产物里有外部地址：${外.slice(0, 3).join(' ')}`)
  拦(计数['css外链'] > 0, 'css外链', `样式里有 url() 指向外面：${css用.slice(0, 3).join(' ')}`)
  拦(计数['本机路径'] > 0, '本机路径', `产物里带着本机路径：${盘.slice(0, 2).join(' ')}`)
  拦(计数['协议残留'] > 0, '协议残留', '还有 kestrel-asset:// 或 file: 没换干净')
  拦(
    计数['编辑面残留'] > 0,
    '编辑面残留',
    `编辑器的内脏还在（contenteditable / 折叠 / 悬空链）：${内脏现场.slice(0, 3).join(' ⧸ ')}`
  )

  const 失衡 = 平衡不过(html)
  计数['失衡'] = 失衡.length
  if (失衡.length) 问题.push(`标签对不上：${失衡.join(' ')}`)
  return { 通过: 问题.length === 0, 问题, 计数 }
}

/** 成对标签数一遍。清理是字符串手术，这一步是它的安全网：哪一刀切错了这里就对不上，
 *  于是那份文件根本不会落盘（与期-10「要么整份要么不动」同一族）。 */
function 平衡不过(html: string): string[] {
  const 空元素 = new Set([
    'br',
    'img',
    'input',
    'hr',
    'col',
    'wbr',
    'source',
    'track',
    'meta',
    'link',
    'area',
    'base',
  ])
  const 差 = new Map<string, number>()
  const 栈 = new Map<string, number>()
  for (const t of 切元(html)) {
    if (t.类 === '开') {
      if (t.自闭 || 空元素.has(t.名)) continue
      栈.set(t.名, (栈.get(t.名) ?? 0) + 1)
    } else if (t.类 === '闭') {
      const n = 栈.get(t.名) ?? 0
      if (n === 0) 差.set(t.名, (差.get(t.名) ?? 0) + 1)
      else 栈.set(t.名, n - 1)
    }
  }
  for (const [名, n] of 栈) if (n > 0) 差.set(名, (差.get(名) ?? 0) + n)
  return [...差.entries()].map(([名, n]) => `<${名}>差 ${n}`)
}

/* ───────────────────────── 七、那条"内联还是别内联"的线 ───────────────────────── */

/** 单张附件与整篇产物的线。数是从 M3 来的：base64 的膨胀是 4/3 加一个固定前缀
 *  （实测 40 KB → 53.4 KB，1.33×），所以一张 4.5 MB 的原图会变成 6 MB 的文本。
 *  过线就在界面上拦住并说清为什么——**不静默改成"旁边再放一个 assets 夹"**，
 *  那会把「一个文件」这个承诺改掉（设计稿决策 85）。 */
export const 单张上限 = 6 * 1024 * 1024
export const 总量上限 = 32 * 1024 * 1024

/** 问一句：这一篇按这两条线过得去吗。返回 null 是过得去，返回的是给人看的那一句 */
export function 超限(张: { 名字: string; 字节: number }[]): string | null {
  const 大 = 张.filter((z) => Math.ceil((z.字节 * 4) / 3) + 22 > 单张上限)
  if (大.length)
    return `有 ${大.length} 张图太大（<code>${转义(大[0].名字.slice(0, 12))}…</code> ${(大[0].字节 / 1048576).toFixed(1)} MB）：单张的线是 ${(单张上限 / 1048576).toFixed(0)} MB 内联后的文本。这一档只做"一个文件"，不往外放旁边的那份。`
  const 合 = 张.reduce((a, z) => a + Math.ceil((z.字节 * 4) / 3) + 22, 0)
  if (合 > 总量上限)
    return `这一篇的附件加起来是 ${(合 / 1048576).toFixed(1)} MB，超过整篇 ${(总量上限 / 1048576).toFixed(0)} MB 那一条线。要带走这么多图，请用流通 · 导出那一档（Markdown 目录树，图放在旁边的 <code>assets/</code> 里）。`
  return null
}

/* ───────────────────────── 八、名字 ───────────────────────── */

/** 落盘那个文件名。洗名字的规矩与期-08 那棵导出树同一件（`safeName`：Windows 保留名、
 *  非法字符、尾随点空格、超长截断都按实测最严那一档），不抄第二份。 */
export function 分享文件名(题: string): string {
  return `${safeName(题, '未命名')}.html`
}
