/** 搜索查询串的解析。纯函数、不碰 SQL——`docs/期-03-设计.md` §4.2 那张运算符表的唯一落地。
 *
 *  放 shared 的理由与 `shared/tags.ts` 一样：解析规则只能有一份。渲染层要拿它判断
 *  「用户此刻敲的这半截算什么」，主进程拿它生成查询计划，两边各写一套的话
 *  「什么算一个 `tag:`」迟早会有两种答案。
 *
 *  三条规则是实测逼出来的，不是设计偏好（§2.8 / §4.5）：
 *  1. **空串与全空格绝不下发**——空 MATCH 串会让 FTS5 抛 `syntax error near ""`，所以给
 *     `empty`，由查询层短路。
 *  2. **`OR` 只认大写**——中文日记里两个小写字母 `or` 是文本的概率远大于连接词。
 *  3. **认不出来就整串按字面搜**——引号没闭合、`kind:` 后面没值时，用户多半在搜一句
 *     带引号的话。把它当语法错误报是最糟糕的答复，所以所有失败分支都收进 `literal`。 */

import { normalizeTagKey } from './tags'

export type SearchField = 'both' | 'title' | 'content'
export type SearchMode = 'match' | 'like'

export interface SearchTerm {
  text: string
  field: SearchField
  mode: SearchMode
  negate: boolean
  /** 用户写成了 `"…"`。trigram 本来就是精确子串，加不加引号语义相同（§4.2），
   *  留着它只为手册页能解释「为什么这两种写法结果一样」 */
  quoted: boolean
}

export interface SearchFilters {
  kind?: 'diary' | 'article'
  /** 归一后的标签路径，前缀匹配：`a/b` 命中 `a/b` 与 `a/b/c`，不命中 `a/bx`（D5） */
  tag?: string
  /** 主题名，ASCII 大小写不敏感的精确匹配 */
  topic?: string
  /** 前缀匹配 `Entry.entry_date`：`2026-09` 与 `2026-09-22` 都合法 */
  date?: string
}

export interface ParsedQuery {
  /** 组间 AND、组内 OR。`A OR B C` → [[A,B],[C]] */
  groups: SearchTerm[][]
  exclude: SearchTerm[]
  filters: SearchFilters
  /** 没有任何正向词也没有过滤器：查询层必须在这里短路 */
  empty: boolean
  /** 语法不完整时，整串按字面子串搜（§4.5 第三种非正常态） */
  literal?: string
}

/** ≥3 个**码点**才交给 `MATCH`。用码点不是随手严谨：一个 emoji 或生僻汉字是代理对，
 *  按 UTF-16 长度算会把两个码点当三个，送去 `MATCH` 又是一次静默 0 命中（§2.2）。 */
export function termMode(text: string): SearchMode {
  return Array.from(text).length >= 3 ? 'match' : 'like'
}

