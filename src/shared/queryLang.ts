/** 查询块的语言（期-07 §二）。**只解析，不碰 SQL**。
 *
 *  放 shared 的理由与 `shared/query.ts` 一样：解析规则只能有一份。渲染层要拿它把错误
 *  原位显示在围栏下面，主进程拿它生成 SQL——两边各写一套的话「什么算一个 `props.x`」
 *  迟早会有两种答案。
 *
 *  与 `shared/query.ts`（搜索那套查询串）的差别值得写明：搜索是一行、要**永不抛错**，
 *  认不出来就整串按字面去搜（期-03 §4.5 第三种非正常态）。查询块**没有合理的字面兜底**——
 *  一段看不懂的语句拿去当正文搜是垃圾结果——所以这里失败就回报失败。但失败要带
 *  行号列号和一句人话，怎么显示归界面管。
 *
 *  安全红线（`知识网络设计.md` §3.10）：这一层产出的**不是 SQL**，是结构化计划；
 *  SQL 只在 `main/db/queryLang.ts` 里由白名单拼出来，用户给的任何字符串一律参数绑定。
 *  渲染层既拿不到 SQL 文本，也塞不进 SQL 文本。 */

import { isTagName, normalizeTagKey } from './tags'
import { termMode } from './query'

export const QUERY_VIEWS = ['table', 'list', 'cards', 'calendar', 'timeline'] as const
export type QueryView = (typeof QUERY_VIEWS)[number]

/** 默认与上限。上限不是审美：§0.2 量过 171 行已经是 31KB，`limit 20000` 就是把 3MB
 *  塞进一次 IPC 同步调用 */
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 2000

/** `table` 那一行能点的列，也是 `where` 能比的列 */
export type Column =
  | 'entry_date'
  | 'created_at'
  | 'updated_at'
  | 'promoted_at'
  | 'title'
  | 'kind'
  | 'topic'
  | 'body'
  | 'props'

export const ALL_COLS: Column[] = [
  'entry_date',
  'created_at',
  'updated_at',
  'promoted_at',
  'title',
  'kind',
  'topic',
  'body',
  'props',
]

/** `sort` 只认这六列。属性排序不在表里（§七）：属性名是用户随时加的，没法预先建
 *  表达式索引，给一条慢查询换一个"看起来能"不值。 */
export const SORT_COLS: Column[] = ['entry_date', 'created_at', 'updated_at', 'promoted_at', 'title', 'kind']

export type CompareOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~'

/** `from` 的一个词与 `where` 的一句，语义上全都 AND，所以计划里是一条队列 */
export type Condition =
  | { kind: 'tag'; name: string }
  | { kind: 'topic'; name: string }
  | { kind: 'kind'; value: 'diary' | 'article' }
  | { kind: 'date'; prefix: string }
  | { kind: 'has'; value: 'promoted' | 'topic' }
  /** 标题/正文里的一个词。≥3 字走 FTS、1~2 字走 LIKE，判据复用 `termMode()`（§0.2） */
  | { kind: 'word'; text: string; mode: 'match' | 'like' }
  | { kind: 'cmp'; col: Column; op: CompareOp; value: string; prop?: string }

export interface QueryPlan {
  view: QueryView
  /** `table` 视图要显示的列；其他视图忽略 */
  cols: { col: Column; prop?: string; label: string }[]
  conds: Condition[]
  order: { col: Column; desc: boolean } | null
  limit: number
}

export interface QueryBlockError {
  /** 1 起的行号，相对围栏内正文 */
  line: number
  /** 1 起的列号 */
  col: number
  msg: string
}

/** 两种结局之一。写成裸的判别联合、不给 `error` 留一个 `undefined` 的坑位：
 *  带 `error?: undefined` 的那种写法，`'error' in parsed` 收窄完还是 `QueryBlockError | undefined`，
 *  调用方每处都得再判一次空——不如一开始就没有。 */
export type QueryBlockResult = { plan: QueryPlan } | { error: QueryBlockError }

const DATE_COLS = new Set<Column>(['entry_date', 'created_at', 'updated_at', 'promoted_at'])

const at = (line: number, col: number, msg: string): QueryBlockError => ({ line, col, msg })

/* ───────────────────────── 词法 ───────────────────────── */

