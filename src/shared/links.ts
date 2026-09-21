/** `[[双链]]` 的解析。纯函数，主进程入库与渲染进程渲染共用一套——
 *  两边各写一份的话，「什么算一个链接」迟早会有两种答案。 */

import { addDays, dateKey, parseDateKey } from './date'
import type { LinkKind } from './types'

export interface ParsedLink {
  kind: LinkKind
  /** 规范化后的查找键：日期引用换成绝对日期，名字去掉空白并转小写 */
  key: string
  /** key 是绝对日期 → 目标就是那天的日记，解析时按日期找而不是按名字找 */
  isDate: boolean
  /** `[[目标|别名]]` 里写的显示名 */
  alias: string | null
  /** `[[目标#锚点]]` 里写的锚点。v1 只存不用（锚点跳转是 v2） */
  anchor: string | null
}

/** 查链接用的规范化：去掉所有空白 + 转小写。
 *
 *  中文用户不会老老实实打空格——原型里的 `[[Kestrel开发日志]]` 和
 *  `[[Kestrel 开发日志]]` 指的是同一个主题。去掉空白是唯一能让两者相等、
 *  又不需要给 Link 表再加一列规范化键的做法。
 *
 *  注意：入库的 target_raw 存的就是这个规范化形式，不是用户原样输入。
 *  否则「新建标题为 X 的文章后回头认领悬空链接」得枚举出 X 的所有空格写法。 */
export function normalizeLinkKey(raw: string): string {
  return raw.replace(/\s+/g, '').toLowerCase()
}

/** 相对日期的词汇表。写日记时「昨天」比日期好打得多 */
const RELATIVE_DAYS: Record<string, number> = {
  今天: 0,
  今日: 0,
  昨天: -1,
  昨日: -1,
  前天: -2,
  明天: 1,
  明日: 1,
  后天: 2,
}

/** 把日期写法翻成绝对日期；不是日期写法返回 null。
 *
 *  `from` 必须是**源记录自己的 entry_date**，不是 today——翻去年的日记
 *  时正文里的「昨天」指的是那一天的昨天，用 today 会算到今天头上。 */
export function resolveDateRef(raw: string, from: string): string | null {
  const s = normalizeLinkKey(raw)
  if (!s) return null

  const rel = RELATIVE_DAYS[s]
  if (rel !== undefined) return addDays(from, rel)

  // 去年今天 / 去年的今日 / 前年今天
  const y = /^(前年|去年|今年)的?(今天|今日)$/.exec(s)
  if (y) {
    const base = parseDateKey(from)
    if (!base) return null
    base.setFullYear(base.getFullYear() + (y[1] === '去年' ? -1 : y[1] === '前年' ? -2 : 0))
    return dateKey(base)
  }

  const abs = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  if (abs) {
    const key = `${abs[1]}-${abs[2].padStart(2, '0')}-${abs[3].padStart(2, '0')}`
    const d = parseDateKey(key)
    // 2026-02-30 这类不存在的日期会被 Date 悄悄滚到 3 月，回读一次挡住它
    return d && dateKey(d) === key ? key : null
  }

  return null
}

/** 把代码区（围栏代码块 + 行内代码）换成等长的空格。
 *
 *  返回的字符串与原文**逐字符等长**，所以正则匹配到的下标可以直接拿去切原文。
 *  正文里写 `` `[[双链]]` `` 是在讲语法，不是要建链接。 */
export function maskCode(text: string): string {
  // 按 UTF-16 码元拆，不能用 [...text]：emoji 会被拆成一个元素但占两个码元，
  // 替换成空格后整个字符串长度就变了，下标全错位
  const units = text.split('')
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i++) units[i] = ' '
  }

  let i = 0
  let fence: { ch: string; len: number } | null = null
  while (i < text.length) {
    const nl = text.indexOf('\n', i)
    const end = nl === -1 ? text.length : nl
    const line = text.slice(i, end)

    if (fence) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null
      blank(i, end)
    } else {
      const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
      if (open) {
        fence = { ch: open[1][0], len: open[1].length }
        blank(i, end)
      } else {
        blankInlineCode(text, units, i, end)
      }
    }

    i = nl === -1 ? text.length : nl + 1
  }

  return units.join('')
}

