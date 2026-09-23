/** 图谱聚合（期-06a §5.2）：**「超出就折叠」这件事只做一次，两个视图共用一份实现**。
 *
 *  为什么要有这个文件：右栏局部图谱的 `MAX_NODES = 12` 与全屏图谱的 600 上限是同一个问题的
 *  两个刻度。分两处写的话必然长出两套折叠语义——一处丢节点、一处折节点，用户看不出差别，
 *  但计数从此不可信。共用的判据只有一条：
 *
 *      **输入里每个条目，都要么自己可见、要么被某个聚合节点数着**（守恒，见 `conserve`）。
 *
 *  「聚合不是过滤」（设计稿 §5.2）：折叠由可见单元数触发，**不改数据范围**，所以聚合节点
 *  可以就地展开；过滤是用户主动改数据范围，本期没有过滤。 */

import type { GraphEdge, GraphNodeLite } from './types'

/** 一个可见单元：要么是一个条目，要么是一团条目折成的计数节点 */
export type VisibleUnit =
  | { kind: 'node'; node: GraphNodeLite }
  /** `members` 是被折进去的条目 key；`topicKey` 为 null 表示「没归主题」的那一团。
   *  `bin` 只有时间视图的格子才有（6b）：力导向视图按主题折，不需要这一维 */
  | {
      kind: 'agg'
      id: string
      topicKey: string | null
      label: string
      count: number
      members: string[]
      bin?: string
    }

export interface Aggregated {
  units: VisibleUnit[]
  edges: GraphEdge[]
  /** 被折成计数节点的主题 → 成员数。给状态条与 tooltip 用 */
  collapsed: { topicKey: string | null; count: number }[]
}

/** 成员数少于这个数的主题不值得折：折了只剩「主题 X · 2 篇」，比平铺两个点更难读 */
const MIN_FOLD = 3

/** 折叠的唯一实现。6a 按主题折、6b 按 (主题 × 时间箱) 折，**分组规则之外的一切共用**：
 *  选组顺序、边重挂与去重、自环丢弃、`Aggregated` 的形状、守恒口径。
 *  分两处写必然长出两套语义，计数从此不可信（本文件开头那条理由，6b 仍然成立）。 */
interface FoldSpec {
  /** 条目 → 分组 key */
  groupOf: (n: GraphNodeLite) => string
  /** 分组 key → 顶栏与 tooltip 里的那行字 */
  labelOf: (groupKey: string) => string
  /** 分组 key → 着色用的主题 key（null 走回落色） */
  topicOf: (groupKey: string) => string | null
  /** 单元 id 前缀：力导向 `agg:`、时间视图 `cell:` */
  prefix: string
  /** 少于这个成员数就留散点。6a 是 3；时间格子里 2 条就该并成一个点 */
  minFold: number
  /** 要不要把顶栏那行「已折叠 N 个主题」填出来 */
  reportCollapsed: boolean
}

function foldBy(nodes: GraphNodeLite[], edges: GraphEdge[], limit: number, spec: FoldSpec): Aggregated {
  if (nodes.length <= limit) {
    return {
      units: nodes.map((node) => ({ kind: 'node', node }) as VisibleUnit),
      edges,
      collapsed: [],
    }
  }

  const groups = new Map<string, GraphNodeLite[]>()
  for (const n of nodes) {
    const key = spec.groupOf(n)
    const list = groups.get(key)
    if (list) list.push(n)
    else groups.set(key, [n])
  }

  /** 要折的组：成员多的先折——留住的是零散的、彼此连接更松的那些 */
  const fold = new Set<string>()
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
  // 折一组把「1 个单元 + N 个成员」换成 1 个单元，省下 N-1 个位置
  let units = nodes.length
  for (const [key, members] of ordered) {
    if (units <= limit) break
    if (members.length < spec.minFold) continue
    fold.add(key)
    units -= members.length - 1
  }

  const built: VisibleUnit[] = []
  const collapsed: { topicKey: string | null; count: number }[] = []
  /** 条目 key → 它所在的可见单元 id。边要跟着改挂到聚合节点上 */
  const owner = new Map<string, string>()

  for (const [key, members] of ordered) {
    if (!fold.has(key)) {
      for (const m of members) {
        built.push({ kind: 'node', node: m })
        owner.set(m.key, m.key)
      }
      continue
    }
    const id = `${spec.prefix}:${key}`
    const unit: VisibleUnit = {
      kind: 'agg',
      id,
      topicKey: spec.topicOf(key),
      label: spec.labelOf(key),
      count: members.length,
      members: members.map((m) => m.key),
    }
    if (spec.prefix === 'cell') unit.bin = key.slice(key.indexOf('|') + 1)
    built.push(unit)
    if (spec.reportCollapsed) collapsed.push({ topicKey: unit.topicKey, count: members.length })
    for (const m of members) owner.set(m.key, id)
  }

  // 边重挂：同一条线上的两条边折完可能变成同一对单元之间的同类型边，去重
  const seen = new Set<string>()
  const next: GraphEdge[] = []
  for (const e of edges) {
    const a = owner.get(e.source)
    const b = owner.get(e.target)
    if (!a || !b || a === b) continue // 两端折进同一个单元：那条线在这一层视图里不该存在
    const pair = [a, b].sort().join('~')
    const id = `${pair}:${e.kind}`
    if (seen.has(id)) continue
    seen.add(id)
    next.push({ source: a, target: b, kind: e.kind })
  }

  return { units: built, edges: next, collapsed }
}

