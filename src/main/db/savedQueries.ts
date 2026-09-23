/** 存查询（期-07 §四）。一行 = 「这句查询值得再打一遍」。
 *
 *  存的是**语句**，用法是把围栏插进正文（决策 D10）：结果不存，存下来就是一份过期副本；
 *  引用也不存，那样导出的 md 在别人手里是死链。
 *  `view` 是从 body 里解析出来顺手存的，只给列表那行灰字用——真要改视图，
 *  改的是语句本身，这里跟着走。 */

import type { SavedQuery } from '../../shared/types'
import { getDatabase } from './index'
import { parseQueryBlock } from '../../shared/queryLang'

const VIEWS = ['table', 'list', 'cards', 'calendar', 'timeline'] as const

export function list(): SavedQuery[] {
  const rows = getDatabase()
    .prepare(
      `select id, name, body, view, created_at, used_at from SavedQuery
       order by coalesce(used_at, created_at) desc, id asc`
    )
    .all() as unknown as Row[]
  return rows.map(toOne)
}

export function create(name: string, body: string): SavedQuery {
  const n = String(name ?? '').trim()
  if (!n) throw new Error('给这条查询起个名字')
  const b = String(body ?? '').trim()
  const parsed = parseQueryBlock(b)
  if ('error' in parsed) throw new Error(`这条查询现在跑不通：${parsed.error.msg}`)
  const db = getDatabase()
  if (db.prepare('select 1 from SavedQuery where name = ?').get(n))
    throw new Error(`已经有一条叫「${n}」的了，换个名字`)
  const now = new Date().toISOString()
  const info = db
    .prepare('insert into SavedQuery(name, body, view, created_at) values(?, ?, ?, ?)')
    .run(n, b, parsed.plan.view, now)
  return get(Number(info.lastInsertRowid))
}

export function update(id: number, patch: { name?: string; body?: string }): SavedQuery {
  const db = getDatabase()
  if (patch.body !== undefined) {
    const b = String(patch.body).trim()
    const parsed = parseQueryBlock(b)
    if ('error' in parsed) throw new Error(`这条查询现在跑不通：${parsed.error.msg}`)
    db.prepare('update SavedQuery set body = ?, view = ? where id = ?').run(b, parsed.plan.view, id)
  }
  if (patch.name !== undefined) {
    const n = String(patch.name).trim()
    if (!n) throw new Error('名字不能是空的')
    const hit = db.prepare('select id from SavedQuery where name = ?').get(n) as { id: number } | undefined
    if (hit && hit.id !== id) throw new Error(`已经有一条叫「${n}」的了`)
    db.prepare('update SavedQuery set name = ? where id = ?').run(n, id)
  }
  return get(id)
}

export function remove(id: number): void {
  // 删掉存查询不影响已经插进正文的那些块：那些块存的是语句本身，与这里没有引用关系
  getDatabase().prepare('delete from SavedQuery where id = ?').run(id)
}

export function markUsed(id: number): void {
  getDatabase().prepare('update SavedQuery set used_at = ? where id = ?').run(
    new Date().toISOString(),
    id
  )
}

function get(id: number): SavedQuery {
  const row = getDatabase()
    .prepare('select id, name, body, view, created_at, used_at from SavedQuery where id = ?')
    .get(id) as Row | undefined
  if (!row) throw new Error(`存查询 ${id} 不存在`)
  return toOne(row)
}

interface Row {
  id: number
  name: string
  body: string
  view: string
  created_at: string
  used_at: string | null
}

function toOne(r: Row): SavedQuery {
  return {
    id: Number(r.id),
    name: r.name,
    body: r.body,
    view: (VIEWS as readonly string[]).includes(r.view) ? (r.view as SavedQuery['view']) : 'table',
    createdAt: r.created_at,
    usedAt: r.used_at,
  }
}
