/** 标签层。与 `links.ts` 同一条路子：**正文是真相源**，保存时把派生表整删整插。
 *
 *  与 Link 的两点差别，都是有意的：
 *  1. `Tag` 行**只增不删**。它的 `color` / `description` 是用户配的，跟着正文里的
 *     `#tag` 消失等于顺手毁配置。所以「这个标签还在不在」看 `EntryTag`，不看 `Tag`。
 *  2. `#a/b/c` 会插**三级各一行**（a、a/b、a/b/c）。这样「点父标签能不能筛出子孙的条目」
 *     根本不需要递归查询，`count(*) group by tag_id` 出来的父计数天然就是合计。
 *     代价是一篇三层标签写三行，个人量级下不值一提。 */

import { parseTags, tagColorIndex } from '../../shared/tags'
import type { TagNode } from '../../shared/types'
import { getDatabase } from './index'

interface TagRow {
  id: number
  name: string
  display: string
  color: number | null
  count: number
}

/** 全量重解析一条记录的标签：先删它的所有 `EntryTag`，再按正文重插。
 *
 *  与 `reparseEntry` 同样的约束——**必须在调用方的事务里**，delete 成功而 insert 失败
 *  会留下一篇「有正文没标签」的记录，而这种不一致用户看不出来。 */
export function reparseTags(entryId: number): void {
  const db = getDatabase()
  const src = db.prepare('select id, content from Entry where id = ?').get(entryId) as
    | { id: number; content: string }
    | undefined
  if (!src) return

  db.prepare('delete from EntryTag where entry_id = ?').run(entryId)

  // insert or ignore：已有行保留，用户手改过的颜色不会因为哪篇重新保存就被冲掉。
  // color 一律先落 null —— 「NULL = 按名字哈希取色」「非 NULL = 用户自己指定过」这两种情况
  // 必须分得开，标签重命名才知道要不要把用户的选择带过去（见 db/text.ts）。
  const upsert = db.prepare('insert or ignore into Tag(name, display, color) values(?, ?, null)')
  const findTag = db.prepare('select id from Tag where name = ?')
  const link = db.prepare('insert or ignore into EntryTag(entry_id, tag_id, raw) values(?, ?, ?)')

  for (const tag of parseTags(src.content)) {
    const displaySegs = tag.display.split('/')
    for (let d = 1; d <= tag.path.length; d++) {
      const name = tag.path.slice(0, d).join('/')
      upsert.run(name, displaySegs[d - 1] ?? name)
      const row = findTag.get(name) as { id: number }
      // raw 存整串的原样写法（不是该级自己的），重命名时按整 token 匹配正文
      link.run(entryId, row.id, tag.display)
    }
  }
}

/** 标签树，带计数。0 命中的标签不出现——它们本来也不该出现在导航里。
 *
 *  这里的 inner join 就是全部的过滤：`Tag` 行只在被 `EntryTag` 引用时才有计数，
 *  而 §2 说的「父节点靠子孙也有行」让父节点必然跟着出现，所以不必再递归算合计。 */
export function tree(): TagNode[] {
  const rows = getDatabase()
    .prepare(
      `select t.id, t.name, t.display, t.color, count(*) as count
       from Tag t
       join EntryTag et on et.tag_id = t.id
       join Entry e on e.id = et.entry_id and e.deleted_at is null
       group by t.id`
    )
    .all() as unknown as TagRow[]

  const roots: TagNode[] = []
  const index = new Map<string, TagNode>()

  // 按路径深度排，父一定先于子建好；同层按计数倒序，多的排前面
  const sorted = [...rows].sort((a, b) => {
    const da = a.name.split('/').length
    const db = b.name.split('/').length
    if (da !== db) return da - db
    if (b.count !== a.count) return b.count - a.count
    return a.display.localeCompare(b.display, 'zh-Hans')
  })

  for (const r of sorted) {
    const segs = r.name.split('/')
    const node: TagNode = {
      id: r.id,
      name: r.name,
      display: segs[segs.length - 1],
      color: r.color ?? tagColorIndex(r.name),
      count: r.count,
      children: [],
    }
    index.set(r.name, node)
    const parent = segs.length > 1 ? index.get(segs.slice(0, -1).join('/')) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  return roots
}

/** 标签被全部正文删掉之后，`Tag` 行留着（见文件头第 1 点）。这里给渲染层一个准信：
 *  有没有「配过色但已经没人用」的标签，将来做清理 UI 时不必再猜。 */
export function orphanCount(): number {
  const row = getDatabase()
    .prepare(
      `select count(*) as c from Tag t
       where not exists (
         select 1 from EntryTag et join Entry e on e.id = et.entry_id and e.deleted_at is null
         where et.tag_id = t.id)`
    )
    .get() as { c: number }
  return row.c
}
