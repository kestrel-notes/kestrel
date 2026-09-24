/** 工作区落库（期-09a §二）。一行 JSON，`Setting` 表里 `key = 'workspace'`。
 *
 *  为什么住在 `Setting` 而不是单开一张表：这一条从头到尾就是「整读整写的一坨」，
 *  没有按标签查、没有部分更新——单开表换来的只有迁移面。
 *  而它又不走 `settings.ts` 那套 `coerce`，理由写在 `shared/workspace.ts` 头上。
 *
 *  这里只有读和写两条。删掉某一篇之后它的标签怎么办，不在这一层解决：
 *  渲染层删的时候顺手关，兜底是 `load()` 那一步按「库里还有没有」过滤（`parseWorkspace`）。
 *  整库换掉（备份恢复）走的是同一条兜底——不需要第三个入口。 */

import { parseWorkspace, type Workspace } from '../../shared/workspace'
import { getDatabase } from './index'

const KEY = 'workspace'
const UPSERT =
  'insert into Setting(key, value) values(?, ?) on conflict(key) do update set value = excluded.value'

/** 库里当下活着的那批 id：删掉的那一篇不该在重启之后还留着一个空标签等着 */
function 活着的(): Set<number> {
  const rows = getDatabase()
    .prepare('select id from Entry where deleted_at is null')
    .all() as unknown as { id: number }[]
  return new Set(rows.map((r) => r.id))
}

/** `null` = 没有工作区，或者那一行读坏了。两种都不猜：处置一模一样（退回今天）。 */
export function load(): Workspace | null {
  const row = getDatabase().prepare('select value from Setting where key = ?').get(KEY) as
    | { value: string }
    | undefined
  if (!row) return null
  let 原: unknown
  try {
    原 = JSON.parse(row.value)
  } catch {
    console.log('[workspace] 那一行不是合法 JSON，当没有工作区')
    return null
  }
  const 净 = parseWorkspace(原, 活着的())
  if (!净) console.log('[workspace] 认不出来（版本或形状不对），当没有工作区')
  return 净
}

export function save(ws: Workspace): void {
  getDatabase().prepare(UPSERT).run(KEY, JSON.stringify(ws))
}
