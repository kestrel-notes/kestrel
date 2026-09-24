/** 导出物的形状：目录树、文件名、frontmatter 的组成、附件引用改写（期-08-设计 §一）。
 *
 *  这一层**纯函数**，不碰文件系统——「同一库两次导出必须逐字节相同」是验收第 7 项，
 *  把它做成不需要真写盘就能断言的东西，才有人会在改坏它的时候发现。
 *  洗名的每一条判据都来自实测（§〇.3）：NTFS 上 `Readme` 与 `readme` 是同一个文件、
 *  尾随的点与空格会被静默吃掉、`CON` 这类名字根本建不出来。 */

import type { Entry, Topic } from './types'
import { block, type Fm } from './frontmatter'

export const EXPORT_VERSION = 1
export const ASSET_DIR = 'attachments'
export const LIBRARY_DIR = '_kestrel'
export const LIBRARY_FILE = LIBRARY_DIR + '/library.json'
export const MANIFEST_FILE = LIBRARY_DIR + '/MANIFEST.json'

/** 属性铺在 frontmatter 顶层（口径 ①），所以 Kestrel 自己的字段要让位——撞上了**报错中止**，
 *  不自动加前缀、不悄悄丢：悄悄改名等于下次导入对不上。 */
export const RESERVED = [
  'kestrel-id',
  'kestrel-kind',
  'kestrel-date',
  'kestrel-topic',
  'kestrel-status',
  'kestrel-created',
  'kestrel-updated',
  'kestrel-promoted',
]

export function isReserved(name: string): boolean {
  return RESERVED.includes(name)
}

const ILLEGAL = '/\\:*?"<>|'
const RESERVED_WIN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/** 一个名字 → 能落盘的名字。
 *
 *  判据来自实测（`scratch/p8-namechk` 那一轮，2026-09-24）：Node 走长路径前缀，
 *  `aux`、`com1.log`、`尾随点.`、`尾随空格 ` 这些名字**建得出来**；换个程序按普通路径去读就
 *  「文件不存在」——.NET 读 `lpt9.txt` / `nul.md` / `com1.log` / 带尾随点空格的名字全部失败，
 *  只有 `con.txt` 那一次侥幸读到了。导出物是要给别人看的，所以按最严的那一档洗：
 *  尾随的点与空格吃掉、保留名（**连扩展名一起判**，`com1.log` 的保留段是 `com1`）前缀挡开。 */
export function safeName(raw: string, fallback = '未命名'): string {
  let name = ''
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0
    name += c < 0x20 || ILLEGAL.includes(ch) ? '·' : ch
  }
  name = name.replace(/[. ]+$/, '')
  name = name.replace(/^[.]+/, (m) => '·'.repeat(m.length))
  const dot = name.indexOf('.')
  if (RESERVED_WIN.test(dot < 0 ? name : name.slice(0, dot))) name = '_' + name
  if (name === '') name = fallback
  // 截断带上字节数：只截不断，撞车还有得判。用 TextEncoder 不用 Buffer——
  // 这个模块渲染层也要 import，那边没有 Buffer
  if (name.length > 80) {
    const bytes = new TextEncoder().encode(name).length
    name = name.slice(0, 60) + '·' + String(bytes).padStart(3, '0')
  }
  return name
}

/** 一篇条目在导出树里的位置（不含唯一化后缀）。
 *
 *  日期不是 `YYYY-MM-DD` 的那一种（手工改过库、将来导入进来的坏数据）单独放 `diary/其它/`：
 *  按 ISO 切出来的年月对它是空字符串，`join` 会静默把空的这一段丢掉，
 *  于是文件落在错的那一层、附件的相对路径也跟着少一层——错了还不报。 */
export function pathOf(entry: Entry, topicName: string | null): string {
  if (entry.kind === 'diary') {
    const d = entry.entryDate
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d)) {
      return ['diary', d.slice(0, 4), d.slice(5, 7), d + '.md'].join('/')
    }
    return ['diary', '其它', safeName(d, '无日期') + '.md'].join('/')
  }
  const dir = topicName === null || topicName === '' ? '无主题' : safeName(topicName, '无主题')
  return ['topics', dir, safeName(entry.title ?? '', '未命名') + '.md'].join('/')
}

export interface PathPlan {
  entryId: number
  /** 树里的位置，已经过唯一化（撞车的第二个起加 `·2`） */
  path: string
  /** 为什么被改名；没有被改过就是 null */
  note: string | null
}

