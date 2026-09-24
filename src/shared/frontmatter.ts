/** frontmatter：`键: 标量` 与 `键: [串…]` 这一种形状的 YAML 子集（期-08-设计 §〇.2）。
 *
 *  为什么不引通用 YAML 库：别名、多文档、块标量折叠、**时间戳自动转类型**这几条路都会
 *  静默改值，而这一期的判据是逐字节（「导出 → 删库 → 导入 → 再导出」要比到字节）。
 *  两边各几十行，换来的是「往返是我们自己说得住的」。认不动的形状一律抛出去——
 *  导出时拒绝、导入时逐条报，都不许猜。
 *
 *  值域与 `shared/props.ts` 的 `PropValue` 完全一致（`string | number | boolean | string[]`），
 *  属性能直接铺进来，不需要再写一份「什么算一个属性值」。
 *
 *  【这个文件里一个反斜杠都不写】换行、制表、反斜杠本身全部走 `String.fromCharCode`。
 *  理由不是风格：这一期光写探针就被编辑工具把 `换行` 解成真换行坑了三次（设计稿 §十 风险 1），
 *  而 `'` 串里出现真换行是语法错误，报错看起来还像解析器坏了。 */

export type FmValue = string | number | boolean | string[]
export type Fm = Record<string, FmValue>

const BS = String.fromCharCode(92) // 反斜杠
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const TAB = String.fromCharCode(9)
const QUO = String.fromCharCode(34)
const LS = String.fromCharCode(0x2028) // 行分隔符
const PS = String.fromCharCode(0x2029) // 段分隔符
const SP = ' '
const BLANK = SP + TAB

/** YAML 的指示符：出现在串首就得加引号 */
const LEAD = '>|@' + QUO + '`' + String.fromCharCode(39) + '%&*!,?[]{}#-' + BLANK
/** 行内列表那档不能含的字符：逗号靠引号配对来数，串中间的引号会配错位（配错还是静默的） */
const NO_INLINE = QUO + ',[]' + BS
/** 看着就不是字符串的那些写法：读回来会变成别的类型 */
const KEYWORD = new RegExp('^(true|false|null|~|yes|no|on|off|nan|inf|-?[0-9]*[.]?[0-9]+(e[-+]?[0-9]+)?)$', 'i')
const LIKE_DATE = new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ]([0-9]{2}:[0-9]{2})(:[0-9]{2})?)?$')
const NUMERIC = new RegExp('^-?([0-9]+[.]?[0-9]*|[.][0-9]+)$')
const LINE_BREAKS = new RegExp('[' + LF + CR + LS + PS + ']+')
const LEAD_BLANK = new RegExp('^[' + BLANK + ']')
const TAIL_BLANK = new RegExp('[' + BLANK + ']+$')

/** 要不要加引号：空串、首尾空白、指示符开头、`: ` 或 `#` 在内、长得像别的类型、
 *  含控制字符或行分隔符。
 *
 *  LS / PS 这一条是实测跑出来的：它们留在引号里，下一遍「按行切」会把一条值从中间劈开，
 *  报出来像「引号没合上」。DEL(0x7f) 归同一档。 */
function needsQuote(s: string): boolean {
  if (s === '') return true
  if (LEAD.includes(s[0])) return true
  const 末 = s[s.length - 1]
  if (BLANK.includes(末) || 末 === ':' || 末 === '-') return true
  if (s.includes(': ') || s.includes('#')) return true
  if (hasControl(s)) return true
  if (KEYWORD.test(s) || LIKE_DATE.test(s)) return true
  return false
}

function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) return true
  }
  return false
}

/** 转义走单遍扫描，`读转义` 是它的逆。两边都不写替换链——
 *  「字面的反斜杠 + `u2028` 六个字符」这种值被两次替换会串成别的东西。 */
function quote(s: string): string {
  if (!needsQuote(s)) return s
  let out = QUO
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (ch === QUO) out += BS + QUO
    else if (ch === BS) out += BS + BS
    else if (ch === LF) out += BS + 'n'
    else if (ch === CR) out += BS + 'r'
    else if (ch === TAB) out += BS + 't'
    else if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) {
      out += BS + 'u' + c.toString(16).padStart(4, '0')
    } else out += ch
  }
  return out + QUO
}