/** 按主题折叠到 `limit` 个可见单元以内。
 *
 *  两条性质，都有单测：
 *  1. **幂等**：对已折叠的结果再折一次，可见单元不变（展开→折叠来回晃时靠它稳住）。
 *  2. **守恒**：`units` 承载的条目数 === 输入 `nodes.length`，一个都不许静默消失。
 *     局部图谱以前就是栽在这条上——超 12 直接丢（6a 设计稿 §5.3）。
 *
 *  `topicName` 只影响计数节点上那行字，不影响折叠判据。6a 实机验收漏了它，
 *  于是折叠节点 tooltip 写的是 `t:3 · 250 条`——topicKey 直接当名字用了（6b §六补记）。 */
export function aggregateByTopic(
  nodes: GraphNodeLite[],
  edges: GraphEdge[],
  limit: number,
  topicName?: (key: string) => string
): Aggregated {
  return foldBy(nodes, edges, limit, {
    groupOf: (n) => n.topicKey ?? '',
    labelOf: (k) => (k === '' ? '未归主题' : (topicName?.(k) ?? k)),
    topicOf: (k) => (k === '' ? null : k),
    prefix: 'agg',
    minFold: MIN_FOLD,
    reportCollapsed: true,
  })
}

/*  时间视图的折叠单元：主题 × 时间箱（期-06b §三）
 *
 *  6a 的折叠不能照搬——一个主题横跨所有日期，按主题折成一个点就把时间轴抹平了。
 *  换成 (主题, 箱) 之后两条性质都还在：轴还在（箱 = 列）、守恒还在（格子数着成员）。
 *  前置实测（`scratch/p6b-cell-shape.mjs`）否掉了另一条路：折到月格之后单元间的边
 *  仍有 4994 条（原始 5660），**折叠救不了"全边画弧"**，所以时间视图只画密度，
 *  弧线等用户点到某一格再画（那一格的被连线数实测 p90=48、max=159，画得动）。 */

/** 分箱档位。越小越细，但列数会爆——`pickBinUnit` 按可用列数选档 */
export type BinUnit = 'day' | 'week' | 'month' | 'quarter' | 'year'

const BIN_ORDER: BinUnit[] = ['day', 'week', 'month', 'quarter', 'year']
const DAY_MS = 86400000

/** 一个日期属于哪个箱。返回**可排序**的稳定 key：日与周用当天/周一的日期，月/季用 `YYYY-MM`，年用 `YYYY` */
export function binOf(date: string, unit: BinUnit): string {
  const y = date.slice(0, 4)
  const m = date.slice(5, 7)
  const d = date.slice(8, 10)
  if (!y || !m || !d) return ''
  switch (unit) {
    case 'day':
      return `${y}-${m}-${d}`
    case 'week': {
      const t = Date.parse(`${y}-${m}-${d}T00:00:00Z`)
      // getUTCDay: 周日=0 → 挪到本周一。跨年那周的 key 属于上一年，排序仍然正确
      const back = (((new Date(t).getUTCDay() + 6) % 7) * DAY_MS)
      return new Date(t - back).toISOString().slice(0, 10)
    }
    case 'month':
      return `${y}-${m}`
    case 'quarter':
      return `${y}-${String((Math.ceil(Number(m) / 3) - 1) * 3 + 1).padStart(2, '0')}`
    case 'year':
      return y
  }
}

/** 箱 key 显示成什么。列与列之间靠这个分辨，年份只在跨年那一列重复出现 */
export function binLabel(key: string, unit: BinUnit): string {
  if (!key) return '无日期'
  switch (unit) {
    case 'day':
    case 'week':
      return `${key.slice(5, 7)}-${key.slice(8, 10)}`
    case 'month':
      return `${key.slice(0, 4)}-${key.slice(5, 7)}`
    case 'quarter':
      return `${key.slice(0, 4)} Q${Math.ceil(Number(key.slice(5, 7)) / 3)}`
    case 'year':
      return key
  }
}

/** 选档：列数不超过 `maxCols` 的前提下尽量细。天数是跨度（首尾之差），不是条目数 */
export function pickBinUnit(days: number, maxCols = 40): BinUnit {
  const per: Record<BinUnit, number> = { day: 1, week: 7, month: 30.44, quarter: 91.31, year: 365.25 }
  for (const u of BIN_ORDER) {
    if (Math.ceil((days + 1) / per[u]) <= maxCols) return u
  }
  return 'year'
}

