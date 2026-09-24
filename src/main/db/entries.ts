import type {
  ChronicleRow,
  CreateEntryInput,
  DayCount,
  Entry,
  EntryPatch,
  EntrySummary,
  PromoteInput,
} from '../../shared/types'
import { bindable, getDatabase, parseJsonObject, transact } from './index'
import { claimForEntry, reparseEntry } from './links'
import * as props from './props'
import { reparseTags } from './tags'
import * as revision from './revision'

interface EntryRow {
  id: number
  kind: 'diary' | 'article'
  title: string | null
  content: string
  entry_date: string
  created_at: string
  updated_at: string
  props: string
  topic_id: number | null
  status: 'draft' | 'published'
  deleted_at: string | null
  promoted_at: string | null
}

interface SummaryRow {
  id: number
  kind: 'diary' | 'article'
  status: 'draft' | 'published'
  title: string | null
  entry_date: string
  updated_at: string
  head: string
  char_count: number
  deleted_at: string | null
  promoted_at: string | null
}

const SUMMARY_SELECT = `id, kind, status, title, entry_date, updated_at,
              substr(content, 1, 200) as head,
              length(content) as char_count,
              deleted_at, promoted_at`

function toEntry(r: EntryRow): Entry {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    content: r.content,
    entryDate: r.entry_date,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    props: parseJsonObject(r.props),
    topicId: r.topic_id,
    status: r.status,
    deletedAt: r.deleted_at,
    promotedAt: r.promoted_at,
  }
}

/** 摘要在 JS 侧清洗：去掉 markdown 记号、压掉空行，只留一行给人看 */
function toExcerpt(head: string): string {
  return head
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').replace(/^>\s?/, ''))
    .join(' ')
    .slice(0, 120)
}

const ENTRY_COLUMNS = `id, kind, title, content, entry_date, created_at, updated_at, props, topic_id, status, deleted_at, promoted_at`

export function listByDate(date: string): Entry[] {
  const rows = getDatabase()
    .prepare(
      `select ${ENTRY_COLUMNS} from Entry
       where entry_date = ? and deleted_at is null
       order by case kind when 'diary' then 0 else 1 end, updated_at desc`
    )
    .all(date) as unknown as EntryRow[]
  return rows.map(toEntry)
}

export function get(id: number): Entry | null {
  const row = getDatabase()
    .prepare(`select ${ENTRY_COLUMNS} from Entry where id = ?`)
    .get(id) as unknown as EntryRow | undefined
  return row ? toEntry(row) : null
}

/** 打开就落在今天：没有当天的日记就建一篇空的。
 *  靠 idx_entry_diary_date 这个部分唯一索引 + insert or ignore 保证并发下也只留一篇。 */
export function ensureDiary(date: string): Entry {
  return transact(() => {
    const existing = findByDiaryDate(date)
    if (existing) return existing
    const ts = new Date().toISOString()
    getDatabase()
      .prepare(
        `insert or ignore into Entry(kind, title, content, entry_date, created_at, updated_at)
         values('diary', null, '', ?, ?, ?)`
      )
      .run(date, ts, ts)
    const created = findByDiaryDate(date)
    if (!created) throw new Error(`无法创建 ${date} 的日记`)
    // 这一天的日记出现了，之前写的 [[2026-09-10]] 之类的悬空链接该连上了
    claimForEntry(created.id)
    return created
  })
}

/** 那一天有没有日记（**不**顺手建）。导入器要分清「已有」与「没有」，
 *  用它自己的 `ensureDiary` 会在探测的时候就把空日记写进去。 */
export function diaryOn(date: string): Entry | null {
  return findByDiaryDate(date)
}

function findByDiaryDate(date: string): Entry | null {
  const row = getDatabase()
    .prepare(
      `select ${ENTRY_COLUMNS} from Entry
       where kind = 'diary' and entry_date = ? and deleted_at is null`
    )
    .get(date) as unknown as EntryRow | undefined
  return row ? toEntry(row) : null
}

export function create(input: CreateEntryInput): Entry {
  if (input.kind === 'diary') return ensureDiary(input.entryDate)

  return transact(() => {
    const ts = new Date().toISOString()
    const result = getDatabase()
      .prepare(
        `insert into Entry(kind, title, content, entry_date, created_at, updated_at, props, topic_id, status)
         values('article', ?, ?, ?, ?, ?, '{}', ?, 'draft')`
      )
      .run(
        bindable(input.title ?? null),
        input.content ?? '',
        input.entryDate,
        ts,
        ts,
        bindable(input.topicId ?? null)
      )

    const created = get(Number(result.lastInsertRowid))
    if (!created) throw new Error('创建文章失败')
    // 这篇的标题可能正是别处悬空写着的 [[目标]]
    claimForEntry(created.id)
    if (created.content) {
      reparseEntry(created.id)
      reparseTags(created.id)
    }
    return created
  })
}

