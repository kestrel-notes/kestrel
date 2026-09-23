/** 链接层：把正文里的 `[[双链]]` 变成 Link 表里的一行，再读回来变成反链与图谱。
 *
 *  两个不变量：
 *  1. `Link.target_raw` 存的是**规范化查找键**（见 shared/links.ts），不是用户原文。
 *     悬空链接要靠它认领，原文的空格写法有无数种，规范化形式只有一种。
 *  2. 悬空 ⟺ `target_id` 为空（表上的 check 约束钉着）。目标一出现就回头认领。 */

import { formatDateZh, formatMonthDayZh } from '../../shared/date'
import { normalizeLinkKey, parseLinks } from '../../shared/links'
import type { ParsedLink } from '../../shared/links'
import type {
  Backlink,
  DanglingLink,
  EntryKind,
  GlobalGraph,
  GraphEdge,
  GraphNode,
  LinkKind,
  LinkSourceType,
  LinkTargetType,
  LocalGraph,
  OutgoingLink,
} from '../../shared/types'
import { getDatabase } from './index'

interface LinkRow {
  id: number
  source_id: number
  source_type: LinkSourceType
  target_id: number | null
  target_type: LinkTargetType | null
  target_raw: string
  kind: LinkKind
  block_id: string | null
  anchor: string | null
  alias: string | null
  created_at: string
}

interface EntryRefRow {
  id: number
  kind: EntryKind
  title: string | null
  content: string
  entry_date: string
}

/** 节点键。Entry 与 Topic 的 id 各自从 1 开始，不带前缀就会把第 3 篇日记和第 3 个主题混成一个点 */
export function entryKey(id: number): string {
  return `e:${id}`
}
export function topicKey(id: number): string {
  return `t:${id}`
}
function keyFrom(type: LinkTargetType | LinkSourceType, id: number): string {
  return type === 'topic' ? topicKey(id) : entryKey(id)
}

/*  写入：正文 → Link 行 ─ */

/** 把一个 `[[目标]]` 解析成真实节点。日期 → 主题名 → 文章标题，层层后退，认不出来就是悬空。
 *
 *  主题名优先于文章标题：主题是用户刻意建出来的分类，跟文章撞名时按主题理解更接近意图。 */
function resolveTarget(link: ParsedLink): { id: number; type: LinkTargetType } | null {
  const db = getDatabase()

  if (link.isDate) {
    const diary = db
      .prepare(`select id from Entry where kind = 'diary' and entry_date = ? and deleted_at is null`)
      .get(link.key) as { id: number } | undefined
    // 那天的日记还没写 → 悬空。写了以后 claimForEntry 会回头认领
    return diary ? { id: diary.id, type: 'date' } : null
  }

  const topic = db
    .prepare(`select id from Topic where lower(replace(name, ' ', '')) = ?`)
    .get(link.key) as { id: number } | undefined
  if (topic) return { id: topic.id, type: 'topic' }

  const entry = db
    .prepare(
      `select id from Entry
       where deleted_at is null and lower(replace(title, ' ', '')) = ?
       order by case kind when 'article' then 0 else 1 end, updated_at desc
       limit 1`
    )
    .get(link.key) as { id: number } | undefined
  return entry ? { id: entry.id, type: 'entry' } : null
}

/** 全量重解析一条记录的出链：先删该 source 的所有行，再按正文重插。
 *  只处理这一条记录，成本恒定，不需要增量 diff（设计文档 §四）。
 *
 *  必须在事务里调用——delete 成功而 insert 失败会留下一条没有出链的记录。 */
export function reparseEntry(entryId: number): void {
  const db = getDatabase()
  const src = db
    .prepare('select id, kind, title, content, entry_date from Entry where id = ?')
    .get(entryId) as unknown as EntryRefRow | undefined
  if (!src) return

  db.prepare(`delete from Link where source_id = ? and source_type = 'entry'`).run(entryId)

  const insert = db.prepare(
    `insert into Link(source_id, source_type, target_id, target_type, target_raw, kind, block_id, anchor, alias, created_at)
     values(?, 'entry', ?, ?, ?, ?, null, ?, ?, ?)`
  )
  const ts = new Date().toISOString()
  for (const link of parseLinks(src.content, src.entry_date)) {
    const hit = resolveTarget(link)
    insert.run(entryId, hit?.id ?? null, hit?.type ?? null, link.key, link.kind, link.anchor, link.alias, ts)
  }
}