/** 行内代码：N 个反引号开，必须 N 个反引号才关（CommonMark 的规矩）。
 *  没找到闭合就把这串反引号当普通字符，别把后面半行正文吞掉。 */
function blankInlineCode(text: string, units: string[], from: number, to: number): void {
  let i = from
  while (i < to) {
    if (text[i] !== '`') {
      i++
      continue
    }
    let n = 0
    while (i + n < to && text[i + n] === '`') n++

    let j = i + n
    let close = -1
    while (j < to) {
      if (text[j] !== '`') {
        j++
        continue
      }
      let k = 0
      while (j + k < to && text[j + k] === '`') k++
      if (k === n) {
        close = j
        break
      }
      j += k
    }

    if (close === -1) {
      i += n
      continue
    }
    for (let x = i; x < close + n; x++) units[x] = ' '
    i = close + n
  }
}

/** 拆 `[[ 目标 #锚点 |别名 ]]`。目标为空（`[[#某标题]]` 这种同页锚点）返回 null。 */
export function splitLinkInner(inner: string): {
  target: string
  anchor: string | null
  alias: string | null
} | null {
  const bar = inner.indexOf('|')
  const left = bar === -1 ? inner : inner.slice(0, bar)
  const rawAlias = bar === -1 ? '' : inner.slice(bar + 1)

  const hash = left.indexOf('#')
  const target = (hash === -1 ? left : left.slice(0, hash)).trim()
  const rawAnchor = hash === -1 ? '' : left.slice(hash + 1)

  if (!target) return null
  return {
    target,
    anchor: rawAnchor.trim() || null,
    alias: rawAlias.trim() || null,
  }
}

/** 正文里每一处 `[[…]]` 以及它在原文中的下标。
 *
 *  和 parseLinks 的差别只有两点：不去重（两处一样的链接要能各自染上样式），
 *  并且带下标。编辑器要按类型给链接上色（实线日记 / 双线文章 / 药丸底主题 /
 *  虚线悬空，见 docs/视觉设计系统.md §9.1），拿不到下标就只能瞎猜位置。
 *
 *  下标直接对应**原文**：maskCode 返回的字符串逐字符等长，所以在它上面匹配到的
 *  位置可以原样用来切原文。 */
export interface LinkRange {
  from: number
  to: number
  /** 原文里那一整段，含 `[[` `]]` */
  raw: string
  link: ParsedLink
}

export function findLinkRanges(text: string, entryDate: string): LinkRange[] {
  const masked = maskCode(text)
  const out: LinkRange[] = []

  // 不允许换行、不允许嵌套中括号：一个没闭合的 [[ 不该把后面半篇文档吞成链接
  const re = /\[\[([^[\]\n]*)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    const parts = splitLinkInner(m[1])
    if (!parts) continue

    const date = resolveDateRef(parts.target, entryDate)
    const link: ParsedLink = {
      kind: 'wiki',
      key: date ?? normalizeLinkKey(parts.target),
      isDate: date !== null,
      alias: parts.alias,
      anchor: parts.anchor,
    }
    if (!link.key) continue

    out.push({ from: m.index, to: m.index + m[0].length, raw: m[0], link })
  }

  return out
}

/** 正文里所有正式链接，按目标去重（同一目标写两遍只留一条，别名取第一次出现的）。
 *
 *  入库要的是「这篇提到了哪些目标」，同一目标出现几次都是同一行。
 *
 *  已知取舍：四空格缩进的代码块不跳过。因为列表项续行也是四空格缩进，
 *  跳了会把列表里的链接一起吞掉，代价比漏网一个缩进代码块大。 */
export function parseLinks(text: string, entryDate: string): ParsedLink[] {
  const out: ParsedLink[] = []
  const seen = new Set<string>()

  for (const { link } of findLinkRanges(text, entryDate)) {
    const dedupe = `${link.kind}:${link.key}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    out.push(link)
  }

  return out
}