/** 列名白名单。patch 的键来自渲染进程，绝不能直接拼进 SQL。 */
const PATCH_COLUMNS: Record<keyof EntryPatch, string> = {
  title: 'title',
  content: 'content',
  entryDate: 'entry_date',
  props: 'props',
  topicId: 'topic_id',
  status: 'status',
}

/** `update` 的无事务内核。`restoreRevision` 要在一个事务里做「自保 + 写回」，
 *  而 `transact` 不支持嵌套（见 db/index.ts），所以事务归公开入口管。 */
function applyUpdate(id: number, patch: EntryPatch): Entry {
  const before = get(id)
  if (!before) throw new Error(`Entry ${id} 不存在`)

  // 属性是主进程唯一严格把关的地方：渲染层输入中允许 `2026-0` 这种半截值，
  // 落库不许（期-02-设计 §4.4）。校验顺带规范化写法，所以写的是这一份而不是入参。
  // 不合规就抛，整笔事务回滚——一篇存了半套属性的日记，比存不上难查得多。
  if (patch.props !== undefined) patch = { ...patch, props: props.validateForWrite(patch.props) }

  const sets: string[] = []
  const values: unknown[] = []
  for (const key of Object.keys(PATCH_COLUMNS) as (keyof EntryPatch)[]) {
    const value = patch[key]
    if (value === undefined) continue
    sets.push(`${PATCH_COLUMNS[key]} = ?`)
    values.push(bindable(value))
  }

  const ts = new Date().toISOString()
  sets.push('updated_at = ?')
  values.push(ts)

  getDatabase()
    .prepare(`update Entry set ${sets.join(', ')} where id = ?`)
    .run(...(values as never[]), id)

  // 派生表的重解析挂在保存上，但只在正文真变了时做：每 500ms 一次自动保存都会走到这里，
  // 只改心情或标题时重解析纯属白删白插。链接与标签共用同一个判断、同一个事务。
  if (patch.content !== undefined && patch.content !== before.content) {
    reparseEntry(id)
    reparseTags(id)
  }
  // 改标题可能让别处悬空写着的旧标题失去归属，也可能认领新的
  if (patch.title !== undefined && patch.title !== before.title) claimForEntry(id)

  const updated = get(id)
  if (!updated) throw new Error(`Entry ${id} 不存在`)
  return updated
}

export function update(id: number, patch: EntryPatch): Entry {
  return transact(() => {
    const before = get(id)
    if (!before) throw new Error(`Entry ${id} 不存在`)
    const after = applyUpdate(id, patch)
    // 只在正文或标题真变了时留一版：每 500ms 一次的自动保存都会走到这里，只看心情
    // 也留一版的话历史列表会被同一个状态刷满。快照的是**保存后**的内容，
    // 于是列表天然是一条时间序列；5 分钟门槛在 revision.snapshot 里（设计文档 §4.2）。
    const textChanged =
      (patch.content !== undefined && patch.content !== before.content) ||
      (patch.title !== undefined && patch.title !== before.title)
    if (textChanged) revision.snapshot(id, 'auto')
    return after
  })
}

/** 手动存一版（Ctrl+S 走它）。总是写，用户明确要求过的东西不该被 5 分钟门槛挡掉。 */
export function snapshotRevision(id: number): void {
  transact(() => revision.snapshot(id, 'manual'))
}

/** 批量改写正文：每篇动手前先存一份 `manual` 版本。
 *
 *  标签重命名与主题重命名共用（见 db/text.ts）。两件事必须在这一层给到：
 *  - **要么全成要么全不动**。一次改名可能动几十篇，半途报错留下「一半新一半旧」的库，
 *    比失败更糟。
 *  - **改完还能退回去**。快照的是**改写前**的内容（与 `update` 的「保存后」相反），
 *    因为重命名要恢复的是改名之前的样子；这也是本期不做独立 undo 栈的替身。
 *
 *  与 `reparseEntry` 同一条约束：**必须在调用方的事务里**。主题改名要把「改 `Topic.name`」
 *  和「改几十篇正文」合成一个事务（见 `topics.rename`），所以事务归调用方所有；
 *  这里自己 begin 会让那个组合无从下手。 */
export function bulkRewriteContent(items: { id: number; content: string }[]): number {
  for (const item of items) {
    revision.snapshot(item.id, 'manual')
    applyUpdate(item.id, { content: item.content })
  }
  return items.length
}