/** 键走同一道判据（`mood` 不加引号，`42` 这种名字要加）。
 *  还多一条：含冒号的一律加引号——parser 那侧不认裸冒号的键，`a: b: v` 分不开。 */
function key(s: string): string {
  return needsQuote(s) || s.includes(':') ? quote(s) : s
}

/** 每一项都短、且不含 `NO_INLINE` 里的字符，才允许行内写法；否则一律缩进块 */
function inlineSafe(s: string): boolean {
  if (needsQuote(s) || s.length > 18) return false
  for (const ch of s) if (NO_INLINE.includes(ch)) return false
  return true
}

/** 序列化成不带首尾 `---` 的那一段。值域之外（嵌套对象、`null`、`NaN`）直接抛：
 *  空值在属性那一侧的定义是**删键**（`shared/props.ts`），不是写个 `null` 出去。 */
export function serialize(fm: Fm): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      if (v.length === 0) lines.push(key(k) + ': []')
      else if (v.every(inlineSafe) && v.join(SP).length <= 60) lines.push(key(k) + ': [' + v.map(quote).join(', ') + ']')
      else lines.push(key(k) + ':' + LF + v.map((s) => '  - ' + quote(s)).join(LF))
      continue
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('frontmatter 写不进：' + k + ' 是 ' + String(v))
      lines.push(key(k) + ': ' + v)
      continue
    }
    if (typeof v === 'boolean') {
      lines.push(key(k) + ': ' + v)
      continue
    }
    if (typeof v === 'string') {
      lines.push(key(k) + ': ' + quote(v))
      continue
    }
    throw new Error('frontmatter 写不进：' + k + ' 是 ' + (v === null ? 'null' : typeof v))
  }
  return lines.join(LF)
}

export function block(fm: Fm): string {
  const body = serialize(fm)
  return body === '' ? '---' + LF + '---' + LF : '---' + LF + body + LF + '---' + LF
}

/** 只认 `serialize` 写得出来的那几种形状。行内 `[a, b]` 与缩进 `- a` 两种列表都**收**，
 *  因为用户会在别的编辑器里改这个文件——写严、读宽。 */
export function parse(text: string): Fm {
  const out: Fm = {}
  // 换行的**类型**不当判据：LS / PS 在序列化那侧一律转义成可见序列，
  // 所以这一段里连续的这几个字符永远是「行边界」，不会是一个空行
  const lines = text.split(LINE_BREAKS)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '' || line.startsWith('#') || LEAD_BLANK.test(line) && line.trimStart().startsWith('#')) continue
    const 切 = splitLine(line)
    if (!切) throw new Error('frontmatter 第 ' + (i + 1) + ' 行看不懂：' + JSON.stringify(line))
    const [名, 冒后] = 切
    if (冒后 === '') {
      const items: string[] = []
      while (i + 1 < lines.length && lines[i + 1].startsWith('  - ')) items.push(String(scalar(lines[++i].slice(4).trim())))
      if (items.length === 0) throw new Error('frontmatter 第 ' + (i + 1) + ' 行：键「' + 名 + '」后面什么都没有')
      out[名] = items
      continue
    }
    if (冒后.startsWith('[')) {
      if (!冒后.endsWith(']')) throw new Error('frontmatter 第 ' + (i + 1) + ' 行：行内列表的 ] 没合上')
      out[名] = 冒后 === '[]' ? [] : inlineList(冒后.slice(1, -1))
      continue
    }
    out[名] = scalar(冒后)
  }
  return out
}

/** → `[键, 冒号之后的部分]`；不是「键: 值」这一形就返回 null。
 *  与 YAML 一致：冒号后面要么什么都没有，要么必须跟着空格——`k:v` 是一个字符串，不是键值对。 */
function splitLine(line: string): [string, string] | null {
  let 名: string
  let  rest: string
  if (line.startsWith(QUO)) {
    let i = 1
    while (i < line.length) {
      if (line[i] === BS) {
        i += 2
        continue
      }
      if (line[i] === QUO) break
      i++
    }
    if (line[i] !== QUO) return null
    if (line[i + 1] !== ':') return null
    名 = 读转义(line.slice(1, i))
    rest = line.slice(i + 2)
  } else {
    const at = line.indexOf(':')
    if (at < 1) return null
    const raw = line.slice(0, at)
    if (LEAD_BLANK.test(raw) || raw.startsWith('#') || raw.startsWith(':')) return null
    名 = raw.trim()
    rest = line.slice(at + 1)
  }
  if (rest === '') return [名, '']
  if (!LEAD_BLANK.test(rest)) return null
  return [名, rest.replace(LEAD_BLANK, '').replace(TAIL_BLANK, '')]
}