/** 目标出现后回头认领悬空链接。返回认领了几条。 */
function claimDangling(raw: string, targetId: number, targetType: LinkTargetType): number {
  const key = normalizeLinkKey(raw)
  if (!key) return 0
  const result = getDatabase()
    .prepare('update Link set target_id = ?, target_type = ? where target_raw = ? and target_id is null')
    .run(targetId, targetType, key)
  return Number(result.changes)
}

/** 记录新建或改名后调用：用它的标题（和日记的日期）去认领悬空链接。
 *  这就是「先写下 [[还没想好的主题]]，后来那篇真的写了，链接自动连上」的那一步。 */
export function claimForEntry(entryId: number): void {
  const row = getDatabase()
    .prepare('select id, kind, title, content, entry_date from Entry where id = ?')
    .get(entryId) as unknown as EntryRefRow | undefined
  if (!row) return
  if (row.title) claimDangling(row.title, row.id, 'entry')
  if (row.kind === 'diary') claimDangling(row.entry_date, row.id, 'date')
}

/** 主题新建或改名之后认领悬空的 `[[主题名]]`，返回认领了几条 */
export function claimForTopic(topicId: number): number {
  const row = getDatabase().prepare('select id, name from Topic where id = ?').get(topicId) as
    | { id: number; name: string }
    | undefined
  return row ? claimDangling(row.name, row.id, 'topic') : 0
}

/* ─ 读：反向链接 ─ */

/** 命中那一行拿来做上下文。日记正文里写链接往往孤零零一行，前后文比标题更说明「为什么连过来」。 */
function contextLine(content: string, targetRaw: string, entryDate: string): string {
  for (const line of content.split('\n')) {
    if (!line.includes('[[')) continue
    if (!parseLinks(line, entryDate).some((l) => l.key === targetRaw)) continue
    return line
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^>\s?/, '')
      .slice(0, 140)
  }
  return ''
}

interface SourceInfo {
  label: string
  kind: EntryKind | null
  date: string | null
  context: string
}

function loadSource(row: LinkRow): SourceInfo | null {
  const db = getDatabase()
  if (row.source_type === 'entry') {
    const src = db
      .prepare('select id, kind, title, content, entry_date from Entry where id = ? and deleted_at is null')
      .get(row.source_id) as unknown as EntryRefRow | undefined
    if (!src) return null
    return {
      label: src.title || (src.kind === 'diary' ? formatDateZh(src.entry_date) : '未命名文章'),
      kind: src.kind,
      date: src.entry_date,
      context: contextLine(src.content, row.target_raw, src.entry_date),
    }
  }

  const topic = db.prepare('select name, description from Topic where id = ?').get(row.source_id) as
    | { name: string; description: string | null }
    | undefined
  if (!topic) return null
  return { label: topic.name, kind: null, date: null, context: topic.description ?? '' }
}

/** 谁指向这篇。
 *
 *  必须带类型条件：Entry 和 Topic 的 id 各自从 1 开始，只按 target_id 查会把
 *  「第 1 篇日记」和「第 1 个主题」的反链混在一起（实测踩到过）。
 *  但也不能只认 'entry'——日记被日期链接指向时 target_type 是 'date'，
 *  漏掉它就等于所有 `[[2026-09-10]]` 的反链都不见了。 */
export function backlinks(entryId: number): Backlink[] {
  const rows = getDatabase()
    .prepare(
      `select * from Link
       where target_id = ? and target_type in ('entry','date')
       order by kind, id`
    )
    .all(entryId) as unknown as LinkRow[]

  const out: Backlink[] = []
  for (const row of rows) {
    // 自指不算：在今天的日记里写 [[今天]] 是自然写法，不该在反链面板里出现一条指回自己的
    if (row.source_type === 'entry' && row.source_id === entryId) continue
    const src = loadSource(row)
    if (!src) continue
    out.push({
      linkId: row.id,
      kind: row.kind,
      sourceKey: keyFrom(row.source_type, row.source_id),
      sourceId: row.source_id,
      sourceType: row.source_type,
      sourceKind: src.kind,
      sourceLabel: src.label,
      sourceDate: src.date,
      alias: row.alias,
      context: src.context,
    })
  }
  return out
}

