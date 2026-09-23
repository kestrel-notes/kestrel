/** 编年史与跨年同日关联共用的两件小事（期-06b-2 §一 §二）。
 *
 *  为什么放在 shared 而不是组件里：这两条判据都得能自动验收，而组件里的判据只有开着应用
 *  才验得到。跨年卡什么时候该出现（§0.3 那条 42% 与 29% 的差别）就是这里的两行代码，
 *  它必须是可测的，否则"静默卡不吵人"这句话永远只是一句设计意图。 */

import { parseTags } from './tags'
import type { CrossYearHit, EntryKind } from './types'

/** 一篇正文里出现过的标签名，**含各级父名**。
 *
 *  为什么要展开父级：`EntryTag` 那边 `#a/b/c` 会插三级各一行（`main/db/tags.ts`），
 *  所以「今年写 `#网络/双链`、去年只写 `#网络`」在库里是共享标签的。这里不展开就会少认一批，
 *  而 §0.3 那个 29% 的命中率是按库里的行数的——两边得是一个口径。
 *  口径对上了，这里就不必再去查 `EntryTag`：正文本来就在手上。 */
export function tagNamesOf(content: string): Set<string> {
  const names = new Set<string>()
  for (const tag of parseTags(content)) {
    for (let d = 1; d <= tag.path.length; d++) names.add(tag.path.slice(0, d).join('/'))
  }
  return names
}

/** 候选的一条：某年今天那一篇。`content` 带着是因为判据要看它里面的 `#tag`。 */
export interface PastCandidate {
  entryId: number
  /** 隔了几年：1 = 去年今天，2 = 前年今天 */
  years: number
  date: string
  kind: EntryKind
  title: string | null
  topicId: number | null
  topicName: string | null
  content: string
}

/** 最多几张卡。同一天可能既有日记又有几篇文章，全列出来就不是「一行静默卡」了。
 *  截断只看列表顺序（去年在前），不做相关度排序——这里没有可比的分。 */
export const CROSS_YEAR_MAX = 3

/** 哪些「那年今天」值得提一句：**共享标签或共享主题**，二者皆无就不出卡。
 *
 *  判据来自 §0.3：三年库里 42% 的日记日存在「去年今天」，但共享主题的只有 1%、
 *  共享标签的 29%。只按"那天有东西"弹是噪声，只按共享主题弹两年等不到一次。
 *  `why` 取第一个成立的共享项，标签优先——它比主题更具体，卡上那行字更有信息量。 */
export function crossYearHits(
  mine: { content: string; topicId: number | null },
  past: PastCandidate[]
): CrossYearHit[] {
  const mineTags = tagNamesOf(mine.content)
  const out: CrossYearHit[] = []

  for (const p of past) {
    if (out.length >= CROSS_YEAR_MAX) break
    if (p.entryId === undefined) continue

    const shared = p.content ? firstShared(mineTags, tagNamesOf(p.content)) : undefined
    if (shared) {
      out.push(hit(p, { kind: 'tag', name: shared }))
      continue
    }
    // 同主题：两边都得真归了主题，null === null 不算共享
    if (mine.topicId !== null && p.topicId === mine.topicId) {
      out.push(hit(p, { kind: 'topic', name: p.topicName ?? '' }))
    }
  }
  return out
}

function hit(p: PastCandidate, why: CrossYearHit['why']): CrossYearHit {
  return {
    entryId: p.entryId,
    years: p.years,
    date: p.date,
    kind: p.kind,
    title: p.title,
    topicName: p.topicName,
    why,
  }
}

/** 两个集合的第一个交集元素。要确定序：`Set` 的迭代序是插入序，而插入序跟着正文里
 *  标签出现的先后走，所以同一篇正文两次算给出的是同一个名字——卡上的字不该闪。 */
function firstShared(a: Set<string>, b: Set<string>): string | undefined {
  for (const name of a) if (b.has(name)) return name
  return undefined
}