/** FTS5 短语：整串加引号、里面的 `"` 双写。probe7 2a 验过 `双引号""测试` 原样命中。 */
export function ftsPhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`
}

/** trigram 索引能加速 `LIKE`，但**一旦带上 `escape` 子句，执行计划里的 `L1` 就没了**
 *  （§2.4 坑 1：带百分号的查询在 6 万条上要 192ms）。所以转义规则固定，
 *  而 `escape` 只在串里真含这三个字符时才附。 */
export function likePattern(text: string): { pattern: string; escaped: boolean } {
  const needed = /[%_\\]/.test(text)
  return {
    pattern: needed ? text.replace(/[\\%_]/g, (c) => '\\' + c) : text,
    escaped: needed,
  }
}

/** 前缀只在 token 的最开头算，且只认这套全小写的写法：`Title:` 落回普通文本，
 *  比「大写就当运算符、不大写就当文本」两套行为好解释。 */
const FIELD_PREFIX = /^(title|content):/
const FILTER_PREFIX = /^(tag|topic|kind|date):/

function mkTerm(text: string, field: SearchField, negate: boolean, quoted: boolean): SearchTerm {
  return { text, field, mode: termMode(text), negate, quoted }
}

/** 吃一个 token：引号内可以带空格；引号没闭合返回 null（→ 整串字面兜底）。 */
function eatToken(text: string, from: number): { token: string; quoted: boolean; next: number } | null {
  if (text[from] === '"') {
    const close = text.indexOf('"', from + 1)
    if (close === -1) return null
    return { token: text.slice(from + 1, close), quoted: true, next: close + 1 }
  }
  let i = from
  while (i < text.length && !/\s/.test(text[i])) i++
  return i === from ? null : { token: text.slice(from, i), quoted: false, next: i }
}

function emptyResult(完整: boolean): ParsedQuery {
  return { groups: [], exclude: [], filters: {}, empty: 完整 }
}

function literalFallback(raw: string): ParsedQuery {
  const text = raw.trim()
  if (!text) return emptyResult(true)
  const out = emptyResult(false)
  out.groups = [[mkTerm(text, 'both', false, false)]]
  out.literal = text
  return out
}

/** 值为空（`kind:` 后面什么都没有）或值不合法（`kind:草稿`）都算语法不完整，
 *  返回 false 让调用方整串字面兜底。 */
function putFilter(key: string, value: string, filters: SearchFilters): boolean {
  const v = value.trim()
  if (!v) return false
  switch (key) {
    case 'kind':
      if (v !== 'diary' && v !== 'article') return false
      filters.kind = v
      return true
    case 'tag':
      filters.tag = normalizeTagKey(v)
      return true
    case 'topic':
      filters.topic = v
      return true
    case 'date':
      filters.date = v
      return true
    default:
      return false
  }
}

function hasFilters(f: SearchFilters): boolean {
  return Boolean(f.kind || f.tag || f.topic || f.date)
}

/** 查询串 → 结构。永不抛错：抛错的搜索框会把用户的输入吞掉。 */
export function parseQuery(raw: string): ParsedQuery {
  const text = (raw ?? '').trim()
  if (!text) return emptyResult(true)

  const out = emptyResult(false)
  const filters = out.filters
  /** 上一个正向词所在的组；`OR` 把下一个正向词并进来 */
  let lastGroup = -1
  /** 刚读到一个 `OR`，等下一个正向词并入。局部变量——跨调用残留会让下一次搜索凭空多一组 */
  let pendingOr = false

  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (i >= text.length) break

    let negate = false
    if (text[i] === '-') {
      // 光一个 `-`（后面是空白或到串尾）不算取反，是用户打了一半的运算符 → 整串字面
      if (i + 1 >= text.length || /\s/.test(text[i + 1])) return literalFallback(text)
      negate = true
      i++
    }

    // 裸 `#a/b` 等价 `tag:a/b`：与标签视图同一套归一，都走 normalizeTagKey
    if (text[i] === '#' && !/\s/.test(text[i + 1] ?? ' ')) {
      const got = eatToken(text, i + 1)
      if (!got || !putFilter('tag', got.token, filters)) return literalFallback(text)
      i = got.next
      continue
    }

    const filter = FILTER_PREFIX.exec(text.slice(i))
    if (filter) {
      const got = eatToken(text, i + filter[0].length)
      if (!got || !putFilter(filter[1], got.token, filters)) return literalFallback(text)
      i = got.next
      continue
    }

    const field = FIELD_PREFIX.exec(text.slice(i))
    const wordStart = i + (field ? field[0].length : 0)
    const got = eatToken(text, wordStart)
    if (!got || !got.token) return literalFallback(text)
    i = got.next

    // `OR` 必须是裸 token、不带字段前缀、不带取反、不带引号：`玻璃 OR 琉璃` 才并集
    if (!field && !negate && !got.quoted && got.token === 'OR') {
      if (lastGroup < 0) return literalFallback(text)
      pendingOr = true
      continue
    }

    if (negate) {
      out.exclude.push(mkTerm(got.token, (field?.[1] as SearchField) ?? 'both', true, got.quoted))
      // 取反项不参与组内并集（它们最后整组减法），所以 OR 到此为止
      pendingOr = false
      continue
    }

    const term = mkTerm(got.token, (field?.[1] as SearchField) ?? 'both', false, got.quoted)
    if (pendingOr) {
      // 并入上一组。字段/长度不同也照并——§5.3 的三段式里每个词各自一条查询，
      // 组内本来就是 JS 集合的并，`title:A OR B` 不需要额外语法。
      out.groups[lastGroup]?.push(term)
      pendingOr = false
      continue
    }
    out.groups.push([term])
    lastGroup = out.groups.length - 1
  }

  if (!out.groups.length && !out.exclude.length && !hasFilters(filters)) return literalFallback(text)
  return out
}