/** 一个词：引号里可以带空格。返回 null = 引号没闭合或吃到头。
 *
 *  先认词、再判 `or`（而不是先按 `and` 切整句）：§0.2 第 3 条实测过，先切会让
 *  `from #" or 1=1 --` 这种**值里带 or** 的写法收到一句"不支持 or"，答不到点上。 */
function eat(input: string, from: number): { text: string; quoted: boolean; next: number } | null {
  let i = from
  while (i < input.length && input[i] === ' ') i++
  if (i >= input.length) return null
  if (input[i] === '"') {
    const close = input.indexOf('"', i + 1)
    if (close === -1) return null
    return { text: input.slice(i + 1, close), quoted: true, next: close + 1 }
  }
  const start = i
  while (i < input.length && input[i] !== ' ') i++
  return { text: input.slice(start, i), quoted: false, next: i }
}

/** `props.心情` 拆成 `{col:'props', prop:'心情'}`；名单外直接给一句人话。
 *  属性名要验字符集（§0.2 第 2 条）：不验它就会一路走进 `json_extract(props, ?)`
 *  的路径参数，SQLite 抛 `bad JSON path: '$."mood")||1'`——那不是注入（值本来就绑参），
 *  但把库的内部文案端到界面上是烂体验。 */
function columnOf(token: string): { col: Column; prop?: string } | string {
  const t = token.toLowerCase()
  if (t === 'props' || t.startsWith('props.')) {
    const key = token.slice(token.indexOf('.') + 1)
    if (!key) return 'props. 后面没写属性名'
    if (!/^[\w\u4e00-\u9fff][\w\u4e00-\u9fff -]{0,63}$/.test(key))
      return `属性名「${key}」里有非法字符（只用字母、汉字、数字、下划线、空格）`
    return { col: 'props', prop: key }
  }
  if (t === 'date') return { col: 'entry_date' }
  if ((ALL_COLS as string[]).includes(t)) return { col: t as Column }
  return `没有「${token}」这一列（可用：${ALL_COLS.join(' / ')}、props.名）`
}

/* ───────────────────────── 各句 ───────────────────────── */

function parseHead(line: string): { view: QueryView; cols: QueryPlan['cols'] } | QueryBlockError {
  const head = line.split(/\s+/)[0].toLowerCase()
  const view = (QUERY_VIEWS as readonly string[]).includes(head) ? (head as QueryView) : null
  if (!view) return at(1, 1, `开头得是 ${QUERY_VIEWS.join(' / ')} 之一，看到的是「${head || '（空）'}」`)
  const cols: QueryPlan['cols'] = []
  if (view === 'table') {
    for (const raw of line.slice(head.length).split(',')) {
      const t = raw.trim()
      if (!t) continue
      const got = columnOf(t)
      if (typeof got === 'string') return at(1, 1, got)
      // 正文可以**比**（`where body ~ 词`），不能**显示**：结果一律不带正文。
      // §0.2 量过同一条件 100 行：不带 3KB、带 35KB，而表格里那一列也没地方读
      if (got.col === 'body') return at(1, 1, '正文不能当列显示：结果不带正文，只能拿它 ~（包含）比')
      cols.push({ col: got.col, prop: got.prop, label: t })
    }
  }
  return { view, cols }
}

/** `from`：词与词之间只认 `and`。 */
function parseFrom(arg: string, line: number): Condition[] | QueryBlockError {
  const out: Condition[] = []
  let at0 = 0
  let needTerm = true
  while (at0 < arg.length) {
    const got = eat(arg, at0)
    if (!got) return at(line, at0 + 1, '引号没闭合，或者这一句没写完')
    at0 = got.next
    if (!got.quoted) {
      const w = got.text.toLowerCase()
      if (w === 'and') {
        if (needTerm) return at(line, at0 - 3, '`and` 前面没有条件')
        needTerm = true
        continue
      }
      if (w === 'or')
        return at(line, at0 - 2, '这一句不支持 or：要并两种条件就写两个查询块')
    }
    const one = parseTerm(got.text, got.quoted, line, at0 - got.text.length + 1)
    if ('error' in one) return one.error
    out.push(one.cond)
    needTerm = false
  }
  if (!out.length) return at(line, arg.length + 1, 'from 后面是空的')
  if (!needTerm) return out
  return at(line, arg.length + 1, '最后一句没写完')
}