/* ─ 读：出链（编辑器分型着色用）─ */

/** 这篇指向谁：每一条出链，以及它落到了哪。
 *
 *  着色要的是「日记 / 文章 / 主题 / 悬空」四态，而 Link 表分不出前两者——
 *  它的 target_type 只说「目标是记录还是主题」。日记和文章的区别得回 Entry 表
 *  看 kind，所以这里要多查一次。反过来不能省：Link 只存了目标 id，
 *  光看正文的 key 判断不出目标存不存在。 */
export function outgoing(entryId: number): OutgoingLink[] {
  const db = getDatabase()
  const rows = db
    .prepare(`select * from Link where source_type = 'entry' and source_id = ? order by id`)
    .all(entryId) as unknown as LinkRow[]

  // 目标种类批量查：一条一条查会把出链列表变成 N+1
  const entryIds = rows
    .filter((r) => r.target_id !== null && r.target_type !== 'topic')
    .map((r) => r.target_id as number)
  const kinds = new Map<number, EntryKind>()
  if (entryIds.length) {
    const hit = db
      .prepare(
        `select id, kind from Entry
         where deleted_at is null and id in (${entryIds.map(() => '?').join(',')})`
      )
      .all(...entryIds) as unknown as { id: number; kind: EntryKind }[]
    for (const r of hit) kinds.set(r.id, r.kind)
  }

  return rows.map((row) => {
    // 软删掉的目标当成悬空：nodeKey 指过去也只会看到一条「已经不在了」
    const kind = row.target_type === 'topic' ? 'topic' : kinds.get(row.target_id as number) ?? null
    return {
      key: row.target_raw,
      kind: row.kind,
      nodeKey: kind === null ? null : keyFrom(row.target_type as LinkTargetType, row.target_id as number),
      targetType: kind,
    }
  })
}

/* ─ 读：局部图谱 ─ */

interface Neighbor {
  key: string
  kind: LinkKind
  dangling?: LinkRow
}

/** 一个节点的所有直接邻居。两个方向都要：出链和入链在图里都是边。 */
function adjacent(table: 'entry' | 'topic', id: number): Neighbor[] {
  const db = getDatabase()
  const sql =
    table === 'entry'
      ? `select * from Link
         where (source_type = 'entry' and source_id = ?)
            or (target_type in ('entry','date') and target_id = ?)`
      : `select * from Link
         where (source_type = 'topic' and source_id = ?)
            or (target_type = 'topic' and target_id = ?)`
  const rows = db.prepare(sql).all(id, id) as unknown as LinkRow[]

  const selfKey = table === 'entry' ? entryKey(id) : topicKey(id)
  const out: Neighbor[] = []
  for (const row of rows) {
    const isOut = row.source_type === table && row.source_id === id
    if (isOut) {
      if (row.target_id === null) {
        out.push({ key: '', kind: row.kind, dangling: row })
        continue
      }
      const key = keyFrom(row.target_type as LinkTargetType, row.target_id)
      if (key !== selfKey) out.push({ key, kind: row.kind })
      continue
    }
    const key = keyFrom(row.source_type, row.source_id)
    if (key !== selfKey) out.push({ key, kind: row.kind })
  }
  return out
}

function labelOf(kind: EntryKind, title: string | null, date: string): string {
  if (title) return title
  return kind === 'diary' ? formatMonthDayZh(date) : '未命名文章'
}

/** 当前记录 N 跳内的邻居。BFS 到 depth 层，然后一次性把节点名字查出来。
 *
 *  depth 上限 3：再多就没法在画布里画清楚了，图会糊成一团线。 */