/** 全库的路径规划。唯一化按**小写**判（NTFS / APFS 默认都不区分大小写，实测 C1 就是这么红的）。 */
export function planPaths(entries: Entry[], topicName: (id: number | null) => string | null): PathPlan[] {
  const used = new Map<string, string>()
  const plans: PathPlan[] = []
  for (const e of [...entries].sort((a, b) => a.id - b.id)) {
    const base = pathOf(e, topicName(e.topicId))
    const key = base.toLowerCase()
    if (!used.has(key)) {
      used.set(key, base)
      plans.push({ entryId: e.id, path: base, note: null })
      continue
    }
    const dot = base.lastIndexOf('.')
    let n = 2
    let alt = base.slice(0, dot) + '·' + n + base.slice(dot)
    while (used.has(alt.toLowerCase())) {
      n++
      alt = base.slice(0, dot) + '·' + n + base.slice(dot)
    }
    used.set(alt.toLowerCase(), alt)
    // 说明里点名**占了这个名字的那一篇**，不是自己那一份——用户要看的对子是「谁和谁撞了」
    plans.push({ entryId: e.id, path: alt, note: '与「' + used.get(key) + '」在大小写不敏感下同名，落成这一个' })
  }
  return plans
}

/** 该文件到导出根的层数：`topics/T/x.md` 是 2，`diary/2026/09/2026-09-16.md` 是 3。 */
export function depthOf(path: string): number {
  return path.split('/').length - 1
}

/** 该文件往上几层的 `../`。深度 0 返回空串：那时 `attachments/x.png` 就是对的写法，
 *  而 `./attachments/x.png` 与它会被当成两个不同的引用，同一个附件拷出两份。 */
export function relUp(depth: number): string {
  return '../'.repeat(depth)
}

/** `kestrel-asset://<名>` → 相对路径。附件名是 `<40 位十六进制>.<扩展名>`，
 *  不含需要百分号编码的字符，所以直接拼。 */
export function rewriteAssets(content: string, depth: number): string {
  const up = '../'.repeat(depth)
  return content.replace(/kestrel-asset:\/\/([^\s)"']+)/g, (_all, name: string) => up + ASSET_DIR + '/' + name)
}

/** 正文原样 + 恰好一个尾换行（§一·接缝 3：导入时削掉的也是这一个）。 */
export function fileText(fm: Fm, content: string): string {
  return block(fm) + content + '\n'
}

/** 一篇的 frontmatter。键序是定的：Kestrel 自己的在前、属性按登记顺序在后——
 *  「两次导出逐字节相同」要的就是这个顺序。 */
export function frontmatterFor(entry: Entry, topicName: string | null, propNames: string[]): Fm {
  const fm: Fm = {
    'kestrel-id': entry.id,
    'kestrel-kind': entry.kind,
    'kestrel-date': entry.entryDate,
  }
  // 主题归属对日记也一样是**数据**：实测这份库里 525 篇日记有 400 篇挂着 topic_id，
  // 只给文章写就等于把这一半关系丢掉（导入回来主题就不对了）
  if (topicName) fm['kestrel-topic'] = topicName
  fm['kestrel-status'] = entry.status
  fm['kestrel-created'] = entry.createdAt
  // 日记的 created 与 updated 常常相等，写两遍没信息（§一）
  if (entry.createdAt !== entry.updatedAt) fm['kestrel-updated'] = entry.updatedAt
  if (entry.promotedAt) fm['kestrel-promoted'] = entry.promotedAt
  for (const name of propNames) {
    const v = entry.props[name]
    if (v === undefined || v === null) continue // 空值是删键，不写 `k: ""`（shared/props.ts 那条）
    fm[name] = v as Fm[string]
  }
  return fm
}

/** 主题元数据进 `library.json`：名字、层级、颜色、图标、说明、顺序。
 *  主题**本身**不写进任何正文，所以它只能在这里有一份。 */
export function libraryTopics(topics: Topic[]): Record<string, unknown>[] {
  return topics
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .map((t) => ({
      name: t.name,
      parent: t.parentId === null ? null : (topics.find((p) => p.id === t.parentId)?.name ?? null),
      icon: t.icon,
      color: t.color,
      description: t.description,
      sortOrder: t.sortOrder,
    }))
}