export interface TimeCells extends Aggregated {
  /** 有序的箱 key = X 轴的列 */
  bins: string[]
  /** 有序的 lane key = Y 轴的行。`'untouched'` 永远排最后 */
  lanes: string[]
  unit: BinUnit
}

/** 时间格子的折叠。`limit` 这里不是性能闸门而是"永远折"——格子的定义就是 (主题, 箱)。
 *  单成员的格子留散点：小库里 6 条 4 天，全散点比 6 个计数节点诚实得多。 */
export function buildTimeCells(
  nodes: GraphNodeLite[],
  edges: GraphEdge[],
  unit: BinUnit,
  topicName: (key: string | null) => string
): TimeCells {
  const laneOf = (n: GraphNodeLite): string => n.topicKey ?? 'untouched'
  const base = foldBy(nodes, edges, 0, {
    groupOf: (n) => `${laneOf(n)}|${binOf(n.date, unit)}`,
    labelOf: (k) => `${topicName(k.startsWith('untouched|') ? null : k.slice(0, k.indexOf('|')))} · ${binLabel(k.slice(k.indexOf('|') + 1), unit)}`,
    topicOf: (k) => (k.startsWith('untouched|') ? null : k.slice(0, k.indexOf('|'))),
    prefix: 'cell',
    minFold: 2,
    reportCollapsed: false,
  })
  const bins = new Set<string>()
  const laneCount = new Map<string, number>()
  for (const n of nodes) {
    const b = binOf(n.date, unit)
    if (b) bins.add(b)
    laneCount.set(laneOf(n), (laneCount.get(laneOf(n)) ?? 0) + 1)
  }
  return {
    ...base,
    bins: [...bins].sort(),
    lanes: [...laneCount.entries()]
      .sort((a, b) => (a[0] === 'untouched' ? 1 : b[0] === 'untouched' ? -1 : b[1] - a[1]))
      .map(([k]) => k),
    unit,
  }
}

/** 守恒检查：可见单元承载的条目数。单测与实机验收第 4/5/6 项都读它。 */
export function conservedCount(units: VisibleUnit[]): number {
  return units.reduce((sum, u) => sum + (u.kind === 'node' ? 1 : u.count), 0)
}

/*  过滤：「聚合不是过滤」那条界的另一侧（期-06b §四）
 *
 *  折叠由渲染层为了看得清触发、不改数据范围；过滤是用户主动改数据范围。
 *  顺序固定为 **先过滤、后折叠**：反过来就会报出"显示 240 / 共 3001"这种
 *  分母是筛前、分子是筛后的假数字。 */

export interface GraphFilter {
  /** topicKey 白名单。空数组 = 不限主题；`'untouched'` 是"没归主题"这一档的假 key */
  topics: string[]
  kind: 'all' | 'diary' | 'article'
  /** 只留最近 N 天。null = 不限。基准是"今天"，不是库里最新那天 */
  sinceDays: number | null
}

export const NO_FILTER: GraphFilter = { topics: [], kind: 'all', sinceDays: null }

/** 有没有在筛。给"清除"按钮和顶栏那枚徽标用——筛着的状态必须看得见，
 *  否则下次 Ctrl+G 开出来只剩 12 个点，用户会以为图谱坏了 */
export function isFilterActive(f: GraphFilter): boolean {
  return f.topics.length > 0 || f.kind !== 'all' || f.sinceDays !== null
}

/** `today` 由调用方给（渲染层的 Date，或单测里的定值），这样这个函数是纯的 */
export function filterGraph(
  nodes: GraphNodeLite[],
  edges: GraphEdge[],
  filter: GraphFilter,
  today: string
): { nodes: GraphNodeLite[]; edges: GraphEdge[] } {
  if (!isFilterActive(filter)) return { nodes, edges }
  const cutoff =
    filter.sinceDays === null
      ? null
      : new Date(Date.parse(`${today}T00:00:00Z`) - filter.sinceDays * 86400000)
          .toISOString()
          .slice(0, 10)
  const topics = new Set(filter.topics)
  const kept = nodes.filter((n) => {
    if (filter.kind !== 'all' && n.type !== filter.kind) return false
    if (topics.size > 0 && !(topics.has(n.topicKey ?? 'untouched'))) return false
    // 日期不合规的条目（老库里的空串）留在结果里：过滤是"缩小"，不该把看不懂的行藏掉
    if (cutoff !== null && n.date !== '' && n.date < cutoff) return false
    return true
  })
  const live = new Set(kept.map((n) => n.key))
  return { nodes: kept, edges: edges.filter((e) => live.has(e.source) && live.has(e.target)) }
}
