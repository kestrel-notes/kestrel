/** 查询层：一条查询串怎么变成结果行。`docs/期-03-设计.md` §5.3 的三段式落地。
 *
 *  三段各干什么、为什么这么分，全是 §2.5 那六组数字逼出来的（同一语义的两种写法，
 *  6 万条上差一个数量级）：
 *
 *      ①  每个正向词一条单查询，只碰 EntryFts、只出 rowid
 *          （≥3 字走 MATCH，1~2 字走同表 LIKE；§2.2 那条静默 0 命中的死缝由这里绕开）
 *      ②  集合运算在 JS 里做：组内并、组间交、取反项减
 *          （SQL 一句流 `and` 是 152.5ms，两条单查询 + JS 交集是 68.6ms，probe9）
 *      ③  拿 ≤50 个 id 回 Entry 取正文，一处 where 挡 kind / date / deleted_at
 *          （先取 rowid 再回表：355.6ms → 0.8ms，probe6 A/B）
 *
 *  `total` 的口径要提前说清：它是**第 ② 段结束时**的候选数，第 ③ 段的 kind / date 谓词
 *  还在它后面。所以带这两个过滤器时它是「至少这么多」的近似——设计 §2.5 明说这两个谓词
 *  基数太大、不单独取集合，代价就是这里报不准。面板把它写成「命中 N+」正是为此。 */

import {
  ftsPhrase,
  likePattern,
  parseQuery,
  type SearchFilters,
  type SearchTerm,
} from '../../shared/query'
import type {
  FtsStatus,
  SearchPath,
  SearchResult,
  SearchResultRow,
} from '../../shared/types'
import { isReady, status as ftsStatus } from './fts'
import { getDatabase } from './index'

/** 第 ① 段每条单查询的候选上限（§5.3）。再大就不值得：面板只画 50 行。 */
const CANDIDATE_CAP = 2000

/** 1~2 字词（LIKE 档）单独一个更小的上限。
 *
 *  这个数是 §10-7 在 6 万条库上量出来的：同一条 `content like '%态谱%'`，取 2001 行要
 *  77~110ms，取 151 行只要 6~8ms——LIKE 档的钱几乎全花在"多取的那些行"上，而不是像 MATCH
 *  那样花在 bm25 打分上（MATCH 取 51 与取 2001 都是 11~12ms）。而 LIKE 档的排序本来就是
 *  `rowid desc`（§8-D4 的新在前），取最新的 300 条足够喂交集与 kind/date 过滤。
 *  代价说清楚：`total` 会更早撞到上限，面板 accordingly 显示「命中 300+」。 */
const LIKE_CAP = 300

const DEFAULT_LIMIT = 50

/** 回表时多取几倍 id：第 ③ 段的 kind / date 谓词会刷掉一批，一次取满比翻next-page便宜。 */
const FETCH_SLACK = 3

/** 上下文左右各留多少字（§4.1「前后各约 24 字」） */
const CONTEXT = 24

/** 一条单查询的候选。`capped` 是「这条查询被上限切过」，面板据此说「2000+」。 */
interface Candidates {
  ids: number[]
  capped: boolean
}

function pluck(sql: string, params: (string | number)[], cap = CANDIDATE_CAP): Candidates {
  const rows = getDatabase()
    .prepare(sql)
    .all(...params, cap + 1) as unknown as { id: number | bigint }[]
  // 每条查询都多要一行：只看「有没有超过上限」，不数总数（数总数在 trigram 上要全扫）
  const capped = rows.length > cap
  return {
    ids: (capped ? rows.slice(0, cap) : rows).map((r) => Number(r.id)),
    capped,
  }
}

/** LIKE 的写法只有一条规矩：**能不带 `escape` 就不带**。带上了执行计划里的 `L1` 就没了
 *  （§2.4 坑 1：`%100\%%` 这种查询在 6 万条上要 192ms）。所以转义只在串里真含
 *  `% _ \` 时才附子句，其余一律裸 like。 */
function likeClause(col: string, text: string): { sql: string; value: string } {
  const { pattern, escaped } = likePattern(text)
  return {
    sql: `${col} like ?${escaped ? ` escape '\\'` : ''}`,
    value: `%${pattern}%`,
  }
}

/** 第 ① 段：一个词的候选集。
 *
 *  `both` 字段在 MATCH 路径上是**一条**查询（裸短语天然跨列），在 LIKE 路径上是两条
 *  （`title like ? or content like ?` 会让两列都放弃索引）。所以并集在这里做，
 *  顺序按「标题命中在前」——这正是面板想要的次序。 */