export function graph(centerId: number, depth = 2): LocalGraph {
  const db = getDatabase()
  const capped = Math.min(Math.max(depth, 1), 3)
  const center = entryKey(centerId)

  const entryHit = db
    .prepare('select id, kind, title, content, entry_date from Entry where id = ? and deleted_at is null')
    .get(centerId) as unknown as EntryRefRow | undefined
  if (!entryHit) throw new Error(`Entry ${centerId} 不存在`)

  const depthOf = new Map<string, number>([[center, 0]])
  const dangling: DanglingLink[] = []
  let frontier: string[] = [center]

  for (let d = 1; d <= capped && frontier.length; d++) {
    const next: string[] = []
    for (const key of frontier) {
      const [prefix, rawId] = key.split(':')
      const table = prefix === 't' ? 'topic' : 'entry'
      for (const nb of adjacent(table, Number(rawId))) {
        if (nb.dangling) {
          // 悬空短枝只画当前的这一篇的：邻居的悬空边挂在邻居的图上更合适
          if (key === center) {
            dangling.push({ raw: nb.dangling.target_raw, alias: nb.dangling.alias })
          }
          continue
        }
        if (depthOf.has(nb.key)) continue
        depthOf.set(nb.key, d)
        next.push(nb.key)
      }
    }
    frontier = next
  }

  // 归属主题：只给"当前这篇"补一条 `entry → topic` 边，**不从主题继续 BFS**。
  // 一个主题下可能挂着几十篇文章，走下去会把节点上限塞满，把真正说明"这篇为什么
  // 连过来"的双链邻居挤掉（设计文档 §4.5）。注意它不来自 Link 行——升格不写
  // `Link(kind='promotion')`（`知识网络设计.md` §四补 第 5 条），事实是 `Entry.topic_id`。
  const centerTopic = db
    .prepare('select t.id, t.name from Topic t join Entry e on e.topic_id = t.id where e.id = ?')
    .get(centerId) as unknown as { id: number; name: string } | undefined

  // 节点信息批量取：一条一条查会把 BFS 变成 N+1
  const entryIds = [...depthOf.keys()].filter((k) => k[0] === 'e').map((k) => Number(k.slice(2)))
  const topicIds = [...depthOf.keys()].filter((k) => k[0] === 't').map((k) => Number(k.slice(2)))

  const nodes = new Map<string, GraphNode>()
  if (entryIds.length) {
    const rows = db
      .prepare(
        `select id, kind, title, content, entry_date from Entry
         where deleted_at is null and id in (${entryIds.map(() => '?').join(',')})`
      )
      .all(...entryIds) as unknown as EntryRefRow[]
    for (const r of rows) {
      nodes.set(entryKey(r.id), {
        key: entryKey(r.id),
        type: r.kind,
        label: labelOf(r.kind, r.title, r.entry_date),
        depth: depthOf.get(entryKey(r.id)) ?? 0,
      })
    }
  }
  if (topicIds.length) {
    const rows = db
      .prepare(`select id, name from Topic where id in (${topicIds.map(() => '?').join(',')})`)
      .all(...topicIds) as unknown as { id: number; name: string }[]
    for (const r of rows) {
      nodes.set(topicKey(r.id), {
        key: topicKey(r.id),
        type: 'topic',
        label: r.name,
        depth: depthOf.get(topicKey(r.id)) ?? 0,
      })
    }
  }

  // 归属主题可能没经 Link 走进来（正文里没提过它），补成节点
  if (centerTopic) {
    const key = topicKey(centerTopic.id)
    if (!nodes.has(key)) {
      nodes.set(key, { key, type: 'topic', label: centerTopic.name, depth: 1 })
    }
  }

  // 软删除的邻居会被上面的 deleted_at 过滤掉，这里要连带把它和它的边一起丢掉
  const centerNode = nodes.get(center)
  if (!centerNode) throw new Error(`Entry ${centerId} 已被删除`)

  const edges: GraphEdge[] = []
  const seenEdge = new Set<string>()
  const seenPair = new Set<string>()
  for (const key of nodes.keys()) {
    const [prefix, rawId] = key.split(':')
    const table = prefix === 't' ? 'topic' : 'entry'
    for (const nb of adjacent(table, Number(rawId))) {
      if (!nb.key || !nodes.has(nb.key)) continue
      // 图是画线不是画箭头：A→B 和 B→A 是同一条线。不按无序对去重的话，
      // 每对邻居会被两个端点各数一遍，线上叠两条重合的线（实测过半数是重复的）。
      const pair = [key, nb.key].sort().join('~')
      const id = `${pair}:${nb.kind}`
      seenPair.add(pair)
      if (seenEdge.has(id)) continue
      seenEdge.add(id)
      edges.push({ source: key, target: nb.key, kind: nb.kind })
    }
  }

  // 归属边最后补：正文里已经写过 [[主题名]] 的话，那条 wiki 边就是同一条线，不必再画
  if (centerTopic) {
    const target = topicKey(centerTopic.id)
    const pair = [center, target].sort().join('~')
    if (!seenPair.has(pair)) edges.push({ source: center, target, kind: 'topic' })
  }

  return {
    center: centerNode,
    nodes: [...nodes.values()].filter((n) => n.key !== center),
    edges,
    dangling,
  }
}

