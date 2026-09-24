/** 导出器（期-08-设计 §一、§五）：整库 → Markdown 目录树 + front-matter。
 *
 *  两件事都故意做小：
 *  - **形状全在 `shared/exportFormat.ts`**（纯函数）。这一层只剩「读库、拼字符串、写文件」，
 *    因为形状一旦落在这里，「两次导出逐字节相同」就只能靠真写两遍盘去验。
 *  - **不碰 ProseMirror、不碰闸门**：`Entry.content` 本来就是 markdown 文本
 *    （`RichEditor.tsx:76` 存的就是 `editor.getMarkdown()`），导出的就是那串字。
 *
 *  红线：`plan()` 与 `run()` 都**只读库**。写盘唯一带破坏性的动作是覆盖同名文件，
 *  而那份内容库里都还有。 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { getDatabase } from './index'
import { list as listTopics } from './topics'
import { list as listSaved } from './savedQueries'
import { list as listTemplates } from './templates'
import {
  ASSET_DIR,
  EXPORT_VERSION,
  LIBRARY_DIR,
  LIBRARY_FILE,
  MANIFEST_FILE,
  depthOf,
  fileText,
  frontmatterFor,
  isReserved,
  libraryTopics,
  planPaths,
  rewriteAssets,
  type PathPlan,
} from '../../shared/exportFormat'
import type {
  Entry,
  EntryKind,
  EntryStatus,
  ExportPlan,
  ExportProgress,
  ExportResult,
  PropType,
} from '../../shared/types'

/** 库里的一行。列名跟着 SQLite 走，映射成 `Entry` 后才给 `exportFormat` 用。 */
interface Row {
  id: number
  kind: EntryKind
  title: string | null
  content: string
  entry_date: string
  created_at: string
  updated_at: string
  props: string
  topic_id: number | null
  status: EntryStatus
  promoted_at: string | null
}

function rows(): Entry[] {
  const list = getDatabase()
    .prepare(
      `select id, kind, title, content, entry_date, created_at, updated_at, props, topic_id, status, promoted_at
       from Entry where deleted_at is null order by id`
    )
    .all() as unknown as Row[]
  return list.map((r) => {
    let props: Record<string, unknown> = {}
    try {
      props = JSON.parse(r.props || '{}') as Record<string, unknown>
    } catch {
      props = {}
    }
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      content: r.content,
      entryDate: r.entry_date,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      props,
      topicId: r.topic_id,
      status: r.status,
      deletedAt: null,
      promotedAt: r.promoted_at,
    }
  })
}

/** 属性名的导出顺序：登记表的 ordinal，没登记的（只出现在 props 里）排最后按名字。
 *  与属性面板看到的是同一份判据（`main/db/props.ts` 的 `keys()`）。 */
function propOrder(): Map<string, number> {
  const t = getDatabase()
    .prepare('select name, ordinal from PropKey order by ordinal, name')
    .all() as unknown as { name: string; ordinal: number }[]
  return new Map(t.map((r, i) => [r.name, i]))
}

function propTypes(): Record<string, string> {
  const t = getDatabase()
    .prepare('select name, type from PropKey order by ordinal, name')
    .all() as unknown as { name: string; type: PropType }[]
  return Object.fromEntries(t.map((r) => [r.name, r.type]))
}

function attachmentsDir(): string {
  return join(app.getPath('userData'), 'attachments')
}

const ASSET_IN_TEXT = /kestrel-asset:\/\/([^\s)"']+)/g

function bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

/** 一次导出要读三遍库（plan、run 里各一次）——量下来 719 篇不到 5ms，不值得为此加缓存。 */
function survey(dir: string) {
  const list = rows()
  const topics = listTopics()
  const byId = new Map(topics.map((t) => [t.id, t.name]))
  const plans = planPaths(list, (id) => (id === null || id === undefined ? null : (byId.get(id) ?? null)))
  const order = propOrder()
  const names = new Map<number, string[]>()
  const reserved: { entryId: number; name: string }[] = []
  for (const e of list) {
    const own = Object.keys(e.props).sort(
      (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b, 'zh-Hans')
    )
    names.set(e.id, own)
    for (const n of own) if (isReserved(n)) reserved.push({ entryId: e.id, name: n })
  }
  const referenced = new Set<string>()
  let external = 0
  for (const e of list) {
    for (const m of e.content.matchAll(ASSET_IN_TEXT)) referenced.add(m[1])
    external += (e.content.match(/!\[[^\]]*\]\(https?:\/\/[^)]*\)/g) ?? []).length
  }
  const onDisk = new Set(existsSync(attachmentsDir()) ? readdirSync(attachmentsDir()) : [])
  let missing = 0
  for (const name of referenced) if (!onDisk.has(name)) missing++
  const planBy = new Map<number, PathPlan>()
  for (const p of plans) planBy.set(p.entryId, p)
  return { list, topics, byId, planBy, names, reserved, referenced, external, onDisk, missing, dir }
}