function byTerm(term: SearchTerm, useIndex: boolean): Candidates {
  const cols: ('title' | 'content')[] =
    term.field === 'both' ? ['title', 'content'] : [term.field]

  if (useIndex && term.mode === 'match') {
    const expr =
      term.field === 'both'
        ? ftsPhrase(term.text)
        : `${term.field}:${ftsPhrase(term.text)}`
    return pluck(
      `select rowid as id from EntryFts
       where EntryFts match ?
       order by bm25(EntryFts, 5.0, 1.0)
       limit ?`,
      [expr]
    )
  }

  if (useIndex) {
    // 1~2 字词：同一张虚表上的 LIKE，走 trigram 附带的 LIKE 优化（§2.4）。
    // 排序没有 bm25 可用（LIKE 路径没有位置信息），按 rowid 倒序 = 新建在前（§8-D4）。
    // 上限用 LIKE_CAP 而不是 CANDIDATE_CAP：这一档的钱花在"取多少行"上，见那个常量的注释。
    return union(
      cols.map((col) => {
        const { sql, value } = likeClause(col, term.text)
        return pluck(
          `select rowid as id from EntryFts where ${sql} order by rowid desc limit ?`,
          [value],
          LIKE_CAP
        )
      })
    )
  }

  // 索引还没追平：整条查询打到原表。这里带上 `deleted_at is null`，
  // 因为原表扫描没有 bm25 那样的排序可指望，别把回收站的东西挤进前 2000 名。
  return union(
    cols.map((col) => {
      const { sql, value } = likeClause(col, term.text)
      return pluck(
        `select id from Entry where ${sql} and deleted_at is null order by id desc limit ?`,
        [value]
      )
    })
  )
}

