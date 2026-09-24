/** 思想重复度（期-11b §一、§二）：同一个目标被反复提到、而提到它的那些篇彼此没连。
 *
 *  为什么只有这一种信号（实测 `scratch/p12-pre.mjs`）：主题与标签那三种在合成库上也能捞出
 *  11 / 12 / 4 个「≥3 个月」的簇，可那些簇里几乎每一对都已经互链（93 篇的簇里 105 对）——
 *  **类别不是重复**，把它们再报一遍只是把反链与编年史说过的话重说一次。
 *
 *  现算不缓存（决策 93）：全库 124 簇纯 SQL 3ms，缓存它反而多养一份会过期的真相
 *  （改正文、删一篇、悬空被认领，那份缓存立刻就是假的）。
 *
 *  「未链接」这一刀放在 JS 里判而不是塞进一条 SQL：SQL 那边要拿 `group_concat` 的 id 串再去比
 *  两两配对，写出来既难读又难测；这里一次把全库的 entry→entry 边读成集合，两两查表。 */

import type { Repeat, RepeatTargetKind } from '../../shared/types'
import { getDatabase } from './index'

/** 一簇至少要跨几个不同的月。这个数不是这里挑的——它是路线图上那句话里的数，
 *  界面上要把它显示出来（"跨 7 个月"），让人能自己判这一条要不要理。 */
export const 最少跨月 = 3

/** 全库清单一次最多回多少簇（§三 第 7 条：剩下的要说"还有几条没列出来"） */
export const 清单上限 = 50

interface 提行 {
  tt: string | null
  tid: number | null
  raw: string
  sid: number
  m: string
}

/** 一簇的原料：`[[目标]]` 被哪些篇、在哪些月份提到过。
 *
 *  键取 `(target_type, target_id, target_raw)`——`Link.target_raw` 存的已经是规范化查找键
 *  （`links.ts` 那条不变量），所以 `[[X]]` / `[[ X ]]` / `[[x]]` 三种写法天然落进同一簇。
 *  悬空是 `target_id IS NULL` 的那一簇，它照样参与（决策 95：那是最强的信号，不是脏数据）。 */
function 全部簇(): Repeat[] {
  const db = getDatabase()
  const 提 = db
    .prepare(
      `select l.target_type tt, l.target_id tid, l.target_raw raw,
              l.source_id sid, substr(e.entry_date,1,7) m
       from Link l join Entry e on e.id = l.source_id
       where l.source_type = 'entry' and e.deleted_at is null and e.entry_date is not null`
    )
    .all() as unknown as 提行[]

  const 边 = new Set<string>()
  // `'entry'` 一种不够：日记被 `[[2024-06-11]]` 这样的日期链指到时，`target_type` 是 `'date'`
  // （`links.ts:194` 那条注释就是为这件事写的）。而"这一篇和那一篇是同一件事"最常见的写法
  // 恰恰就是提那一天的日期——漏掉这一路，"彼此没连"会报出一大片假簇（实机 p12-live 判据 9 抓到过）
  for (const r of db
    .prepare(
      `select source_id a, target_id b from Link
       where source_type='entry' and target_type in ('entry','date') and target_id is not null and source_id <> target_id`
    )
    .all() as unknown as { a: number; b: number }[]) {
    边.add(`${r.a}:${r.b}`)
    边.add(`${r.b}:${r.a}`)
  }

  const 组 = new Map<string, { tt: string | null; tid: number | null; raw: string; 篇: Map<number, string> }>()
  for (const r of 提) {
    const 键 = r.tid !== null ? `${r.tt}:${r.tid}` : `raw:${r.raw}`
    let g = 组.get(键)
    if (!g) 组.set(键, (g = { tt: r.tt, tid: r.tid, raw: r.raw, 篇: new Map() }))
    g.篇.set(r.sid, r.m)
  }

  const 出: Repeat[] = []
  for (const [键, g] of 组) {
    const ids = [...g.篇.keys()]
    if (ids.length < 2) continue
    // 簇内只要有一条互链，这一簇就不算「未链接」（§三 第 2 条）
    let 互链 = 0
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) if (边.has(`${ids[i]}:${ids[j]}`)) 互链++
    if (互链 > 0) continue

    const 月 = [...new Set(g.篇.values())].sort()
    if (月.length < 最少跨月) continue

    const 占位 = db
      .prepare(
        `select id, kind, title, entry_date from Entry
         where id in (${ids.map(() => '?').join(',')}) and deleted_at is null
         order by entry_date asc, id asc`
      )
      .all(...ids) as unknown as {
      id: number
      kind: 'diary' | 'article'
      title: string | null
      entry_date: string
    }[]
    if (占位.length === 0) continue

    const 是主题 = g.tt === 'topic'
    // 名字分两路取：主题在 Topic.name，文章在 Entry.title（悬空两边都没有，落回那个写法本身）
    const 名 = 是主题
      ? (db.prepare('select name from Topic where id = ?').get(g.tid ?? -1) as { name: string } | undefined)?.name
      : g.tid === null
        ? undefined
        : (db.prepare('select title from Entry where id = ?').get(g.tid) as { title: string | null } | undefined)?.title

    出.push({
      key: 键,
      kind: (是主题 ? 'topic' : g.tid === null ? 'dangling' : 'entry') as RepeatTargetKind,
      目标: 名 ?? g.raw,
      存在: g.tid !== null,
      跨月: 月.length,
      月份: 月,
      篇数: 占位.length,
      篇: 占位.map((p) => ({ id: p.id, kind: p.kind, title: p.title, entryDate: p.entry_date })),
    })
  }
  // §三 第 6 条：先按跨的月数，再按篇数——"三个月各提一次"比"一个月里提十次"更接近这一档的语义
  出.sort((a, b) => b.跨月 - a.跨月 || b.篇数 - a.篇数 || a.key.localeCompare(b.key))
  return 出
}

/** 全库清单。`还有` 是没列出来的条数，界面上要说（不静默截断）。 */
export function all(上限: number = 清单上限): { 簇: Repeat[]; 还有: number } {
  const 全 = 全部簇()
  return { 簇: 全.slice(0, 上限), 还有: Math.max(0, 全.length - 上限) }
}

/** 当前这一篇掺在哪些簇里。右栏那一块用它；不掺就没有——那块整块不渲染（§四）。 */
export function forEntry(entryId: number, 上限: number = 清单上限): { 簇: Repeat[]; 还有: number } {
  const 全 = 全部簇().filter((r) => r.篇.some((p) => p.id === entryId))
  return { 簇: 全.slice(0, 上限), 还有: Math.max(0, 全.length - 上限) }
}
