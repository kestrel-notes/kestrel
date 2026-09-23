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

/** 一个可见单元：要么是一个条目，要么是一团同主题条目折成的计数节点 */
export type VisibleUnit =
  | { kind: 'node'; node: GraphNodeLite }
  /** `members` 是被折进去的条目 key；`topicKey` 为 null 表示「没归主题」的那一团 */
  | { kind: 'agg'; id: string; topicKey: string | null; label: string; count: number; members: string[] }

export interface Aggregated {
  units: VisibleUnit[]
  edges: GraphEdge[]
  /** 被折成计数节点的主题 → 成员数。给状态条与 tooltip 用 */
  collapsed: { topicKey: string | null; count: number }[]
}

/** 成员数少于这个数的主题不值得折：折了只剩「主题 X · 2 篇」，比平铺两个点更难读 */
const MIN_FOLD = 3

/** 按主题折叠到 `limit` 个可见单元以内。
 *
 *  两条性质，都有单测：
 *  1. **幂等**：对已折叠的结果再折一次，可见单元不变（展开→折叠来回晃时靠它稳住）。
 *  2. **守恒**：`units` 承载的条目数 === 输入 `nodes.length`，一个都不许静默消失。
 *     局部图谱现在就是栽在这条上——超 12 直接丢（设计稿 §5.3）。 */
export function aggregateByTopic(
  nodes: GraphNodeLite[],
  edges: GraphEdge[],
  limit: number
): Aggregated {
  if (nodes.length <= limit) {
    return {
      units: nodes.map((node) => ({ kind: 'node', node }) as VisibleUnit),
      edges,
      collapsed: [],
    }
  }

  const byTopic = new Map<string | null, GraphNodeLite[]>()
  for (const n of nodes) {
    const key = n.topicKey
    const list = byTopic.get(key)
    if (list) list.push(n)
    else byTopic.set(key, [n])
  }

  /** 要折的主题：成员多的先折——留住的是零散的、彼此连接更松的那些 */
  const fold = new Set<string | null>()
  const groups = [...byTopic.entries()].sort((a, b) => b[1].length - a[1].length)
  // 折一组把「1 个主题 + N 个成员」换成 1 个单元，省下 N-1 个位置
  let units = nodes.length
  for (const [topicKey, members] of groups) {
    if (units <= limit) break
    if (members.length < MIN_FOLD) continue
    fold.add(topicKey)
    units -= members.length - 1
  }

  const built: VisibleUnit[] = []
  const collapsed: { topicKey: string | null; count: number }[] = []
  /** 条目 key → 它所在的可见单元 key。边要跟着改挂到聚合节点上 */
  const owner = new Map<string, string>()

  for (const [topicKey, members] of groups) {
    if (!fold.has(topicKey)) {
      for (const m of members) {
        built.push({ kind: 'node', node: m })
        owner.set(m.key, m.key)
      }
      continue
    }
    const label = topicKey === null ? '未归主题' : topicKey
    const id = `agg:${topicKey}`
    built.push({
      kind: 'agg',
      id,
      topicKey,
      label,
      count: members.length,
      members: members.map((m) => m.key),
    })
    collapsed.push({ topicKey, count: members.length })
    for (const m of members) owner.set(m.key, id)
  }

  // 边重挂：同一条线上的两条边折完可能变成同一对单元之间的同类型边，去重
  const seen = new Set<string>()
  const next: GraphEdge[] = []
  for (const e of edges) {
    const a = owner.get(e.source)
    const b = owner.get(e.target)
    if (!a || !b || a === b) continue // 两端折进同一个聚合节点：那条边在折叠视图里不该存在
    const pair = [a, b].sort().join('~')
    const id = `${pair}:${e.kind}`
    if (seen.has(id)) continue
    seen.add(id)
    next.push({ source: a, target: b, kind: e.kind })
  }

  return { units: built, edges: next, collapsed }
}

/** 守恒检查：可见单元承载的条目数。单测与实机验收第 4/5/6 项都读它。 */
export function conservedCount(units: VisibleUnit[]): number {
  return units.reduce((sum, u) => sum + (u.kind === 'node' ? 1 : u.count), 0)
}
