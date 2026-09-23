/** 模板（期-07 §五）。一行 = 「这样的开头我打过不止一次」。
 *
 *  `body` 存的是**带标记的原文**（`{{date:YYYY-MM-DD}}` 那些）。展开只发生在"套用"那一刻，
 *  由渲染层调 `shared/template.ts` 算出最终文本再插进正文——主进程不参与展开，
 *  因为它不知道该以"哪一天"为准（用户可以在补写上周的日记）。
 *
 *  `is_default` 每个 scope 只允许一条，这条不变量由 `idx_template_default` 那个
 *  部分唯一索引钉住（实测见 `scratch/p7-cost.mjs`）。所以设新默认要走事务：
 *  先把同 scope 的其它默认取消，再立它——两条 insert/update 分开提交，
 *  中间任一条失败就会留下 0 条或 2 条默认。 */

import type { Template } from '../../shared/types'
import { getDatabase, transact } from './index'

const SCOPES: Template['scope'][] = ['diary', 'article']

export function list(): Template[] {
  const rows = getDatabase()
    .prepare(
      `select id, name, scope, body, is_default, created_at, updated_at from Template
       order by scope asc, is_default desc, updated_at desc, id asc`
    )
    .all() as unknown as Row[]
  return rows.map(toOne)
}

export function create(input: {
  name: string
  scope: string
  body: string
  isDefault?: boolean
}): Template {
  const name = String(input.name ?? '').trim()
  if (!name) throw new Error('给这条模板起个名字')
  if (!SCOPES.includes(input.scope as Template['scope']))
    throw new Error('模板只分两类：日记（diary）与文章（article）')
  const scope = input.scope as Template['scope']
  const body = String(input.body ?? '')
  if (!body.trim()) throw new Error('模板正文是空的')
  const now = new Date().toISOString()

  return transact(() => {
    const db = getDatabase()
    if (input.isDefault) clearDefault(scope)
    const info = db
      .prepare(
        'insert into Template(name, scope, body, is_default, created_at, updated_at) values(?, ?, ?, ?, ?, ?)'
      )
      .run(name, scope, body, input.isDefault ? 1 : 0, now, now)
    return get(Number(info.lastInsertRowid))
  })
}

export function update(
  id: number,
  patch: { name?: string; body?: string; isDefault?: boolean }
): Template {
  const now = new Date().toISOString()
  return transact(() => {
    const db = getDatabase()
    const cur = get(id)
    // 先把同 scope 的旧默认全清掉，再把这一条立起来——顺序反了就变成「谁都不是默认」
    // （实机验收第 9 项撞出来的：换默认之后那一档剩 0 条）
    if (patch.isDefault === true) clearDefault(cur.scope)
    const isDefault = patch.isDefault === undefined ? cur.isDefault : patch.isDefault
    const name = patch.name === undefined ? cur.name : String(patch.name).trim()
    if (!name) throw new Error('名字不能是空的')
    const body = patch.body === undefined ? cur.body : String(patch.body)
    db.prepare('update Template set name = ?, body = ?, is_default = ?, updated_at = ? where id = ?').run(
      name,
      body,
      isDefault ? 1 : 0,
      now,
      id
    )
    return get(id)
  })
}

export function remove(id: number): void {
  getDatabase().prepare('delete from Template where id = ?').run(id)
}

/** 这一类当前该套哪条。没有默认返回 null，界面上就是"空白新开" */
export function defaultFor(scope: Template['scope']): Template | null {
  const row = getDatabase()
    .prepare(
      `select id, name, scope, body, is_default, created_at, updated_at from Template
       where scope = ? and is_default = 1 limit 1`
    )
    .get(scope) as Row | undefined
  return row ? toOne(row) : null
}

function clearDefault(scope: Template['scope']): void {
  getDatabase().prepare('update Template set is_default = 0 where scope = ?').run(scope)
}

function get(id: number): Template {
  const row = getDatabase()
    .prepare(
      `select id, name, scope, body, is_default, created_at, updated_at from Template where id = ?`
    )
    .get(id) as Row | undefined
  if (!row) throw new Error(`模板 ${id} 不存在`)
  return toOne(row)
}

interface Row {
  id: number
  name: string
  scope: string
  body: string
  is_default: number
  created_at: string
  updated_at: string
}

function toOne(r: Row): Template {
  return {
    id: Number(r.id),
    name: r.name,
    scope: r.scope === 'article' ? 'article' : 'diary',
    body: r.body,
    isDefault: Number(r.is_default) === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
