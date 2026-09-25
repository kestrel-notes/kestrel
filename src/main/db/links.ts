/** 链接层：把正文里的 `[[双链]]` 变成 Link 表里的一行，再读回来变成反链与图谱。
 *
 *  两个不变量：
 *  1. `Link.target_raw` 存的是**规范化查找键**（见 shared/links.ts），不是用户原文。
 *     悬空链接要靠它认领，原文的空格写法有无数种，规范化形式只有一种。
 *  2. 悬空 ⟺ `target_id` 为空（表上的 check 约束钉着）。目标一出现就回头认领。 */

import { formatDateZh, formatMonthDayZh } from '../../shared/date'
import { 切片 } from '../../shared/embed'
import { normalizeLinkKey, parseLinks, resolveDateRef } from '../../shared/links'
import type { ParsedLink } from '../../shared/links'
import type {
  AliasRow,
  Backlink,
  Candidate,
  DanglingLink,
  EmbedAsk,
  EmbedCard,
  EntryKind,
  GlobalGraph,
  GraphEdge,
  GraphNode,
  LinkKind,
  LinkSourceType,
  LinkTargetType,
  LocalGraph,
  OutgoingLink,
  PreviewAsk,
  PreviewCard,
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

/** 把一个 `[[目标]]` 解析成真实节点。日期 → 主题名 → 文章标题 → **别名**，层层后退，认不出来就是悬空。
 *
 *  主题名优先于文章标题：主题是用户刻意建出来的分类，跟文章撞名时按主题理解更接近意图。
 *
 *  别名为什么排在**最后**（期-05c §9.2 第 2 条）：前三层的结果一个字都不会变，
 *  已入库的 Link 行不会因为建了表而改指向——这是"兜底层"三个字的全部意思。
 *  反过来（别名优先）等于把期-02/05/11b 三批验收重做一遍。
 *
 *  日期那一路**不吃别名**：`[[昨天]]` 认不出来就是"那一天还没写"，
 *  让别名去救它，"那一天到底存不存在"就变成不可判了。 */
function resolveTarget(link: ParsedLink): { id: number; type: LinkTargetType } | null {
  const db = getDatabase()

  if (link.isDate) {
    const diary = db
      .prepare(`select id from Entry where kind = 'diary' and entry_date = ? and deleted_at is null`)
      .get(link.key) as { id: number } | undefined
    // 那天的日记还没写 → 悬空。写了以后 claimForEntry 会回头认领
    return diary ? { id: diary.id, type: 'date' } : null
  }

  const hit = resolveNameLayers(link.key)
  return hit ?? aliasTarget(link.key)
}

/** 前三层里的"名字那两层"（主题名 → 文章标题）。拆出来是给别名那一层做撞名检查用的：
 *  一个名字如果这里已经认得，就别再建别名——那条别名永远不会生效，界面上留着一个不起作用的
 *  入口比少一个入口更糟（期-05c §9.4 判据 3 把设计稿里那句"不拦，只说"改成了拦，理由在此）。 */
export function resolveNameLayers(key: string): { id: number; type: LinkTargetType } | null {
  const db = getDatabase()

  const topic = db
    .prepare(`select id from Topic where lower(replace(name, ' ', '')) = ?`)
    .get(key) as { id: number } | undefined
  if (topic) return { id: topic.id, type: 'topic' }

  const entry = db
    .prepare(
      `select id from Entry
       where deleted_at is null and lower(replace(title, ' ', '')) = ?
       order by case kind when 'article' then 0 else 1 end, updated_at desc
       limit 1`
    )
    .get(key) as { id: number } | undefined
  return entry ? { id: entry.id, type: 'entry' } : null
}

/** 最后一层：全局别名。规范化写法与那三层同一把尺（`lower + 去空格`，不是 normalizeLinkKey）。 */
function aliasTarget(key: string): { id: number; type: LinkTargetType } | null {
  const row = getDatabase()
    .prepare(
      `select target_id id, target_type type from Alias
       where lower(replace(name, ' ', '')) = ?
       order by case target_type when 'topic' then 0 else 1 end, id
       limit 1`
    )
    .get(key) as { id: number; type: LinkTargetType } | undefined
  return row ?? null
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

/* ─ 全局别名（期-05c） ─ */

/** 别名那一层的查找键：与 Topic / Entry 那两条查询同一把尺（去空格 + 小写）。
 *  不复用 `normalizeLinkKey`（它去掉**所有**空白）：那三层用的就是这个表达式，
 *  尺要一模一样，不然会出现"标题层认得、别名层说撞名"这种两头都不认的名字。 */
function 名字键(s: string): string {
  return s.toLowerCase().replace(/ /g, '')
}

/** 日期写法不做别名（`resolveTarget` 里那一段的理由）。认的就是解析器认的那几种：
 *  相对词（今天 / 昨天 / 去年今天）与打全了的数字日期——`resolveDateRef` 一处到底，
 *  不在这里再写一遍词汇表（那两份名单早晚会漂）。`from` 给什么都不影响"是不是日期写法"这个判断。 */
function 像日期(s: string): boolean {
  return resolveDateRef(s.trim(), '2026-01-02') !== null
}

export function aliases(): AliasRow[] {
  const db = getDatabase()
  const 行 = db
    .prepare(
      `select a.id id, a.name name, a.target_type tt, a.target_id tid,
              coalesce(nullif(trim(t.name), ''), nullif(trim(e.title), ''), e.entry_date) nm,
              case when a.target_type = 'topic' then '主题'
                   when e.kind = 'diary' then '日记' else '文章' end kd
       from Alias a
       left join Topic t on a.target_type = 'topic' and t.id = a.target_id
       left join Entry e on a.target_type = 'entry' and e.id = a.target_id
       order by a.name`
    )
    .all() as unknown as {
    id: number
    name: string
    tt: 'entry' | 'topic'
    tid: number
    nm: string | null
    kd: string
  }[]

  const 连着 = db.prepare(
    `select count(*) c from Link where target_raw = ? and target_id = ? and target_type = ?`
  )

  return 行.map((r) => {
    const key = 名字键(r.name)
    // 与解析层同一把尺：直接问 resolveNameLayers，不在这里再写一遍那两条 SQL
    const 占着 = resolveNameLayers(key)
    const 同 = 占着?.type === (r.tt === 'topic' ? 'topic' : 'entry') && 占着?.id === r.tid
    return {
      id: r.id,
      name: r.name,
      targetType: r.tt,
      targetId: r.tid,
      targetName: r.nm || `#${r.tid}`,
      targetKind: r.kd,
      active: !占着 || !!同,
      shadowedBy: 占着 && !同 ? `${名字种类(占着.type)}「${显示名(占着.type, 占着.id)}」` : null,
      holding: Number(连着.get(key, r.tid, r.tt === 'topic' ? 'topic' : 'entry')?.c ?? 0),
    }
  })
}

/** "这个名字被谁占了"要说得出名字，不能只说类型 */
function 显示名(type: LinkTargetType, id: number): string {
  const db = getDatabase()
  if (type === 'topic')
    return (db.prepare('select name from Topic where id = ?').get(id) as { name: string } | undefined)?.name ?? `#${id}`
  const e = db
    .prepare('select kind, title, entry_date from Entry where id = ?')
    .get(id) as { kind: EntryKind; title: string | null; entry_date: string } | undefined
  if (!e) return `#${id}`
  return e.title?.trim() || e.entry_date
}

function 名字种类(type: LinkTargetType): string {
  return type === 'topic' ? '主题' : type === 'date' ? '日记' : '记录'
}

export interface AddAliasResult {
  ok: boolean
  id?: number
  /** 加完顺手认领了几条悬空 */
  claimed?: number
  原因?: string
}

/** 建一条别名，并当场回头认领那些写着这个写法的悬空链接。
 *
 *  三件事在写之前就拦下来（拦而不是"建了再说"：一条永远轮不到的别名，会在界面上留一个不起作用的入口）：
 *  ① 空名字；② 日期写法（`resolveTarget` 那一段的理由）；③ 前三层已经认得这个名字。 */
export function addAlias(name: string, targetType: 'entry' | 'topic', targetId: number): AddAliasResult {
  const 原 = name.trim()
  const key = 名字键(原)
  if (!key) return { ok: false, 原因: '名字是空的' }
  if (像日期(原)) return { ok: false, 原因: '日期写法（今天 / 昨天 / 2026-09-25）不做别名——那一族由解析器直接解' }

  const db = getDatabase()
  const 目标 =
    targetType === 'topic'
      ? db.prepare('select id from Topic where id = ?').get(targetId)
      : db.prepare('select id from Entry where id = ? and deleted_at is null').get(targetId)
  if (!目标) return { ok: false, 原因: '目标不在了' }

  const 占着 = resolveNameLayers(key)
  if (占着) {
    const 是它自己 =
      占着.type === (targetType === 'topic' ? 'topic' : 'entry') && 占着.id === targetId
    return { ok: false, 原因: 是它自己 ? '这就是它现在的名字，不用别名' : '这个名字已经指向别处了，先改那边' }
  }
  // 别名层自己也要不歧义：`aliasTarget` 那一条查询里排了序（主题在前、再按 id），
  // 但"同一个名字两条别名指两处"是用户没说过的话，不能由排序替他选一个 ⇒ 直接拦
  const 别的别名 = getDatabase()
    .prepare(
      `select id from Alias
       where lower(replace(name, ' ', '')) = ? and (target_type <> ? or target_id <> ?)
       limit 1`
    )
    .get(key, targetType, targetId)
  if (别的别名) return { ok: false, 原因: '这个名字已经是另一条别名了，先删那个' }

  try {
    const r = db
      .prepare('insert into Alias(name, target_type, target_id, created_at) values (?,?,?,?)')
      .run(原, targetType, targetId, new Date().toISOString())
    // 认领走那一条老路：正文里早就写着这个写法、一直悬空的那些行，当场连上
    const claimed = claimDangling(原, targetId, targetType)
    return { ok: true, id: Number(r.lastInsertRowid), claimed }
  } catch (err) {
    return { ok: false, 原因: `这一条已经有了（${String((err as Error).message).slice(0, 40)}）` }
  }
}

/** 删一条别名，并把它 holding 的那些链接**放回悬空**——不是静默少一行（判据 9.4-6）。
 *
 *  为什么按 target_raw 挑而不是按目标挑：同一个目标可以同时被"真标题"和"别名"两条路连着，
 *  只有写法等于这条别名的行才该松开。 */
export function removeAlias(id: number): { released: number; name: string } {
  const db = getDatabase()
  const 行 = db
    .prepare('select name, target_type tt, target_id tid from Alias where id = ?')
    .get(id) as { name: string; tt: 'entry' | 'topic'; tid: number } | undefined
  if (!行) return { released: 0, name: '' }
  const key = 名字键(行.name)
  db.prepare('delete from Alias where id = ?').run(id)
  const r = db
    .prepare(
      `update Link set target_id = null, target_type = null
       where target_raw = ? and target_id = ? and target_type = ?`
    )
    .run(key, 行.tid, 行.tt === 'topic' ? 'topic' : 'entry')
  return { released: Number(r.changes), name: 行.name }
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

/*  读：悬浮预览那一张卡（期-05d §十一）
    与 `contextLine` 是两件事，没并成一支：那边取的是"命中那一行的原文"（反链面板要说
    「你为什么被连过来」），这边取的是"这一篇自己开头说了什么"。共用一支函数只会让两边
    各多几个开关参数。 */

/** 卡片上那一截最多多少字。两行的量——比这更长就不是"预览"而是"读另一篇"了 */
const 那一截上限 = 200
/** 从库里取这么多字足够凑出那一截（正常正文 p50 是 49–325 字，`scratch/p05d-pre.mjs` M5） */
const 取的字数 = 800

/** markdown → 给人读的纯文本。只做"看得下去"这一档，不做渲染：
 *  卡片上出现一个真表格、一张图、一段公式，都是 IPC 之外又多一事（§11.2 第 3 条：零 HTML）。 */
function 纯文本(s: string): string {
  return (
    s
      // 代码块整段去掉：卡片不演代码，围栏里的 `#` 还会被下面那一条误当标题
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      // 双链按它在屏幕上显示的样子给（有行内别名用别名）
      .replace(/!?\[\[[^\]\n|]*\|([^\]\n]*)\]\]/g, '$1')
      .replace(/!?\[\[([^\]\n]*)\]\]/g, '$1')
      .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
      .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, ' ')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/[*_~`$]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** 从正文里取卡片上那一截。三条都是实测定的（§11.1 M5 / M6）：
 *  · **跳过开头那一行 `#`**——两份夹具一份 100% 首段是标题行、一份 0%，"取首段"不能按字面做；
 *  · **往后找到第一处真有字的**——真库首段 p50 只有 5 字，死板取首段会弹出一行五个字；
 *  · **整篇除了标题没别的不返回空串就算"只有标题"**——那一种在真库 6 篇里占 3 篇，不能弹空白卡。 */
function 那一截(原文: string, 取满了吗: boolean): { 那截: string; 截了: boolean; 只有标题: boolean } {
  const 行 = 原文.split('\n')
  let i = 0
  while (i < 行.length && 行[i].trim() === '') i++
  // 只跳开头那一行标题：正文中间的 `#` 是真内容
  if (i < 行.length && /^#{1,6}\s/.test(行[i].trim())) i++
  const 文 = 纯文本(行.slice(i).join('\n'))
  if (!文) return { 那截: '', 截了: false, 只有标题: true }
  if (文.length > 那一截上限) return { 那截: 文.slice(0, 那一截上限), 截了: true, 只有标题: false }
  // 取满 800 字还没有句号，说明后面还有话——"截了"要跟着说，不能装作这就是全篇
  return { 那截: 文, 截了: 取满了吗 && !/[。！？.!?]$/.test(文), 只有标题: false }
}

/** 悬空那一格：这个名字被写过几遍而还没落地。本档最值钱的一格，也是最快的一格
 *  （`idx_link_dangling` 那条部分索引在 `schema.ts:93`，实测 2.3–4.6 µs）。 */
function 悬空卡(写法: string, 显示: string): PreviewCard {
  const r = getDatabase()
    .prepare(
      `select count(*) c, max(created_at) t from Link where target_raw = ? and target_id is null`
    )
    .get(写法) as unknown as { c: number; t: string | null }
  return {
    是: 'dangling',
    名字: 显示 || 写法,
    那截: '',
    截了: false,
    只有标题: false,
    数: Number(r.c ?? 0),
    最近: r.t ? String(r.t).slice(0, 10) : null,
  }
}

/** 悬浮预览那一张卡。**一条窄查询**：整篇正文不过 IPC（M1b 那一篇 20 万字的，
 *  取整篇 2229 µs / 200000 字、取一截 164 µs / 400 字）。
 *
 *  落点为 null（悬空）、或者落点已经指向一篇被彻底删除/软删的记录 ⇒ 都退成悬空那一格：
 *  卡片说"还没有哪一篇叫这个"总归是真的，说"这一篇有 4 处反链"就会是在说别的东西。 */
export function preview(问: PreviewAsk): PreviewCard {
  const db = getDatabase()
  const { nodeKey, key, 显示 } = 问

  if (nodeKey?.startsWith('t:')) {
    const t = db.prepare('select name, description from Topic where id = ?').get(Number(nodeKey.slice(2))) as
      | { name: string; description: string | null }
      | undefined
    if (!t) return 悬空卡(key, 显示)
    const 圈 = db
      .prepare(
        `select count(*) c, max(entry_date) d from Entry
         where topic_id = ? and deleted_at is null`
      )
      .get(Number(nodeKey.slice(2))) as unknown as { c: number; d: string | null }
    const 截 = 那一截(String(t.description ?? ''), false)
    return {
      是: 'topic',
      名字: t.name,
      那截: 截.那截,
      截了: 截.截了,
      // 主题没有"除了标题没别的"这一说：它本来就没有标题行，描述空就是空
      只有标题: false,
      数: Number(圈.c ?? 0),
      最近: 圈.d ? String(圈.d) : null,
    }
  }

  if (nodeKey?.startsWith('e:')) {
    const 号 = Number(nodeKey.slice(2))
    const r = db
      .prepare(
        `select kind, title, entry_date, substr(content, 1, ${取的字数}) c
         from Entry where id = ? and deleted_at is null`
      )
      .get(号) as unknown as
      | { kind: EntryKind; title: string | null; entry_date: string; c: string }
      | undefined
    if (!r) return 悬空卡(key, 显示)
    // 这里不按 backlinks() 那条把自指剔掉：卡片说的是"那一头被几处指着"，
    // 而"我这一篇指着它"本来就是其中一处。右栏那一块剔自指是另一件事（它是"谁把我连过来"）
    const 指 = db
      .prepare(`select count(*) c from Link where target_id = ? and target_type in ('entry','date')`)
      .get(号) as unknown as { c: number }
    const 截 = 那一截(String(r.c ?? ''), String(r.c ?? '').length >= 取的字数)
    return {
      是: r.kind === 'diary' ? 'diary' : 'article',
      名字: r.title || formatDateZh(r.entry_date),
      那截: 截.那截,
      截了: 截.截了,
      只有标题: 截.只有标题,
      数: Number(指.c ?? 0),
      最近: null,
    }
  }

  return 悬空卡(key, 显示)
}

/** `![[…]]` 要的那一截（期-05f 丙）。**只读、不落库**：一次嵌入是一次渲染，不是一个事实——
 *  它进不进 `Link` 表是产品决定（`期-05-设计稿.md` §18.5 第 1 条），不是这一层顺手能定的。
 *
 *  切片算在这里而不是渲染进程：最坏那一篇整篇过一趟 IPC 是 20 万字 / 2229 µs
 *  （§11.4 那一次量出来的），而这里回的最多 20000 字，通常几行。
 *
 *  软删（回收站里）与彻底删一样按 miss 处理：那一头已经不在人眼前了，
 *  把它嵌进一篇活着的正文里，等于让回收站往正文里漏字。 */
export function embed(问: EmbedAsk): EmbedCard {
  const { nodeKey, 锚点, 块 } = 问
  const 空 = (名字: string): EmbedCard => ({
    是: 'miss',
    名字,
    md: '',
    命中: false,
    截了: false,
    那种: null,
    出链: [],
    日子: null,
  })

  if (nodeKey?.startsWith('t:')) {
    const t = getDatabase()
      .prepare('select name, description from Topic where id = ?')
      .get(Number(nodeKey.slice(2))) as { name: string; description: string | null } | undefined
    if (!t) return 空(问.key)
    const 切 = 切片(String(t.description ?? ''), null, null)
    return {
      是: 'topic',
      名字: t.name,
      md: 切.md,
      命中: true,
      截了: 切.截了,
      那种: 'topic',
      // 主题的"出链"就是描述里那几条：`outgoing` 吃的是 entryId，主题这一头交白卷——
      // 那棵树里的链接因此一律按写法本身显示，不假装有落点
      出链: [],
      日子: null,
    }
  }

  if (nodeKey?.startsWith('e:')) {
    const 号 = Number(nodeKey.slice(2))
    const r = getDatabase()
      .prepare(
        `select kind, title, entry_date, content from Entry where id = ? and deleted_at is null`
      )
      .get(号) as
      | { kind: EntryKind; title: string | null; entry_date: string; content: string }
      | undefined
    if (!r) return 空(问.key)
    const 切 = 切片(String(r.content ?? ''), 锚点, 块)
    return {
      是: 'entry',
      名字: r.title || formatDateZh(r.entry_date),
      md: 切.md,
      命中: 切.命中,
      截了: 切.截了,
      那种: r.kind === 'diary' ? 'diary' : 'article',
      出链: outgoing(号),
      日子: r.entry_date,
    }
  }

  return 空(问.key)
}

/** `[[` 补全要的那一份候选（期-05b）。
 *
 *  **只取"能被名字指到的东西"**：主题名与带标题的记录。日记**不靠标题**被指——
 *  实测那份 5001 篇的库里带标题的是 0 篇（`scratch/p05b-pre.mjs`），日期那一族由渲染层
 *  按查询本身生成（相对词 / 数字前缀），不枚举几千个日子往 IPC 里塞。
 *
 *  每一次弹层开起来取一次、不做进程级缓存（与 11b 决策 93 同族）：新建与改名下一趟就看得见。
 *  代价量在真界面上：5001 篇那一份库，一次往返 13–14ms（含 3024 行过 IPC），
 *  从打下 `[[` 到画出第一行 14ms。 */
export function candidates(上限 = 3000): { 名录: Candidate[]; 还有: number } {
  const db = getDatabase()
  const 出: Candidate[] = []
  for (const t of db.prepare('select id, name from Topic order by sort_order, id').all() as unknown as {
    id: number
    name: string
  }[])
    出.push({ kind: 'topic', name: t.name, hint: '主题' })
  const 篇 = db
    .prepare(
      `select id, kind, title, entry_date from Entry
       where deleted_at is null and title is not null and trim(title) <> ''
       order by updated_at desc limit ?`
    )
    .all(上限) as unknown as { id: number; kind: 'diary' | 'article'; title: string; entry_date: string }[]
  for (const e of 篇) 出.push({ kind: 'entry', name: e.title, hint: e.kind === 'diary' ? e.entry_date : '文章' })
  // 别名也进候选（期-05c 判据 9.4-7）：打 `[[玻璃` 要能捞出绑在「毛玻璃工艺」上的那个写法，
  // 否则别名在写作时是隐形的——只有管理窗里没有查找口，学不到
  for (const a of db
    .prepare(
      `select a.name n, a.target_type tt from Alias a
       where a.target_type = 'topic'
          or exists (select 1 from Entry e where e.id = a.target_id and e.deleted_at is null)
       order by a.name`
    )
    .all() as unknown as { n: string; tt: 'entry' | 'topic'}[])
    出.push({ kind: a.tt === 'topic' ? 'topic' : 'entry', name: a.n, hint: '别名' })
  // 截断了就要说出来（11b §三 第 7 条那一条口径）：宁可说一句"还有 N 个没列进来"，
  // 也不让用户以为自己打的那个名字"库里没有"
  const 有标题 = db
    .prepare(
      `select count(*) c from Entry where deleted_at is null and title is not null and trim(title) <> ''`
    )
    .get() as { c: number }
  return { 名录: 出, 还有: Math.max(0, Number(有标题.c) - 篇.length) }
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