function inlineList(inner: string): string[] {
  const items: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === BS && quoted) {
      cur += c + (inner[i + 1] ?? '')
      i++
      continue
    }
    if (c === QUO) quoted = !quoted
    else if (c === ',' && !quoted) {
      items.push(String(scalar(cur.trim())))
      cur = ''
      continue
    }
    cur += c
  }
  items.push(String(scalar(cur.trim())))
  if (quoted) throw new Error('行内列表里有项的引号没合上：' + JSON.stringify(inner))
  return items
}

function scalar(text: string): FmValue {
  if (text.startsWith(QUO)) {
    if (!closes(text)) throw new Error('引号没合上：' + JSON.stringify(text))
    return 读转义(text.slice(1, -1))
  }
  if (text === 'true' || text === 'false') return text === 'true'
  if (NUMERIC.test(text)) return Number(text)
  return text
}

/** 结尾那个引号得是**没被转义**的那一个。 */
function closes(text: string): boolean {
  if (text.length < 2 || !text.endsWith(QUO)) return false
  let slashes = 0
  for (let i = text.length - 2; i >= 0 && text[i] === BS; i--) slashes++
  return slashes % 2 === 0
}

/** `quote` 的逆：单遍扫描，反斜杠之后的一格决定这个逃逸序列吃掉几个字符。 */
function 读转义(s: string): string {
  if (!s.includes(BS)) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== BS) {
      out += c
      continue
    }
    const next = s[++i]
    if (next === QUO) out += QUO
    else if (next === BS) out += BS
    else if (next === 'n') out += LF
    else if (next === 'r') out += CR
    else if (next === 't') out += TAB
    else if (next === 'u') {
      const hex = s.slice(i + 1, i + 5)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('反斜杠 u 后面不是四个十六进制：' + JSON.stringify(s))
      out += String.fromCharCode(parseInt(hex, 16))
      i += 4
    } else throw new Error('不认识的逃逸 ' + BS + (next ?? '（串尾）'))
  }
  return out
}

export interface Split {
  /** null = 这文件没有 Kestrel 的包头（用户手写的 md、别的工具的导出物）。
   *  调用方据此拒绝导入——决策 ⑥：只保证自家往返，不做猜测式导入。 */
  data: Fm | null
  body: string
}

/** 收尾的 `---` 只吃**第一个**：正文以 `---`（分隔线）开头时，那一行不会被当成包头收尾。 */
export function split(text: string): Split {
  const open = splitOpen(text)
  if (open < 0) return { data: null, body: text }
  const rest = text.slice(open)
  const closeAt = findClose(rest)
  if (closeAt < 0) return { data: null, body: text }
  // 收尾那一行连同它的换行一起吃掉：CRLF 时 CR 在 LF 前面，一起就过了
  const 行尾 = rest.indexOf(LF, closeAt)
  const body = 行尾 < 0 ? '' : rest.slice(行尾 + 1)
  const 段 = rest.slice(0, closeAt).trim()
  return { data: 段 === '' ? {} : parse(段), body }
}

/** 首行是不是 `---`（后面可以带空白，可以跟 CRLF）；返回正文起点，否则 -1 */
function splitOpen(text: string): number {
  if (!text.startsWith('---')) return -1
  const 行尾 = text.indexOf(LF)
  if (行尾 < 0) return -1
  const 首行 = text.slice(3, 行尾).replace(TAIL_BLANK, '')
  if (首行 !== '' && 首行 !== CR) return -1
  return 行尾 + 1
}

/** 第一行独占 `---` 的位置 */
function findClose(rest: string): number {
  let at = 0
  while (at < rest.length) {
    const 行尾 = rest.indexOf(LF, at)
    const 行 = rest.slice(at, 行尾 < 0 ? rest.length : 行尾).replace(TAIL_BLANK, '')
    if (行 === '---' || 行 === '---' + CR) return at
    if (行尾 < 0) break
    at = 行尾 + 1
  }
  return -1
}
