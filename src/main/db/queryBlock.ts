/** 查询块 → SQL → 行（期-07 §二 §三）。
 *
 *  这一层是**全应用唯一**把用户写的东西变成 SQL 的地方，所以它的形状就是一条纪律：
 *  - 列名一律从 `COL` / `SORT_COLS` 这两张白名单里查表得到，查不到就报错，
 *    **用户给的字符串永远进不了 SQL 文本**；
 *  - 值一律 `?` 绑参，一个字符串拼接都没有；
 *  - `limit` 在解析层已经是 1~2000 的整数，这里再乘 2 只用于"有没有被截断"的判据。
 *
 *  为什么不用 `shared/query.ts` 那套三段式（候选集 → JS 集合运算 → 回表）：
 *  搜索要的是相关度排序与跨列 AND/OR，那套结构是 bm25 逼出来的；查询块要的是一次
 *  带 limit 的取行，SQLite 自己就能把这件事做完。两条路各留各的形状，别互相凑。 */

import { getDatabase } from './index'
import * as fts from './fts'
import type { QueryPlan, Column } from '../../shared/queryLang'
import { SORT_COLS } from '../../shared/queryLang'
import type { QueryResult, QueryRow } from '../../shared/types'

/** 白名单：计划里的列名 → SQL 里的表达式。查不到 = 解析层漏了，宁可抛错也不拼字符串 */
const COL: Record<Column, string> = {
  entry_date: 'e.entry_date',
  created_at: 'e.created_at',
  updated_at: 'e.updated_at',
  promoted_at: 'e.promoted_at',
  title: 'e.title',
  kind: 'e.kind',
  topic: 'tp.name',
  body: 'e.content',
  props: '',
}

/** `LIKE` 里用户给的值要转义 `%_\`，且**只在真含这三个字符时才附 escape 子句**：
 *  带了 escape 就会从执行计划里丢掉 trigram 索引（期-03 §2.4 坑 1，6 万条上 192ms）。 */
function likeValue(text: string): { value: string; escaped: boolean } {
  const needed = /[%_\\]/.test(text)
  return {
    value: '%' + (needed ? text.replace(/[\\%_]/g, (c) => '\\' + c) : text) + '%',
    escaped: needed,
  }
}

/** `%` 前缀都不要的那种：标签与日期的前缀匹配 */
function prefixValue(text: string): { value: string; escaped: boolean } {
  const needed = /[%_\\]/.test(text)
  return {
    value: (needed ? text.replace(/[\\%_]/g, (c) => '\\' + c) : text) + '%',
    escaped: needed,
  }
}

interface Built {
  sql: string
  params: (string | number | null)[]
  notes: string[]
}

/** 计划 → SQL。这里抛的都是**编程错**（白名单没盖住计划里的列），不是用户错：
 *  用户错在 `shared/queryLang.ts` 就该被拦下了。
 *
 *  `ftsReady` 由调用方给（`runQuery` 里就是 `fts.isReady()`）：这一层因此是纯函数，
 *  能不开库、不启应用就在 node 里对着一份库副本跑验收（`scratch/p7-sql-test.mjs`）。 */