/** 软删除，进回收站；不做物理删除以免误删无法挽回 */
export function remove(id: number): void {
  getDatabase()
    .prepare('update Entry set deleted_at = ?, updated_at = ? where id = ?')
    .run(new Date().toISOString(), new Date().toISOString(), id)
}

/* ─ 升格 ─ */

/** 日记 → 文章。**原文一字不动**，只改 `kind` / `title` / `topic_id` / `promoted_at`。
 *
 *  两条推论：
 *  - `kind` 变成 `'article'` 后该行自动离开 `idx_entry_diary_date` 这个部分唯一索引，
 *    于是同一天可以再写一篇日记——索引不用动。
 *  - 不写 `Link(kind='promotion')`：这条边没有"两端"（日记和文章是同一行），
 *    真正的事实是 `Entry.topic_id`（`知识网络设计.md` §四补 第 5 条）。 */
export function promote(id: number, input: PromoteInput): Entry {
  const title = input.title.trim()
  if (!title) throw new Error('升格要填标题：主题列表里靠标题认人')

  return transact(() => {
    const ts = new Date().toISOString()
    const result = getDatabase()
      .prepare(
        `update Entry set kind = 'article', title = ?, topic_id = ?, promoted_at = ?, updated_at = ?
         where id = ? and kind = 'diary' and deleted_at is null`
      )
      .run(title, input.topicId, ts, ts, id)
    if (Number(result.changes) === 0) throw new Error(`Entry ${id} 不是日记或已被删除，无法升格`)

    // 升格才给了它一个标题，别处悬空写着的 [[那个标题]] 这下该连上了
    claimForEntry(id)
    const promoted = get(id)
    if (!promoted) throw new Error(`Entry ${id} 不存在`)
    return promoted
  })
}

/** 某天升格出来的文章。日记页那条「这一天已升格为《X》」横幅靠它。
 *  按 `promoted_at` 走 `idx_entry_promoted`，不按 `(kind, entry_date)` 猜——
 *  后者分不出"从这天日记升格来的"和"这天新建的"（设计文档 §4.1）。 */
export function listPromotedOn(date: string): EntrySummary[] {
  const rows = getDatabase()
    .prepare(
      `select ${SUMMARY_SELECT} from Entry
       where deleted_at is null and promoted_at is not null and entry_date = ?
       order by promoted_at desc`
    )
    .all(date) as unknown as SummaryRow[]
  return rows.map(toSummary)
}

/* ─ 回收站 ─ */

/** 严格早于 `date` 的那一篇日记（期-07 §五：`{{last_entry}}`）。
 *
 *  判据是 `entry_date` 而不是 `created_at`：模板要说的是"前一天写了什么"，
 *  而补写会让 created_at 晚于 entry_date（补上个月的日记时，那一行是今天建的）。
 *  回收站里的不算——那一篇用户已经不要了，接它干什么。 */
export function prevDiary(date: string): EntrySummary | null {
  const row = getDatabase()
    .prepare(
      `select ${SUMMARY_SELECT} from Entry
       where kind = 'diary' and deleted_at is null and entry_date < ?
       order by entry_date desc limit 1`
    )
    .get(date) as SummaryRow | undefined
  return row ? toSummary(row) : null
}

/** 按删除时间倒序：刚删的排最前，最可能被找回 */
export function listDeleted(): EntrySummary[] {
  const rows = getDatabase()
    .prepare(
      `select ${SUMMARY_SELECT} from Entry
       where deleted_at is not null
       order by deleted_at desc`
    )
    .all() as unknown as SummaryRow[]
  return rows.map(toSummary)
}

/** 从回收站取回。
 *
 *  日记撞上"同一天已有一篇日记"时不吞错：`idx_entry_diary_date` 是硬约束，
 *  怎么处理（合并？删掉哪篇？）该由用户定，这里不替他选——留在回收站，报错出来。 */
export function restore(id: number): Entry {
  return transact(() => {
    const row = get(id)
    if (!row) throw new Error(`Entry ${id} 不存在`)
    if (!row.deletedAt) return row // 已经在回收站外面，幂等返回

    if (row.kind === 'diary' && findByDiaryDate(row.entryDate)) {
      throw new Error(`${row.entryDate} 已有一篇日记，无法恢复：请先处理那一篇`)
    }

    getDatabase()
      .prepare('update Entry set deleted_at = null, updated_at = ? where id = ?')
      .run(new Date().toISOString(), id)

    claimForEntry(id)
    const restored = get(id)
    if (!restored) throw new Error(`Entry ${id} 不存在`)
    return restored
  })
}