/** 只数不写：界面先给人看「要写 719 篇 + 3 个附件，约 0.4 MB，2 篇会改名」，再让人点确认。 */
export function plan(dir: string): ExportPlan {
  const s = survey(dir)
  return {
    dir: s.dir,
    entries: s.list.length,
    diary: s.list.filter((e) => e.kind === 'diary').length,
    articles: s.list.filter((e) => e.kind === 'article').length,
    files: s.list.length + [...s.referenced].filter((n) => s.onDisk.has(n)).length + 2,
    bytes: s.list.reduce((t, e) => t + bytes(e.content), 0),
    renamed: [...s.planBy.values()]
      .filter((p) => p.note)
      .map((p) => ({ entryId: p.entryId, path: p.path, note: p.note ?? '' })),
    reserved: s.reserved,
    assets: { referenced: s.referenced.size, onDisk: s.onDisk.size, missing: s.missing },
    external: s.external,
  }
}

let progress: ExportProgress = { running: false, done: 0, total: 0 }
let 要停 = false
export function getProgress(): ExportProgress {
  return progress
}
/** 界面那颗「中止」按的就是这个。生效点在最下面那处让出事件循环的地方，
 *  所以最迟下一次让出（200 篇、实测约 0.6 秒）就停得下来。 */
export function requestCancel(): void {
  要停 = true
}

/** 让出一次事件循环。6 万篇的库里这把主进程压成「一直在动」，窗口不至于像挂了。 */
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** 写出去。撞了 reserved 键直接抛——**不**自动加前缀、不悄悄丢。 */
export async function run(dir: string): Promise<ExportResult> {
  if (progress.running) throw new Error('上一次导出还没结束')
  const t0 = Date.now()
  const s = survey(dir)
  if (s.reserved.length > 0) {
    const 头 = s.reserved
      .slice(0, 3)
      .map((r) => `「${r.name}」（第 ${r.entryId} 篇）`)
      .join('、')
    throw new Error(`属性名与 Kestrel 自己的字段撞了：${头}。先给这个属性改个名再导出`)
  }

  progress = { running: true, done: 0, total: s.list.length }
  要停 = false
  try {
    mkdirSync(dir, { recursive: true })
    const adir = attachmentsDir()
    const 附件根 = join(dir, ASSET_DIR)
    const 有附件 = existsSync(adir)
    if (有附件 && [...s.referenced].some((n) => s.onDisk.has(n))) mkdirSync(附件根, { recursive: true })

    let written = 0
    let out = 0
    let assets = 0
    let 中止在 = -1
    // 同一个月份目录会被几千次 `mkdirSync` 重复调，实测那是 6 万篇里第二大的一块开销。
    // 记一下建过哪些，第二次起跳过——递归 mkdir 对已存在的目录也是白跑一趟
    const 建过 = new Set<string>()
    for (const e of s.list) {
      const p = s.planBy.get(e.id)
      if (!p) continue
      const depth = depthOf(p.path)
      const fm = frontmatterFor(
        e,
        e.topicId === null ? null : (s.byId.get(e.topicId) ?? null),
        s.names.get(e.id) ?? []
      )
      const text = fileText(fm, rewriteAssets(e.content, depth))
      const file = join(dir, ...p.path.split('/'))
      const 这一层的目录 = dirname(file)
      if (!建过.has(这一层的目录)) {
        mkdirSync(这一层的目录, { recursive: true })
        建过.add(这一层的目录)
      }
      writeFileSync(file, text, 'utf8')
      out += bytes(text)
      written++
      progress.done = written
      if (written % 200 === 0) {
        await yieldToLoop()
        if (要停) {
          中止在 = written
          break
        }
      }
    }
    if (中止在 >= 0) {
      // 中止了就**不写** library 与 MANIFEST：那两份是「这一导完整」的凭据，
      // 半截目录配一份说 58809 篇的清单，比不写更坏
      return { dir, written, bytes: out, renamed: 0, assets: 0, ms: Date.now() - t0, aborted: true }
    }

    // 附件只拷**被引用到**的那些：没被任何正文引用的文件不该混进「我的笔记」里
    for (const name of [...s.referenced].sort()) {
      const from = join(adir, name)
      if (!s.onDisk.has(name) || !existsSync(from)) continue
      copyFileSync(from, join(附件根, name))
      out += statSync(from).size
      assets++
    }

    mkdirSync(join(dir, LIBRARY_DIR), { recursive: true })
    const library = {
      version: EXPORT_VERSION,
      app: 'Kestrel',
      exportedAt: new Date().toISOString(),
      topics: libraryTopics(s.topics),
      savedQueries: listSaved().map((q) => ({ name: q.name, body: q.body, view: q.view, createdAt: q.createdAt })),
      templates: listTemplates().map((t) => ({ name: t.name, scope: t.scope, body: t.body, isDefault: t.isDefault })),
    }
    writeFileSync(join(dir, ...LIBRARY_FILE.split('/')), JSON.stringify(library, null, 1) + '\n', 'utf8')
    const manifest = {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      entries: s.list.length,
      files: written,
      attachments: assets,
      bytes: out,
      renamed: [...s.planBy.values()].filter((p) => p.note).map((p) => ({ entryId: p.entryId, path: p.path, note: p.note ?? '' })),
      skipped: { unusedAttachments: Math.max(0, s.onDisk.size - [...s.referenced].filter((n) => s.onDisk.has(n)).length) },
      propTypes: propTypes(),
    }
    writeFileSync(join(dir, ...MANIFEST_FILE.split('/')), JSON.stringify(manifest, null, 1) + '\n', 'utf8')

    return { dir, written, bytes: out, renamed: manifest.renamed.length, assets, ms: Date.now() - t0, aborted: false }
  } finally {
    progress = { running: false, done: progress.done, total: progress.total }
  }
}