export function buildSql(plan: QueryPlan, ftsReady: boolean): Built {
  const where: string[] = ['e.deleted_at is null']
  const params: (string | number | null)[] = []
  const notes: string[] = []
  /** 主题条件要 `tp.name`，而 join 本来就在，所以不需要额外开关——这里留着只是给人看的 */
  let indexDowngraded = false

  for (const c of plan.conds) {
    switch (c.kind) {
      case 'tag':
        where.push(
          `exists (select 1 from EntryTag et join Tag tg on tg.id = et.tag_id
                   where et.entry_id = e.id and (tg.name = ? or tg.name like ? escape '\\'))`
        )
        params.push(c.name, prefixValue(c.name).value)
        break
      case 'topic':
        where.push('tp.name = ? collate nocase')
        params.push(c.name)
        break
      case 'kind':
        where.push('e.kind = ?')
        params.push(c.value)
        break
      case 'date': {
        const p = prefixValue(c.prefix)
        where.push(`e.entry_date like ?${p.escaped ? " escape '\\'" : ''}`)
        params.push(p.value)
        break
      }
      case 'has':
        where.push(c.value === 'promoted' ? 'e.promoted_at is not null' : 'e.topic_id is not null')
        break
      case 'word': {
        if (c.mode === 'match' && ftsReady) {
          // trigram 是真子串语义，整串加引号当一个短语（期-03 §2.2）
          where.push('e.id in (select rowid from EntryFts where EntryFts match ?)')
          params.push(`"${c.text.replace(/"/g, '""')}"`)
          break
        }
        if (c.mode === 'match') {
          // 索引还没追平（首帧之后分批灌）。这时候走 MATCH 会得到一个**假 0 行**，
          // 所以退回 LIKE 慢一点也要给真结果，并把这件事写在 notes 里告诉界面
          indexDowngraded = true
        }
        const p = likeValue(c.text)
        const esc = p.escaped ? " escape '\\'" : ''
        where.push(`(e.title like ?${esc} or e.content like ?${esc})`)
        params.push(p.value, p.value)
        break
      }
      case 'cmp': {
        if (c.col === 'props') {
          // 属性名已经在解析层验过字符集（§0.2 第 2 条），这里只管比法
          const path = `$.${c.prop}`
          if (c.op === '~') {
            const p = likeValue(c.value)
            where.push(`coalesce(json_extract(e.props, ?), '') like ?${p.escaped ? " escape '\\'" : ''}`)
            params.push(path, p.value)
            break
          }
          const num = Number(c.value)
          const isNum = c.value !== '' && Number.isFinite(num)
          where.push(
            `${isNum ? 'cast(json_extract(e.props, ?) as real)' : "coalesce(json_extract(e.props, ?), '')"} ${nullSafe(c.op)} ?`
          )
          params.push(path, isNum ? num : c.value)
          break
        }
        const expr = colExpr(c.col)
        if (c.col === 'body') {
          const p = likeValue(c.value)
          where.push(`e.content like ?${p.escaped ? " escape '\\'" : ''}`)
          params.push(p.value)
          break
        }
        const p = c.op === '~' ? likeValue(c.value) : { value: c.value, escaped: false }
        where.push(`${expr} ${c.op === '~' ? `like ?${p.escaped ? " escape '\\'" : ''}` : nullSafe(c.op) + ' ?'}`)
        params.push(p.value)
        break
      }
    }
  }

  if (indexDowngraded) notes.push('全文索引还在建，这次按字面查（会慢一点）')

  const orderBy = plan.order
    ? `${colExpr(plan.order.col)}${plan.order.desc ? ' desc' : ' asc'}, e.id asc`
    : 'e.entry_date desc, e.id asc'

  // 多取**一条**：截断判据不该再来一次 count 查询（§0.2：一次查询 0.2~5ms，但那是白花的）
  const limit = plan.limit + 1
  return {
    sql: `select e.id, e.kind, e.title, e.entry_date, e.created_at, e.updated_at, e.promoted_at,
                 e.props, tp.name as topic
          from Entry e left join Topic tp on tp.id = e.topic_id
          where ${where.join(' and ')}
          order by ${orderBy}
          limit ?`,
    params: [...params, limit],
    notes,
  }
}

function colExpr(col: Column): string {
  const expr = COL[col]
  if (!expr) throw new Error(`白名单里没有列 ${col}`)
  return expr
}

/** `=` / `!=` 换成 `is` / `is not`：日记的 title 大多是 NULL，
 *  用 `<>` 比会把它们全排除在外——用户写 `title != "x"` 想看到的是"其它都要" */
function nullSafe(op: string): string {
  return op === '=' ? 'is' : op === '!=' ? 'is not' : op
}

/* 校验白名单与 COL 两张表不会各说各话：sort 名单必须是 COL 的子集且不含 body/props */
for (const c of SORT_COLS) {
  if (c === 'body' || c === 'props') throw new Error(`sort 白名单里出现了 ${c}`)
}

export function runQuery(plan: QueryPlan): QueryResult {
  const db = getDatabase()
  const { sql, params, notes } = buildSql(plan, fts.isReady())
  const t = Date.now()
  const raw = db.prepare(sql).all(...params) as {
    id: number
    kind: 'diary' | 'article'
    title: string | null
    entry_date: string
    created_at: string
    updated_at: string
    promoted_at: string | null
    props: string
    topic: string | null
  }[]
  const over = raw.length > plan.limit
  const rows: QueryRow[] = (over ? raw.slice(0, plan.limit) : raw).map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    title: r.title,
    entryDate: r.entry_date,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    promotedAt: r.promoted_at,
    topicName: r.topic,
    props: safeProps(r.props),
  }))
  return {
    view: plan.view,
    cols: plan.cols.map((c) => (c.prop ? `props.${c.prop}` : c.col)),
    rows,
    truncated: over,
    ms: Date.now() - t,
    notes,
  }
}

/** 库里 `props` 有 `check(json_valid(...))`，理论上一定是 JSON；真读坏了也不该把
 *  整块查询炸掉——那是用户视角下"查询挂了"，而实际只是那一篇的属性脏了 */
function safeProps(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