/** 真删——库里第一个物理删除路径，要自己收干净两侧的孤儿：
 *  - `Revision.entry_id` 有外键 `on delete cascade`，删 Entry 时自动跟着走；
 *  - `Link` 没有外键（多态引用，`知识网络设计.md` §四），必须手工清，**而且
 *    "指向我"那一侧 `target_type` 要连 `'date'` 一起认**：日记的 id 出现在
 *    `target_id` 上时类型是 `'date'` 不是 `'entry'`，只清 `'entry'` 会把所有
 *    `[[2026-09-10]]` 留成指向空行的孤儿链接。
 *
 *  只删回收站里的：物理删除不可逆，带个前置条件比事后道歉便宜。
 *
 *  `EntryTag` / `Revision` 走外键 cascade，`Link` 与 `Bookmark` 都是多态引用、没有外键，
 *  两边都得手工清。 */
export function purge(id: number): void {
  transact(() => {
    const db = getDatabase()
    const result = db
      .prepare('delete from Entry where id = ? and deleted_at is not null')
      .run(id)
    if (Number(result.changes) === 0) throw new Error(`Entry ${id} 不在回收站里，不能彻底删除`)
    db.prepare(`delete from Link where source_id = ? and source_type = 'entry'`).run(id)
    db.prepare(`delete from Link where target_id = ? and target_type in ('entry','date')`).run(id)
    // 收藏也是多态引用（没有外键），不清就会留一行指向空号的收藏（§3.4 / §10 第 14 项）。
    // EntryTag 不用管：它有 cascade。
    db.prepare(`delete from Bookmark where kind = 'entry' and ref = ?`).run(id)
  })
}

/* ─ 历史版本 ─ */

/** 恢复到某一版。**先把当前状态存一份**（reason='restore'），否则恢复本身成了不可逆操作。
 *  自保与写回必须同一个事务：做成半截（存了没写回、或写回了没存）会白留一版。 */
export function restoreRevision(revisionId: number): Entry {
  return transact(() => {
    const rev = revision.get(revisionId)
    if (!rev) throw new Error(`版本 ${revisionId} 不存在`)
    revision.snapshot(rev.entryId, 'restore')
    return applyUpdate(rev.entryId, {
      title: rev.title,
      content: rev.content,
      // 走宽松那套：属性类型是全局绑定，而这一版是过去某一天的产物。
      // 拿严格判据会让「恢复」整个失败，等于类型系统挡住了误操作的唯一退路（见 props.ts）
      props: props.sanitizeForRestore(rev.props),
    })
  })
}

export function recent(limit: number): EntrySummary[] {
  const rows = getDatabase()
    .prepare(
      `select ${SUMMARY_SELECT}
       from Entry
       where deleted_at is null
       order by entry_date desc, updated_at desc
       limit ?`
    )
    .all(limit) as unknown as SummaryRow[]

  return rows.map(toSummary)
}

/** 随机挑一篇活着的（期-09c「随机打开一篇」）。`except` 是上一次随机到的那个 id——
 *  连按不该给出同一篇，撞上就重摇一次。
 *
 *  为什么直接 `order by random()` 而不是「先数总数再随机偏移」：3006 篇的库上实测 0–1 ms
 *  （设计稿 §〇 M3），这个量级不值得为它养一张表或一个缓存。
 *  `deleted_at is null` 是承重的：回收站里那一些不该被翻出来。 */
export function randomId(except?: number): number | null {
  const row = getDatabase()
    .prepare(
      `select id from Entry
       where deleted_at is null and id != ?
       order by random() limit 1`
    )
    .get(except ?? -1) as unknown as { id: number } | undefined
  return row ? row.id : null
}

/** 只回「这一篇叫什么、是哪一类、哪一天」。标签条给每一格配名字全靠它（期-09a §四）。
 *
 *  为什么不拿 `get(id)` 挨个取：那一趟会把整篇正文都搬过 IPC，恢复五个标签就是五遍，
 *  而「首屏不许变慢」是期-08 立着的判据。占位符按个数拼，值一律走绑定。
 *  带上 `entryDate` 是因为没标题的日记那一格要显示日期，规则与 `entryLabel` 同一份。
 *
 *  `deleted_at is null` 是承重的：这一份名单同时是 `parseWorkspace` 用来筛「哪些标签还活着」的
 *  那一刀。漏掉它，进了回收站的那一篇会留下一格空标签（验收第 9 项第一次跑就是这么红的）。 */