function parseTerm(
  token: string,
  quoted: boolean,
  line: number,
  col: number
): { cond: Condition } | { error: QueryBlockError } {
  if (!quoted && token.startsWith('#')) {
    const raw = token.slice(1)
    if (!raw) return { error: at(line, col, '`#` 后面没写标签名') }
    if (!isTagName(raw)) return { error: at(line, col, `「${raw}」不是一个能读回来的标签名`) }
    return { cond: { kind: 'tag', name: normalizeTagKey(raw) } }
  }
  const pref = /^(kind|topic|date|has):(.*)$/i.exec(token)
  if (pref && !quoted) {
    const key = pref[1].toLowerCase()
    const value = pref[2]
    if (!value) return { error: at(line, col, `${key}: 后面没有值`) }
    if (key === 'kind') {
      if (value !== 'diary' && value !== 'article')
        return { error: at(line, col, 'kind 只有 diary（日记）与 article（文章）两种') }
      return { cond: { kind: 'kind', value } }
    }
    if (key === 'topic') return { cond: { kind: 'topic', name: value } }
    if (key === 'date') {
      if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(value))
        return {
          error: at(line, col, `date: 要写成 2026 / 2026-09 / 2026-09-24，看到的是「${value}」`),
        }
      return { cond: { kind: 'date', prefix: value } }
    }
    const v = value.toLowerCase()
    if (v !== 'promoted' && v !== 'topic')
      return { error: at(line, col, 'has 只认 has:promoted（升格过的）与 has:topic（归了主题的）') }
    return { cond: { kind: 'has', value: v } }
  }
  if (!token.trim()) return { error: at(line, col, 'from 后面是空的') }
  return { cond: { kind: 'word', text: token, mode: termMode(token) } }
}

/** `where`：**一句一个比较**，要多条件就多写几行 `where`（行与行 AND）。
 *  不给句内 `and` 的理由不是懒：值里本来就可能带 ` and `（"猫 and 狗"），
 *  一句里混着切就会切错，而"哪半截被切走了"用户看不见。 */
function parseWhere(arg: string, line: number): { cond: Condition } | QueryBlockError {
  const m = /^(\S+)\s*(<=|>=|!=|=|>|<|~)\s*/.exec(arg)
  if (!m)
    return at(
      line,
      1,
      `where 里这句看不懂：${arg || '（空）'}（形状是 列 运算符 值，运算符 ∈ = != > >= < <= ~）`
    )
  const got = columnOf(m[1])
  if (typeof got === 'string') return at(line, 1, got)
  const op = m[2] as CompareOp
  const rest = arg.slice(m[0].length)
  const val = eat(rest, 0)
  if (!val) return at(line, m[0].length + 1, '运算符后面没有值')
  const tail = rest.slice(val.next).trim()
  if (tail) return at(line, val.next + 1, `值后面多了「${tail}」：一句只比一样东西，再多写一行 where`)

  const { col, prop } = got
  let value = val.text
  if (col === 'props' && prop) {
    const num = Number(value)
    const isNum = value !== '' && Number.isFinite(num)
    if (!isNum && op !== '=' && op !== '!=' && op !== '~')
      return at(line, 1, `属性「${prop}」要跟文字比，只能写 = != ~（包含）`)
    if (isNum) value = String(num)
    return { cond: { kind: 'cmp', col: 'props', op, value, prop } }
  }
  if (DATE_COLS.has(col)) {
    // 日期列不验形状就会**静默全通**：`entry_date > "(select …)"` 是字符串比较，
    // 括号比数字小，于是所有行都满足条件——§0.2 第 1 条量到的正是这个
    const bare = /^date\((.*)\)$/.exec(value)?.[1] ?? value
    if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(bare))
      return at(line, 1, `${col} 是日期列，值写成 2026 / 2026-01 / 2026-01-31，看到的是「${value}」`)
    // 补齐到完整日期才可比：`entry_date` 存的是 YYYY-MM-DD，写 2026 说的是"2026 年初"
    value = bare.length === 4 ? `${bare}-01-01` : bare.length === 7 ? `${bare}-01` : bare
  }
  if (col === 'kind') {
    if (value !== 'diary' && value !== 'article')
      return at(line, 1, 'kind 只有 diary 与 article 两种')
  }
  if (col === 'body' && op !== '~') return at(line, 1, '正文只能用 ~（包含）比')
  if (col === 'topic' && op === '~') return { cond: { kind: 'cmp', col: 'topic', op, value } }
  return { cond: { kind: 'cmp', col, op, value, prop } }
}

