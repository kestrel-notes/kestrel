/** `#标签` 的解析。纯函数，与 `shared/links.ts` 同一个理由：主进程入库与渲染进程
 *  渲染共用一套，两边各写一份的话「什么算一个标签」迟早会有两种答案。
 *
 *  规则为什么长这样，逐条给理由（`docs/期-02-设计.md` §2.2 §4.2）：
 *
 *  1. **正文是标签的唯一来源。** 属性里的 `(tag)` 类型因此不做——两个来源等于没有来源。
 *  2. **代码区不算**（`maskCode`）、**`[[双链]]` 里不算**（那里面已经有 `#锚点`，
 *     不屏蔽的话 `[[某篇#小节]]` 会凭空多出一个 `#小节` 标签）。
 *  3. **`#` 前面可以是汉字，但不能是 ASCII 单词字符或 URL 连接符。** 中文日记不打空格，
 *     「今天心情不错#工作」必须能打上标签；而 `C#语言`、`example.com/#anchor`
 *     里的 `#` 不是标签。这是与 Obsidian 唯一的偏离（它要求 `#` 前是空白），
 *     为一个中文日记应用改的这一条写在 `docs/期-02-设计.md` §2.2。
 *  4. **纯数字不算标签**（`#123`、`#2026`）：那是行号、编号、色值，不是主题。
 *     `#3月` 算，因为汉字尾巴让整串不再是数字。
 *  5. **`#` 后紧跟空白不是标签**，那是 markdown 标题。`##` 打头也不算（多半是漏了空格的标题）。
 *  6. **标签体是白名单字符集**（字母含汉字 / 数字 / `_` / `-` / `/`），所以中文标点、
 *     括号、emoji 天然就是终止符。这条是中文日记逼出来的，详见 `TAG_BODY` 上方注释。
 *
 *  已知取舍与 `parseLinks` 一致：四空格缩进的代码块不跳过（跳了会连列表缩进一起误伤）。 */

import { maskCode } from './links'

export interface ParsedTag {
  /** 归一后的完整路径，`a/b/c`。入库与查重都看它 */
  name: string
  /** 首次出现时的原始写法，只用来显示 */
  display: string
  /** 拆好的各级名字，已归一。建树要用 */
  path: string[]
}

export interface TagRange {
  from: number
  to: number
  /** 原文里那一整段，含开头的 `#`。**重命名就是按它在正文里做替换** */
  raw: string
  name: string
  path: string[]
}

/** 标签路径的归一：各级去空白 + ASCII 转小写，斜杠重新拼。
 *  与 `normalizeLinkKey` 的「去掉所有空白」不同——标签里本来就不允许空白，
 *  这里只防得住 `#a/ b` 这种半截写法。 */
export function normalizeTagKey(raw: string): string {
  return raw
    .split('/')
    .map((s) => s.trim().toLowerCase())
    .join('/')
}

/** 屏蔽 `[[…]]`，保持长度不变（下标还能原样用）。
 *
 *  这里的正则**必须与 `shared/links.ts:193` 那条保持一致**，否则链接语法一改，
 *  标签这边就会把链接里的 `#锚点` 当成标签。改链接语法时记得一起改。 */
function maskLinks(masked: string): string {
  return masked.replace(/\[\[[^[\]\n]*\]\]/g, (s) => ' '.repeat(s.length))
}

/** `#` 不允许的前导字符：ASCII 单词字符、以及 URL / markdown 里会紧挨着 `#` 的那些符号。 */
const BAD_BEFORE = /[0-9A-Za-z_#/@:.~%+&=?-]/

/** 标签体的合法字符：**字母（含汉字）、数字、`_`、`-`、`/`**，sticky 起在原位吃，
 *  不必每个候选都 slice 一遍正文。
 *
 *  为什么是「白名单字符集」而不是「吃到空白为止再把尾巴标点剪掉」：中文没有词间空格，
 *  `#工作，然后回家` 里空白终止符会把整句吞成标签，剪尾巴也救不回来（尾巴不在句中）。
 *  白名单让中文标点、括号、emoji 天然成为终止符——`#心情😊` 就是 `心情`，
 *  这正是中文日记里最常见的写法。代价是标签里不能带 `.` 和 `:`，接受。 */
const TAG_BODY = /[\p{L}\p{N}_/-]+/uy

/** 拆嵌套路径并归一。任一段为空、或整串只剩数字（`#123`、`#1/2`）→ 不是标签。 */
function splitPath(body: string): string[] | null {
  // 尾巴是 `/` 的（`#a/b/`）先剪掉，否则最后一段空、整串被判废
  const cut = body.endsWith('/') ? body.slice(0, -1) : body
  const segs = normalizeTagKey(cut).split('/')
  if (segs.some((s) => !s)) return null
  if (/^[\d_./-]+$/.test(segs.join(''))) return null
  return segs
}

/** 正文里每一处 `#tag` 以及它的下标，不去重。
 *
 *  渲染要按位置染色（同一标签写两遍得各自有热区），入库要的是去重后的集合，
 *  所以 `parseTags` 只是这个的一层去重包装——与 `findLinkRanges` / `parseLinks`
 *  的分工完全对称。 */
export function findTagRanges(text: string): TagRange[] {
  const scan = maskLinks(maskCode(text))
  const out: TagRange[] = []

  let i = 0
  while (i < scan.length) {
    const hash = scan.indexOf('#', i)
    if (hash === -1) break
    i = hash + 1

    // `##` 打头：多半是漏了空格的标题，整段跳过这两个井号再找
    if (scan[hash + 1] === '#') {
      i += 1
      continue
    }
    if (hash > 0 && BAD_BEFORE.test(scan[hash - 1])) continue

    TAG_BODY.lastIndex = hash + 1
    const m = TAG_BODY.exec(scan)
    if (!m) continue

    const body = m[0]
    const path = splitPath(body)
    if (!path) continue

    const from = hash
    const to = hash + 1 + body.length
    out.push({ from, to, raw: text.slice(from, to), name: path.join('/'), path })
    i = to
  }

  return out
}

/** 这篇正文里有哪些标签，按归一后的路径去重（`display` 取第一次出现的写法）。 */
export function parseTags(text: string): ParsedTag[] {
  const out: ParsedTag[] = []
  const seen = new Set<string>()

  for (const { name, raw } of findTagRanges(text)) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, display: raw.slice(1), path: name.split('/') })
  }

  return out
}

/** 这个名字写进正文还能不能被读回它自己。改名之前必须问一句：
 *  `#a b`（带空白）、`#123`（纯数字）、`#心情😊`（emoji 尾巴）这类输入解析器不认，
 *  按文件头的规则 4、6 它们要么不是标签、要么只吃到一半——改过去等于把标签改掉。
 *
 *  判据用现成的 `parseTags` 跑一遍，**不在这里再写一遍字符集**：白名单一改，
 *  这里跟着变，不会出现「界面认为合法、入库时不见了」的两套答案。 */
export function isTagName(raw: string): boolean {
  const key = normalizeTagKey(raw)
  if (!key) return false
  const back = parseTags(`#${key}`)
  return back.length === 1 && back[0].name === key
}

/** 标签名的调色板下标：同一个标签永远同一个色（期-02-设计 §5）。
 *
 *  为什么散列到 8 个预调 token 而不是 `hsl(hash, …)`：四个主题的调色板差得远，
 *  任意色相不可能在四个主题里都读得清、还守住 WCAG AA。 */
export function tagColorIndex(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return Math.abs(h) % 8
}