export function labels(
  ids: number[]
): { id: number; title: string | null; kind: 'diary' | 'article'; entryDate: string }[] {
  const 净 = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))]
  if (净.length === 0) return []
  return getDatabase()
    .prepare(
      `select id, title, kind, entry_date as entryDate from Entry
       where id in (${净.map(() => '?').join(', ')}) and deleted_at is null`
    )
    .all(...净) as unknown as {
    id: number
    title: string | null
    kind: 'diary' | 'article'
    entryDate: string
  }[]
}

export function listByTopic(topicId: number): EntrySummary[] {
  const rows = getDatabase()
    .prepare(
      `select ${SUMMARY_SELECT}
       from Entry
       where topic_id = ? and deleted_at is null
       order by updated_at desc`
    )
    .all(topicId) as unknown as SummaryRow[]

  return rows.map(toSummary)
}

/** 某个标签下的条目，分页取（侧栏点标签用）。
 *  放在 entries.ts 而不是 tags.ts：返回的是 EntrySummary，`SUMMARY_SELECT` 与
 *  `toSummary` 归谁所有，查询就写在哪。 */
export function listByTag(tagId: number, limit: number, offset: number): EntrySummary[] {
  const rows = getDatabase()
    .prepare(
      `select ${SUMMARY_SELECT}
       from Entry
       where deleted_at is null and id in (select entry_id from EntryTag where tag_id = ?)
       order by entry_date desc, updated_at desc
       limit ? offset ?`
    )
    .all(tagId, limit, offset) as unknown as SummaryRow[]

  return rows.map(toSummary)
}

/** 某个属性值分组下的条目，分页取（属性视图第三级，期-02-设计 §3.3）。
 *
 *  「哪个值落哪个组」这件事归 `props.ts`（那里有判据），这里只把 id 换成摘要——
 *  与 `listByTag` 同样的分工：返回 EntrySummary 的查询写在这边。 */
export function listByPropValue(
  name: string,
  value: string | null,
  limit: number,
  offset: number
): EntrySummary[] {
  const page = props.entryIds(name, value).slice(offset, offset + limit)
  if (!page.length) return []

  const rows = getDatabase()
    .prepare(
      `select ${SUMMARY_SELECT}
       from Entry
       where deleted_at is null and id in (${page.map(() => '?').join(',')})
       order by entry_date desc, updated_at desc`
    )
    .all(...(page as never[])) as unknown as SummaryRow[]

  return rows.map(toSummary)
}

/* ─ 编年史（期-06b-2 §一） ─ */

/** 一个主题的时间线：原料（日记）与成品（文章）按同一把钥匙串起来。
 *
 *  排序键是 `promoted_at ?? created_at`，**不是 `created_at`、也不是 `entry_date`**：
 *  升格原地改行（见 `promote`），所以一行的 `created_at`/`entry_date` 是"记下那天"，
 *  `promoted_at` 才是"成文那一刻"。编年史要回答的是"理解什么时候成形"，
 *  拿前者排会让一篇沉淀了三个多月的文章错回到原料那天（实测 p50=110 天）。
 *
 *  不取 `content`：这块只画日期与标题，主题下几十条正文一起过 IPC 纯属白给。 */
export function chronicle(topicId: number): ChronicleRow[] {
  const rows = getDatabase()
    .prepare(
      `select id, kind, title, entry_date, created_at, promoted_at,
              coalesce(promoted_at, created_at) as sort_at
       from Entry
       where topic_id = ? and deleted_at is null
       order by sort_at asc, id asc`
    )
    .all(topicId) as unknown as ChronicleRowRaw[]
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    entryDate: r.entry_date,
    createdAt: r.created_at,
    promotedAt: r.promoted_at,
    sortAt: r.sort_at,
  }))
}

interface ChronicleRowRaw {
  id: number
  kind: 'diary' | 'article'
  title: string | null
  entry_date: string
  created_at: string
  promoted_at: string | null
  sort_at: string
}

function toSummary(r: SummaryRow): EntrySummary {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    title: r.title,
    entryDate: r.entry_date,
    updatedAt: r.updated_at,
    excerpt: toExcerpt(r.head),
    charCount: r.char_count,
    deletedAt: r.deleted_at,
    promotedAt: r.promoted_at,
  }
}

export function countByDay(from: string, to: string): DayCount[] {
  return getDatabase()
    .prepare(
      `select entry_date as date, count(*) as count, coalesce(sum(length(content)), 0) as charCount
       from Entry
       where deleted_at is null and entry_date between ? and ?
       group by entry_date
       order by entry_date`
    )
    .all(from, to) as unknown as DayCount[]
}