/** 并集：先到先得，所以顺序就是「哪条查询排在前面」的顺序。 */
function union(parts: Candidates[]): Candidates {
  const seen = new Set<number>()
  const ids: number[] = []
  let capped = false
  for (const p of parts) {
    if (p.capped) capped = true
    for (const id of p.ids) {
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  if (ids.length > CANDIDATE_CAP) {
    ids.length = CANDIDATE_CAP
    capped = true
  }
  return { ids, capped }
}

/** `tag:a/b` 是**前缀**匹配（§8-D5）：命中 `a/b` 与 `a/b/c`，不命中 `a/bx`。
 *  所以判据是「等于」或「以 `a/b/` 打头」，斜杠是分隔符而不是通配的一部分。
 *
 *  这里的 `escape` 无条件附上：`Tag.name` 里合法字符含 `_`（`shared/tags.ts` 的白名单），
 *  不转义的话 `tag:a_b` 会连 `axb` 一起命中。这跟 FTS 那条「别带 escape」不冲突——
 *  那一条防的是失去 `L1`，而这里是几百行的小表，根本没有 `L1` 可失。 */
function byTag(prefix: string): Candidates {
  const escaped = prefix.replace(/[\\%_]/g, (c) => '\\' + c)
  return pluck(
    `select et.entry_id as id
     from EntryTag et join Tag t on t.id = et.tag_id
     where t.name = ? or t.name like ? escape '\\'
     order by et.entry_id desc
     limit ?`,
    [prefix, `${escaped}/%`]
  )
}

/** 主题名精确匹配、ASCII 大小写不敏感（§4.2）。用 `lower()` 而不是 `collate nocase`：
 *  后者要改列定义，而 `Topic.name` 上的唯一索引是 BINARY 的，正好留着区分 `A` 与 `a` 两个主题。 */
function byTopic(name: string): Candidates {
  return pluck(
    `select e.id from Entry e join Topic t on t.id = e.topic_id
     where lower(t.name) = lower(?)
     order by e.id desc
     limit ?`,
    [name]
  )
}

/** 只有取反项或只有 `kind:` / `date:` 时，候选集是「全部没删的条目」，按新在前。 */
function everything(): Candidates {
  return pluck(
    `select id from Entry where deleted_at is null order by id desc limit ?`,
    []
  )
}

interface EntryRow {
  id: number
  kind: 'diary' | 'article'
  title: string | null
  entry_date: string
  updated_at: string
  content: string
  topic_id: number | null
  topic_name: string | null
}

/** 第 ③ 段：≤ 50×3 个 id 回表，一处 where 挡掉 kind / date / deleted_at。
 *  `limit` 不在这里做（谓词刷完再截），否则带 `kind:` 的查询会莫名其妙少几条。 */
function fetchRows(ids: number[], filters: SearchFilters): EntryRow[] {
  if (!ids.length) return []
  const where = [`e.id in (${ids.map(() => '?').join(', ')})`, 'e.deleted_at is null']
  const params: (string | number)[] = [...ids]
  if (filters.kind) {
    where.push('e.kind = ?')
    params.push(filters.kind)
  }
  if (filters.date) {
    const { pattern, escaped } = likePattern(filters.date)
    where.push(`e.entry_date like ?${escaped ? ` escape '\\'` : ''}`)
    params.push(`${pattern}%`)
  }
  return getDatabase()
    .prepare(
      `select e.id, e.kind, e.title, e.entry_date, e.updated_at, e.content, e.topic_id,
              t.name as topic_name
       from Entry e left join Topic t on t.id = e.topic_id
       where ${where.join(' and ')}
       order by e.id desc`
    )
    .all(...params) as unknown as EntryRow[]
}

/** 逐码元的小写比较，不整体 `toLowerCase()`。
 *
 *  两个理由：① `String.prototype.toLowerCase` 对个别字符（`İ`）会改变长度，整体转一次
 *  之后下标就对不上正文了，而命中区间的下标是这次交付的全部产物；
 *  ② 折叠只按 ASCII 做，跟 SQLite 的 `LIKE` 与 `trigram case_sensitive 0` 对齐（§2.2 只测了
 *  `electron` / `ELECTRON`）。用码元而不是 `text[i].toLowerCase()`：面板一屏要扫 50 行 × 600 字，
 *  逐字符取字符串会造出几万个单字符对象，§10-7 在 6 万条库上量到这一段就是那条查询里最贵的一笔。
 *  顺带一个副作用值得记下：西里尔 `А`/`а` 这种非 ASCII 大小写对，旧实现会在面板里高亮出来而
 *  库里其实搜不到——现在两边一致了。 */
function fold(cu: number): number {
  return cu >= 65 && cu <= 90 ? cu + 32 : cu
}

function ciIndexOf(text: string, needle: string, from: number): number {
  const n = needle.length
  if (!n) return -1
  outer: for (let i = Math.max(0, from); i + n <= text.length; i++) {
    for (let j = 0; j < n; j++) {
      if (fold(text.charCodeAt(i + j)) !== fold(needle.charCodeAt(j))) continue outer
    }
    return i
  }
  return -1
}

/** 上下文与高亮区间。规则（§9）：只显示**首个**命中附近一段，但这一段里所有正向词都标出来。
 *
 *  `title:` 打头的词不参与上下文计算——它命中的是标题，标题自己占一行，
 *  再拿正文里恰好相同的字凑一段「上下文」只会指错位置（§4.4 的 `pos` 也照这条走）。 */
function toRow(r: EntryRow, terms: SearchTerm[]): SearchResultRow {
  const content = r.content ?? ''
  const inContent = terms.filter((t) => t.field !== 'title')

  let first = -1
  let firstLen = 0
  for (const t of inContent) {
    const at = ciIndexOf(content, t.text, 0)
    if (at !== -1 && (first === -1 || at < first)) {
      first = at
      firstLen = t.text.length
    }
  }

  const out: SearchResultRow = {
    id: r.id,
    kind: r.kind,
    title: r.title,
    entryDate: r.entry_date,
    updatedAt: r.updated_at,
    topicName: r.topic_name,
    excerpt: null,
    hits: [],
    pos: null,
  }
  if (first === -1) {
    // 正文里没有可高亮的命中：只命中标题、或整条查询只有过滤器与取反项。
    // 这两种都不给上下文——标题已经单独占一行，再抄一遍没有信息。
    return out
  }

  const from = Math.max(0, first - CONTEXT)
  const to = Math.min(content.length, first + firstLen + CONTEXT)
  // 换行/制表就地换成空格：长度不变，所以窗口内重算的区间仍然对得上
  const window = content.slice(from, to).replace(/[\t\r\n]/g, ' ')

  const hits: Array<[number, number]> = []
  for (const t of inContent) {
    let at = ciIndexOf(window, t.text, 0)
    while (at !== -1 && hits.length <= 32) {
      hits.push([at, at + t.text.length])
      at = ciIndexOf(window, t.text, at + t.text.length)
    }
  }
  hits.sort((a, b) => a[0] - b[0])

  // 省略号是拼上去的，前面的区间整体右移一位——先算区间再加省略号，反过来就错位
  const head = from > 0 ? '…' : ''
  const tail = to < content.length ? '…' : ''
  const shift = head.length

  out.excerpt = head + window + tail
  out.hits = shift ? hits.map(([a, b]) => [a + shift, b + shift]) : hits
  out.pos = first
  return out
}

/** 一次搜索。渲染层只管发字符串、画回执，三段式怎么走的都在这里。 */
export function run(query: string, limit = DEFAULT_LIMIT): SearchResult {
  const parsed = parseQuery(query)
  const status: FtsStatus = ftsStatus()
  const useIndex = isReady()
  const positives = parsed.groups.flat()
  // 有 ≥3 字的词走了 MATCH 就报 match；只有 1~2 字词时报 like（rowid 倒序那条路）；
  // 索引没追平一律 scan
  const path: SearchPath = !useIndex
    ? 'scan'
    : positives.some((t) => t.mode === 'match')
      ? 'match'
      : 'like'

  // 空串在这之前就该被面板拦掉（§10 第 8 项：空 MATCH 串会让 FTS5 抛 syntax error）。
  // 这里再兜一道，是为了 dev.sql 和探针直接调进来的情形。
  if (parsed.empty) return { rows: [], total: 0, capped: false, path, status }

  let capped = false
  const track = (c: Candidates): Candidates => {
    if (c.capped) capped = true
    return c
  }

  /** 第 ② 段的参与者，按优先级排：第一个决定顺序，其余只出集合。
   *  组内多词（`A OR B`）的并集是「先出现的在前」——bm25 只在单成员组里等价于全局序，
   *  两组各自的最优结果并到一起本来就没有可比的分，这里如实按出现序处理。 */
  const parts: Candidates[] = []

  for (const group of parsed.groups) {
    parts.push(track(union(group.map((term) => track(byTerm(term, useIndex))))))
  }
  if (parsed.filters.tag) parts.push(track(byTag(parsed.filters.tag)))
  if (parsed.filters.topic) parts.push(track(byTopic(parsed.filters.topic)))
  if (!parsed.groups.length && !parts.length) parts.push(track(everything()))

  const [driver, ...rest] = parts
  const keeps = rest.map((p) => new Set(p.ids))
  let ordered = driver.ids.filter((id) => keeps.every((s) => s.has(id)))

  // 取反项各一条单查询取集合，然后在 JS 里减。翻成 FTS5 的 NOT 只在 ≥3 字词上可用，
  // 而 1~2 字词的 `NOT LIKE` 根本不走索引（§2.5 红线）——两条路合成一条，行为也统一了。
  for (const term of parsed.exclude) {
    const drop = new Set(track(byTerm(term, useIndex)).ids)
    ordered = ordered.filter((id) => !drop.has(id))
  }

  // 回收站里的条目本来就在索引里（§5.1：软删不动索引，恢复出来立刻可搜），
  // 所以在这里补一笔减法把 `total` 说圆。不塞进第 ① 段的 where 是给每条 FTS 查询挂
  // join——那正是 §2.5 划的红线；而回收站平时是几十行，减法比 join 便宜得多。
  if (useIndex) {
    const trashed = pluck(`select id from Entry where deleted_at is not null limit ?`, [])
    if (trashed.capped) capped = true
    if (trashed.ids.length) {
      const gone = new Set(trashed.ids)
      ordered = ordered.filter((id) => !gone.has(id))
    }
  }

  const total = ordered.length
  const top = ordered.slice(0, limit * FETCH_SLACK)
  const fetched = fetchRows(top, parsed.filters)

  // SQL 的 `in` 按 rowid 回来，第 ① 段算好的相关性序得在这里复位。
  // 先按名次截到 limit 行、再算上下文：§10-7 在 6 万条上量出来，给 150 行算上下文比给 50 行
  // 贵三倍，而多出来的那 100 行根本不会出现在面板上——它们是这条路径上最大的一笔白花钱。
  const rank = new Map<number, number>()
  top.forEach((id, i) => rank.set(id, i))
  const rows = fetched
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    .slice(0, limit)
    .map((r) => toRow(r, positives))

  return { rows, total, capped, path, status }
}

/** 只给探针与 §10 计时用：这条查询串会走哪条路，不发查询就能答。 */
export function routeOf(query: string): { path: SearchPath; terms: number; filters: string[] } {
  const parsed = parseQuery(query)
  const useIndex = isReady()
  const terms = parsed.groups.flat()
  const filters: string[] = []
  if (parsed.filters.tag) filters.push('tag')
  if (parsed.filters.topic) filters.push('topic')
  if (parsed.filters.kind) filters.push('kind')
  if (parsed.filters.date) filters.push('date')
  return {
    path: !useIndex ? 'scan' : terms.some((t) => t.mode === 'match') ? 'match' : 'like',
    terms: terms.length,
    filters,
  }
}
