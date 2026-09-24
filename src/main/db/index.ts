import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS } from './schema'

/** SQLite 连接。
 *
 *  用 Electron 内置的 node:sqlite（Node 24 / SQLite 3.53）而不是 better-sqlite3：
 *  同样是单文件库 + 事务 + FTS5，但省掉了原生模块对 Electron ABI 的重编译，
 *  也就省掉了 Windows 上的 MSVC 构建链。API 差异（无 db.transaction 包装、
 *  对象参数要自己序列化）都收在这个目录里，将来要换驱动只动这一层。 */

let db: DatabaseSync | null = null
/** 当前开着的是哪个文件。`closeDatabase()` 之后仍然留着：换库（备份恢复）要在关掉之后
 *  才知道该把哪一份写回哪儿，而那个路径只有这一层知道。 */
let file: string | null = null

export function openDatabase(next: string): DatabaseSync {
  file = next
  mkdirSync(dirname(next), { recursive: true })
  const conn = new DatabaseSync(next)

  // WAL：读写不互相阻塞。桌面应用边打字边存，这个比什么都重要
  conn.exec('pragma journal_mode = WAL')
  conn.exec('pragma synchronous = NORMAL')
  // 外键约束默认是关的，Entry.topic_id 的引用完整性要靠它
  conn.exec('pragma foreign_keys = ON')
  // 库被备份/同步工具占住时不要立刻抛错，等一会儿
  conn.exec('pragma busy_timeout = 5000')

  migrate(conn)
  db = conn
  return db
}

/** 按 user_version 逐步推进。每一步都放在一个事务里，失败就整体回退。 */
function migrate(conn: DatabaseSync): void {
  const current = Number(
    (conn.prepare('pragma user_version').get() as { user_version: number }).user_version
  )
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    conn.exec('begin')
    try {
      conn.exec(m.sql)
      // user_version 不接受绑参，只能拼进语句；值来自代码里的常量，不是外部输入
      conn.exec(`pragma user_version = ${m.version}`)
      conn.exec('commit')
      console.log(`[db] migrated to v${m.version} — ${m.name}`)
    } catch (err) {
      conn.exec('rollback')
      throw new Error(`迁移 v${m.version} (${m.name}) 失败: ${(err as Error).message}`)
    }
  }
}

export function getDatabase(): DatabaseSync {
  if (!db) throw new Error('数据库尚未打开')
  return db
}

/** 连接现在开着没。开屏之后那一段延后跑的活（备份、裁剪）用它判断「窗口已经关了，别跑」——
 *  它们跑在定时器里，赶不上就整个进程都要退了。 */
export function isOpen(): boolean {
  return db !== null
}

/** 当前库文件的路径（`userData` 那一侧，不是导出物）。备份与恢复都围着我转。 */
export function databaseFile(): string {
  if (!file) throw new Error('数据库尚未打开')
  return file
}

export function closeDatabase(): void {
  db?.close()
  db = null
}

/** node:sqlite 的事务不是包装函数，这里给一个最小的等价物。
 *  不支持嵌套——调用方自己保证不嵌套。 */
export function transact<T>(fn: () => T): T {
  const conn = getDatabase()
  conn.exec('begin')
  try {
    const out = fn()
    conn.exec('commit')
    return out
  } catch (err) {
    conn.exec('rollback')
    throw err
  }
}

/** node:sqlite 拒绝绑定 undefined 和普通对象，所有入参先过这一层 */
export type BindValue = string | number | null | Uint8Array | bigint
export function bindable(value: unknown): BindValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'object') return JSON.stringify(value)
  return value as BindValue
}

/** 行 → 领域对象的公共部分：snake_case 转 camelCase，props 解回对象 */
export function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export { DatabaseSync }