function parseSort(arg: string, line: number): QueryPlan['order'] | QueryBlockError {
  const tokens = arg.split(/\s+/).filter(Boolean)
  if (!tokens.length) return at(line, 6, 'sort 后面没写列名')
  if (tokens.length > 2) return at(line, 6, 'sort 只认一列（多列排序这一期不支持）')
  if (tokens.length === 2 && !/^(asc|desc)$/i.test(tokens[1]))
    return at(line, arg.indexOf(tokens[1]) + 1, 'sort 第二词只能是 asc 或 desc')
  const got = columnOf(tokens[0])
  if (typeof got === 'string') return at(line, 6, got)
  if (got.col === 'body' || got.col === 'props' || !(SORT_COLS as string[]).includes(got.col))
    return at(line, 6, `sort 只能按这六列：${SORT_COLS.join(' / ')}`)
  return { col: got.col, desc: (tokens[1] ?? 'asc').toLowerCase() === 'desc' }
}

function parseLimit(arg: string, line: number): number | QueryBlockError {
  const t = arg.trim()
  if (!/^\d+$/.test(t))
    return at(line, 7, `limit 得是 1~${MAX_LIMIT} 的整数，看到的是「${t || '（空）'}」`)
  const n = Number(t)
  if (n < 1 || n > MAX_LIMIT)
    return at(line, 7, `limit 得是 1~${MAX_LIMIT} 的整数，看到的是 ${n}`)
  return n
}

/* ───────────────────────── 主入口 ───────────────────────── */

/** 查询块正文 → 计划或错误。**永不抛错**：抛错会让编辑层整个红掉，
 *  而这东西是用户一个字一个字打出来的，半途必然不完整。 */
export function parseQueryBlock(src: string): QueryBlockResult {
  const lines = String(src ?? '').split(/\r?\n/)
  let head: { view: QueryView; cols: QueryPlan['cols'] } | null = null
  const conds: Condition[] = []
  let order: QueryPlan['order'] = null
  let limit = DEFAULT_LIMIT

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('--')) continue
    if (!head) {
      const h = parseHead(line)
      if ('view' in h) {
        head = h
        continue
      }
      return { error: h }
    }
    const kw = /^(\S+)(?:\s+([\s\S]*))?$/.exec(line)
    const word = (kw?.[1] ?? '').toLowerCase()
    const arg = kw?.[2] ?? ''
    if (word === 'from') {
      const got = parseFrom(arg, i + 1)
      if (Array.isArray(got)) conds.push(...got)
      else return { error: got }
      continue
    }
    if (word === 'where') {
      const got = parseWhere(arg, i + 1)
      if ('cond' in got) conds.push(got.cond)
      else return { error: got }
      continue
    }
    if (word === 'sort') {
      const got = parseSort(arg, i + 1)
      // 判据得反过来问：错误对象长 `{line, col, msg}`，它也**有 `col` 这一项**
      // （列号），先写 `if ('col' in got)` 会把语法错当成排序列放过去
      if (got && 'msg' in got) return { error: got }
      order = got
      continue
    }
    if (word === 'limit') {
      const n = parseLimit(arg, i + 1)
      if (typeof n === 'number') limit = n
      else return { error: n }
      continue
    }
    return { error: at(i + 1, 1, `不认识「${word}」这一句（可用：from / where / sort / limit）`) }
  }

  if (!head) return { error: at(1, 1, '空的：第一行要写视图名（' + QUERY_VIEWS.join(' / ') + '）') }
  return { plan: { view: head.view, cols: head.cols, conds, order, limit } }
}

/** 围栏内正文：给错误定位与"第几行"显示用 */
export function queryLines(src: string): string[] {
  return String(src ?? '').split(/\r?\n/)
}
