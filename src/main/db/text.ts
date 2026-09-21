/** 跨库改名。标签重命名与主题重命名共用这一套（`docs/期-02-设计.md` §2.3）——
 *  两者本质相同：**正文是真相源，所以改名 = 改正文 + 重解析**。
 *
 *  三条规矩，每条都对应一类真实事故：
 *  1. **只整 token 替换。** 拿子串全文替换会顺手改掉散文里无辜的词（把 `#工作` 改成
 *     `#办公` 时，正文那句「认真工作的态度」不该跟着变）。命中的位置一律由解析器给。
 *  2. **先 dry-run 再动手。** `count*` 系列不写任何东西，确认弹层那句「会改动 N 处 / M 篇」
 *     靠它，用户点确认之前就得看见代价。
 *  3. **一个事务 + 改前快照。** 见 entries.ts 的 `bulkRewriteContent`。 */

import { findLinkRanges, normalizeLinkKey } from '../../shared/links'
import { findTagRanges, normalizeTagKey } from '../../shared/tags'
import type { RenameImpact } from '../../shared/types'
import * as entries from './entries'
import { getDatabase, transact } from './index'

interface Edit {
  from: number
  to: number
  text: string
}

interface Plan {
  id: number
  content: string
}

/** 倒序 splice：前面的下标不会因为后面的替换而错位。 */
function applyEdits(content: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.from - a.from)
  let out = content
  for (const e of sorted) out = out.slice(0, e.from) + e.text + out.slice(e.to)
  return out
}

/* ─ 标签 ─ */

/** `#a` 改名成 `#x` 时，`#a/b` 也要变成 `#x/b`——Obsidian 的子孙跟着搬，
 *  否则「父改子不改」会把一棵树劈成两半。命中的判定用归一后的 name，
 *  写回去时**保留子孙那几级用户自己的写法**。 */
function tagEdits(content: string, from: string, to: string): Edit[] {
  const depth = from.split('/').length
  const edits: Edit[] = []

  for (const r of findTagRanges(content)) {
    if (r.name !== from && !r.name.startsWith(`${from}/`)) continue
    const segs = r.raw.slice(1).split('/')
    const rest = segs.slice(depth)
    edits.push({ from: r.from, to: r.to, text: `#${[to, ...rest].join('/')}` })
  }

  return edits
}

/** 哪些条目可能带这个标签（含子孙）。
 *
 *  走 `EntryTag` 而不是全库扫正文：`#a/b/c` 会给 a、a/b、a/b/c 各插一行（见 db/tags.ts），
 *  所以「带 a 的条目」这个集合天然包含所有子孙写法，一次索引查询就够。 */
function entriesWithTag(name: string): { id: number; content: string }[] {
  return getDatabase()
    .prepare(
      `select e.id, e.content from Entry e
       join EntryTag et on et.entry_id = e.id
       join Tag t on t.id = et.tag_id
       where t.name = ? and e.deleted_at is null`
    )
    .all(name) as unknown as { id: number; content: string }[]
}

export function countTagRename(fromName: string): RenameImpact {
  const from = normalizeTagKey(fromName)
  let hits = 0
  let count = 0
  for (const row of entriesWithTag(from)) {
    const n = tagEdits(row.content, from, from).length
    if (n === 0) continue
    hits += n
    count++
  }
  return { entries: count, hits }
}

/** 把标签改名的**待写内容**算出来（不写库）。 */
function tagPlans(from: string, to: string): { id: number; content: string }[] {
  const out: Plan[] = []
  for (const row of entriesWithTag(from)) {
    const edits = tagEdits(row.content, from, to)
    if (edits.length === 0) continue
    const content = applyEdits(row.content, edits)
    if (content !== row.content) out.push({ id: row.id, content })
  }
  return out
}

/** 标签改名。返回实际改动的条目数与出现处数。
 *
 *  `Tag` 行按设计留着不删（用户配的颜色/说明不跟着内容消失），新名字的行由
 *  重解析自己插出来。**颜色只在「用户真的指定过」时才搬过去**：
 *  `color is null` 表示「一直用哈希色」，那是派生值不是用户的选择，搬过去反而会把
 *  新标签钉在一个和它的名字不搭的颜色上。
 *
 *  子孙的配置一起搬。正文那边 `tagEdits` 会把 `#a/b` 改成 `#x/b`，这里若不跟着搬，
 *  用户在 `#a/b` 上配的颜色就 silently 掉在一个孤儿行上了——与「只增不删」的初衷相反。 */