/*  读：全局图谱（期-06a §5.1）  */

/** 全库拓扑：两条查询拿完，**不逐节点查**（那会把一次 22ms 变成 3000 次往返）。
 *
 *  三条刻意的取舍：
 *  1. **不取 `content`**。实测 3000 条的拓扑是 0.63 MB，带上正文就是几十 MB（设计稿决策 D5）。
 *  2. **不画主题的归属边**。全库视角下主题的归属信息由节点颜色承载，画出来是每个主题一大把
 *     放射线（设计稿 D8）。`target_type='topic'` 的 Link 行照旧存在，只是不进这张图。
 *  3. **不返回坐标**。布局只在渲染层求解，resize 时本地重算包围盒就够（决策 D4）。 */
export function graphAll(): GlobalGraph {
  const db = getDatabase()

  const nodeRows = db
    .prepare(
      `select e.id, e.kind, e.title, e.entry_date, e.topic_id,
              (select count(*) from Link l
                where l.target_type in ('entry','date') and l.target_id = e.id) as in_deg
       from Entry e
       where e.deleted_at is null`
    )
    .all() as unknown as {
    id: number
    kind: EntryKind
    title: string | null
    entry_date: string
    topic_id: number | null
    in_deg: number
  }[]

  const live = new Set(nodeRows.map((r) => entryKey(r.id)))

  const linkRows = db
    .prepare(
      `select source_id, target_id, kind from Link
       where source_type = 'entry' and target_type in ('entry','date') and target_id is not null`
    )
    .all() as unknown as { source_id: number; target_id: number; kind: LinkKind }[]

  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  for (const row of linkRows) {
    const a = entryKey(row.source_id)
    const b = entryKey(row.target_id)
    // 两端都得活着：软删除的那半条边画出去就是个指向虚无的线
    if (!live.has(a) || !live.has(b) || a === b) continue
    // 与 graph() 同一条去重：A→B 和 B→A 是同一条线，不去重就会线上叠线
    const pair = [a, b].sort().join('~')
    const id = `${pair}:${row.kind}`
    if (seen.has(id)) continue
    seen.add(id)
    edges.push({ source: a, target: b, kind: row.kind })
  }

  const topicRows = db
    .prepare(
      `select t.id, t.name, count(e.id) as count
       from Topic t left join Entry e on e.topic_id = t.id and e.deleted_at is null
       where t.id in (select distinct topic_id from Entry where deleted_at is null and topic_id is not null)
       group by t.id`
    )
    .all() as unknown as { id: number; name: string; count: number }[]

  const dangling = db
    .prepare('select count(*) as c from Link where target_id is null')
    .get() as unknown as { c: number }

  return {
    nodes: nodeRows.map((r) => ({
      key: entryKey(r.id),
      type: r.kind,
      label: labelOf(r.kind, r.title, r.entry_date),
      topicKey: r.topic_id === null ? null : topicKey(r.topic_id),
      inDeg: r.in_deg,
      date: r.entry_date,
    })),
    edges,
    topics: topicRows.map((t) => ({ key: topicKey(t.id), label: t.name, count: t.count })),
    danglingCount: dangling.c,
  }
}
