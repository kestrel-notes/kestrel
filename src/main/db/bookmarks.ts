/** 收藏层（期-02-设计 §3.4）。一行 = 「用户当时指着哪一个东西说了一句记住它」。
 *
 *  两件事决定了这个文件的样子：
 *  1. `ref` 是多态的（entry / topic / tag 三种行号），所以表上**没有外键**（§4.1）。
 *     后果是「指向的东西没了」是一种要画出来的状态，而不是数据库保证不会发生的事：
 *     彻底删除条目时 `entries.ts:purge()` 手工清这一行，标签被改名并进去、主题被删掉时
 *     也可能留下悬空行——`list()` 每次现查它们的状态，宁可画成灰色也不装作不存在。
 *  2. `title` 存的是**收藏那一刻**的名字。改名之后这一行还认得出当初收的是什么，
 *     代价是它不跟着更新——那是这条设计的本意，不是缺陷。
 *
 *  不落 `sort_order`：本期不做拖拽排序（§8-D2），`created_at desc` 就是顺序。 */

import type { Bookmark, BookmarkKind } from '../../shared/types'
import { getDatabase } from './index'

const KINDS: BookmarkKind[] = ['entry', 'topic', 'tag']

/** 某一类对象的「现存的行号」。一次取全而不是逐行查：收藏是几十行的量级，
 *  而逐行查会变成 N 次 prepare + N 次往返。 */
function idSet(sql: string): Set<number> {
  const rows = getDatabase().prepare(sql).all() as unknown as { id: number }[]
  return new Set(rows.map((r) => Number(r.id)))
}

export function list(): Bookmark[] {
  const raw = getDatabase()
    .prepare('select id, kind, ref, title, created_at from Bookmark order by created_at desc, id desc')
    .all() as unknown as { id: number; kind: string; ref: number; title: string; created_at: string }[]

  const kinds = new Set(raw.map((r) => r.kind))
  const alive = kinds.has('entry') ? idSet('select id from Entry where deleted_at is null') : null
  const inBin = kinds.has('entry') ? idSet('select id from Entry where deleted_at is not null') : null
  const topics = kinds.has('topic') ? idSet('select id from Topic') : null
  const tags = kinds.has('tag') ? idSet('select id from Tag') : null

  return raw.map((r) => ({
    id: r.id,
    kind: r.kind as BookmarkKind,
    ref: r.ref,
    title: r.title,
    createdAt: r.created_at,
    state:
      r.kind === 'entry'
        ? alive?.has(r.ref)
          ? 'ok'
          : inBin?.has(r.ref)
            ? 'deleted'
            : 'gone'
        : r.kind === 'topic'
          ? topics?.has(r.ref)
            ? 'ok'
            : 'gone'
          : tags?.has(r.ref)
            ? 'ok'
            : 'gone',
  }))
}

/** 收藏 ⇄ 取消收藏。返回**操作之后**的状态。
 *  判据是「这一行在不在」而不是「在不在回收站」——回收站里的东西照样值得收藏，
 *  那一条要显示成灰色而不是被静悄悄删掉（§3.4）。 */
export function toggle(kind: BookmarkKind, ref: number, title: string): boolean {
  const db = getDatabase()
  // 渲染层传来的都是字符串，但通道被人误用时让 CHECK 约束报 sqlite 的英文话不划算
  if (!KINDS.includes(kind)) throw new Error(`收藏不认得这种对象：${String(kind)}`)
  if (!Number.isInteger(ref) || ref <= 0) throw new Error('收藏没指到具体的那一条')

  const removed = db.prepare('delete from Bookmark where kind = ? and ref = ?').run(kind, ref)
  if (Number(removed.changes) > 0) return false

  db.prepare('insert into Bookmark(kind, ref, title, created_at) values(?, ?, ?, ?)').run(
    kind,
    ref,
    title.trim() === '' ? '（没有名字）' : title.trim(),
    new Date().toISOString()
  )
  return true
}