export function renameTag(fromName: string, toName: string): { entries: number; hits: number } {
  const from = normalizeTagKey(fromName)
  const to = normalizeTagKey(toName)
  if (!from || !to) throw new Error('标签名不能为空')
  if (from === to) return { entries: 0, hits: 0 }

  const impact = countTagRename(from)
  if (impact.entries === 0) throw new Error(`没有正文在用 #${fromName}，无需改名`)

  const db = getDatabase()
  // 整棵子树里用户指定过的配置（color 或 description 非空）。哈希色不在其中。
  //
  // 不用 `name like '前缀/%'` 筛：`_` 和 `%` 是标签里的合法字符（`\p{L}\p{N}_/-`），
  // 会被 LIKE 当通配符吃掉。配过色的行本来就只有少数，取出来在前缀上过滤更便宜也更准。
  const overrides = db
    .prepare('select name, display, color, description from Tag where color is not null or description is not null')
    .all()
    .filter((row) => {
      const name = String(row.name)
      return name === from || name.startsWith(`${from}/`)
    }) as unknown as { name: string; display: string; color: number | null; description: string | null }[]

  const plans = tagPlans(from, to)
  const changed = transact(() => {
    const n = entries.bulkRewriteContent(plans)
    const carry = db.prepare(
      `insert into Tag(name, display, color, description) values(?, ?, ?, ?)
       on conflict(name) do update set color = excluded.color, description = excluded.description`
    )
    // 正文改完了、配置只搬一半的话，用户会看见同一个标签两种颜色
    const rootDisplay = toName.split('/').pop() ?? toName
    for (const row of overrides) {
      const rest = row.name.slice(from.length)
      carry.run(`${to}${rest}`, rest ? row.display : rootDisplay, row.color ?? null, row.description ?? null)
    }
    return n
  })

  return { entries: changed, hits: impact.hits }
}

/* ─ 主题（正文里的 `[[主题名]]`） ─ */

/** `[[旧名]]` / `[[旧名|别名]]` / `[[旧名#锚点]]` 三种写法都要改到，
 *  别名与锚点原样留着。重建时按解析器认得的那个顺序：目标 → `#锚点` → `|别名`。 */
function linkEdits(content: string, entryDate: string, key: string, toName: string): Edit[] {
  const edits: Edit[] = []

  for (const r of findLinkRanges(content, entryDate)) {
    if (r.link.isDate || r.link.key !== key) continue
    const inner = [toName, r.link.anchor ? `#${r.link.anchor}` : '', r.link.alias ? `|${r.link.alias}` : ''].join(
      ''
    )
    edits.push({ from: r.from, to: r.to, text: `[[${inner}]]` })
  }

  return edits
}

/** 候选条目先用 Link 表缩范围，再用解析器定位置与计数。
 *
 *  `target_id is null` 那一支不能漏：悬空的 `[[旧名]]` 正是改名时最容易被忘掉的一批，
 *  改完它们就该落到新名字的主题上了。 */
function candidatesWithLink(key: string): { id: number; content: string; entry_date: string }[] {
  return getDatabase()
    .prepare(
      `select distinct e.id, e.content, e.entry_date from Entry e
       join Link l on l.source_id = e.id and l.source_type = 'entry'
       where l.target_raw = ? and (l.target_type = 'topic' or l.target_id is null)
         and e.deleted_at is null`
    )
    .all(key) as unknown as { id: number; content: string; entry_date: string }[]
}

export function countTopicRename(fromName: string): RenameImpact {
  const key = normalizeLinkKey(fromName)
  let hits = 0
  let count = 0
  for (const row of candidatesWithLink(key)) {
    const n = linkEdits(row.content, row.entry_date, key, fromName).length
    if (n === 0) continue
    hits += n
    count++
  }
  return { entries: count, hits }
}

/** 算出「把正文里指向 `fromName` 的双链改成 `toName`」要写的内容，不写库。
 *
 *  单独给出来是因为主题改名的完整动作是**改 `Topic.name` + 改这几篇正文**，两步必须
 *  在一个事务里：只改了名字的话正文还写着旧名（且旧名已无人认领），只改正文的话
 *  这些 `[[新名]]` 会全部变成悬空。所以由 `topics.rename` 把这里和它自己的
 *  `update` 裹进同一个 `transact`。 */
export function topicLinkPlans(fromName: string, toName: string): { id: number; content: string }[] {
  const key = normalizeLinkKey(fromName)
  const out: Plan[] = []
  for (const row of candidatesWithLink(key)) {
    const edits = linkEdits(row.content, row.entry_date, key, toName)
    if (edits.length === 0) continue
    const content = applyEdits(row.content, edits)
    if (content !== row.content) out.push({ id: row.id, content })
  }
  return out
}

/** 只改正文的那一半，给「主题行已经改好了」或单独的批量修链场景用。 */
export function rewriteTopicLinks(fromName: string, toName: string): { entries: number; hits: number } {
  const impact = countTopicRename(fromName)
  const plans = topicLinkPlans(fromName, toName)
  return { entries: transact(() => entries.bulkRewriteContent(plans)), hits: impact.hits }
}
