/** 反向导入器（期-08-设计 §三）：只认自家导出物，按 `kestrel-id` 认人。
 *
 *  三条硬规矩都写在这一层，界面上没有绕过它们的口子：
 *  1. **不猜**。包头里没有 `kestrel-id` 的文件不是 Kestrel 导出的，报一句就完事——
 *     不拿文件名当标题、不拿路径当日期、不猜 frontmatter 里哪个键是属性。
 *  2. **只增不改删**。导出物里没有的条目留着不动；拿一份去年的导出物导入不等于毁库。
 *  3. **覆盖之前先留一版**。库里已有同一个 id 且文件更新，才写；写之前手动快照，
 *     这样「导错了」是可回退的，不是不可逆的。
 *
 *  时间戳是**照原样写回**的（`created_at` / `updated_at` / `promoted_at`）。
 *  不这么做的话，恢复一次备份就等于把全库的「最近记录」刷成今天——那是两件不同的事。
 *
 *  红线：`plan()` 只读；`run()` 只写库，一个字都不往导出目录里写。 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { importAsset } from '../attachments'
import { getDatabase } from './index'
import * as entries from './entries'
import * as props from './props'
import * as savedQueries from './savedQueries'
import * as templates from './templates'
import * as topics from './topics'
import { ASSET_DIR, LIBRARY_DIR, MANIFEST_FILE, RESERVED } from '../../shared/exportFormat'
import { split, type FmValue } from '../../shared/frontmatter'
import { isPropType, normalizePropValue, type PropValue } from '../../shared/props'
import type {
  Entry,
  EntryKind,
  EntryStatus,
  ImportPlan,
  ImportProgress,
  ImportResult,
  PropType,
} from '../../shared/types'

const LF = String.fromCharCode(10)

interface Doc {
  /** 相对导出根的路径（斜杠分隔），报错时给人看的是这个 */
  rel: string
  /** 该文件到根的层数，认附件相对路径要用 */
  depth: number
  id: number
  kind: EntryKind
  title: string | null
  entryDate: string
  topic: string | null
  status: EntryStatus
  created: string | null
  updated: string | null
  promoted: string | null
  props: Record<string, FmValue>
  body: string
  /** 正文里指向 `attachments/` 的那些文件名 */
  assets: string[]
  /** 同一个 id 在这个目录里出现了第二次及以后：见 `survey()` 末尾那一段
   *  ——它按「原样不动」计，不进库 */
  重复?: boolean
}

interface Library {
  topics: {
    name: string
    parent: string | null
    icon: string | null
    color: string | null
    description: string | null
    sortOrder: number
  }[]
  savedQueries: { name: string; body: string; createdAt?: string }[]
  templates: { name: string; scope: string; body: string; isDefault: boolean | number }[]
  propTypes: Record<string, string>
}

function isKind(v: FmValue | undefined): v is EntryKind {
  return v === 'diary' || v === 'article'
}
function isStatus(v: FmValue | undefined): v is EntryStatus {
  return v === 'draft' || v === 'published'
}

/** 递归列目录。`_kestrel/` 与 `attachments/` 不进：前者是账，后者的字节直接读文件拿。 */
function mdFiles(root: string, rel = ''): string[] {
  const dir = rel === '' ? root : join(root, rel)
  const out: string[] = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const child = rel === '' ? name.name : rel + '/' + name.name
    if (name.isDirectory()) {
      if (name.name === ASSET_DIR || name.name === LIBRARY_DIR) continue
      out.push(...mdFiles(root, child))
      continue
    }
    if (name.name.toLowerCase().endsWith('.md')) out.push(child)
  }
  return out.sort()
}

function readLibrary(dir: string): Library {
  const empty: Library = { topics: [], savedQueries: [], templates: [], propTypes: {} }
  const p = join(dir, ...LIBRARY_DIR.split('/').slice(0, 1), 'library.json')
  const m = join(dir, ...MANIFEST_FILE.split('/'))
  let out = empty
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<Library>
    out = {
      ...empty,
      topics: Array.isArray(raw.topics) ? raw.topics : [],
      savedQueries: Array.isArray(raw.savedQueries) ? raw.savedQueries : [],
      templates: Array.isArray(raw.templates) ? raw.templates : [],
    }
  } catch {
    // 没有 library 也能导条目，只是主题元数据与两份列表要等 MANIFEST 那一侧
  }
  try {
    const man = JSON.parse(readFileSync(m, 'utf8')) as { propTypes?: Record<string, string> }
    if (man.propTypes && typeof man.propTypes === 'object') {
      out = { ...out, propTypes: man.propTypes as Record<string, string> }
    }
  } catch {
    // MANIFEST 是账，不是内容；读不到就用「按值猜类型」那一档
  }
  return out
}

/** 认不出来的、读不懂的，各归各的清单——都不算失败，失败是「一声不吭地丢了东西」。 */
function survey(dir: string) {
  const docs: Doc[] = []
  const foreign: string[] = []
  const errors: { file: string; why: string }[] = []
  const lib = readLibrary(dir)
  const 附件根 = join(dir, ASSET_DIR)
  const 有附件目录 = existsSync(附件根)

  for (const rel of mdFiles(dir)) {
    const depth = rel.split('/').length - 1
    let text: string
    try {
      text = readFileSync(join(dir, ...rel.split('/')), 'utf8')
    } catch (e) {
      errors.push({ file: rel, why: '读不到这个文件：' + (e as Error).message })
      continue
    }
    let data
    let body
    try {
      ;({ data, body } = split(text))
    } catch (e) {
      errors.push({ file: rel, why: '包头读不懂：' + (e as Error).message })
      continue
    }
    if (data === null || typeof data['kestrel-id'] !== 'number') {
      foreign.push(rel)
      continue
    }
    if (!isKind(data['kestrel-kind'])) {
      errors.push({ file: rel, why: 'kestrel-kind 既不是 diary 也不是 article' })
      continue
    }
    if (typeof data['kestrel-date'] !== 'string') {
      errors.push({ file: rel, why: '没有 kestrel-date，不知道归到哪天' })
      continue
    }
    // 导出补的那一个尾换行，这里削掉那一个（多一个都不削，见 §一·接缝 3）
    const 正文 = body.endsWith(LF) ? body.slice(0, -1) : body
    const 上跳 = '../'.repeat(depth) + ASSET_DIR + '/'
    const 名字: string[] = []
    for (const n of 附件名单(正文, 上跳)) {
      名字.push(n)
    }
    const propsOut: Record<string, FmValue> = {}
    for (const [k, v] of Object.entries(data)) {
      if (RESERVED.includes(k)) continue
      propsOut[k] = v as FmValue
    }
    docs.push({
      rel,
      depth,
      id: data['kestrel-id'],
      kind: data['kestrel-kind'],
      title: typeof data['kestrel-title'] === 'string' ? data['kestrel-title'] : null,
      entryDate: data['kestrel-date'],
      topic: typeof data['kestrel-topic'] === 'string' ? data['kestrel-topic'] : null,
      status: isStatus(data['kestrel-status']) ? data['kestrel-status'] : 'draft',
      created: typeof data['kestrel-created'] === 'string' ? data['kestrel-created'] : null,
      updated: typeof data['kestrel-updated'] === 'string' ? data['kestrel-updated'] : null,
      promoted: typeof data['kestrel-promoted'] === 'string' ? data['kestrel-promoted'] : null,
      props: propsOut,
      body: 正文,
      assets: 名字,
    })
  }
  docs.sort((a, b) => a.id - b.id)
  认重复(docs, errors)

  const 引用 = new Set<string>()
  let 在盘 = 0
  let 缺 = 0
  for (const d of docs) {
    for (const n of d.assets) {
      if (引用.has(n)) continue
      引用.add(n)
      if (有附件目录 && existsSync(join(附件根, n))) 在盘++
      else 缺++
    }
  }
  return { docs, foreign, errors, lib, 有附件目录, assets: { referenced: 引用.size, present: 在盘, missing: 缺 } }
}

/** 同一个 `kestrel-id` 在这个目录里出现了不止一次：只取较新的那一份，其余按
 *  「原样不动」计，一个字都不写。
 *
 *  为什么要在扫描这一步就办掉，而不是留给 `decide()`：`decide()` 比的是**库里**那一版，
 *  而重复的那一份要等前一份落库之后才看得见。实测把一份导出物复制二十遍去导入，
 *  计划页写着「导回 14300 篇」，真正写进库的只有 717 篇——那一行数字是用户按下确认
 *  之前唯一的依据，它不能靠运气（这一份恰好对上号）才对得上。
 *
 *  比的是 `kestrel-updated`（缺席就退回 `kestrel-created`，与 `文件更新()` 同一条规矩）；
 *  一模一样时留路径排在前面那一份，结果与文件系统的枚举顺序无关。 */
function 认重复(docs: Doc[], errors: { file: string; why: string }[]): void {
  const 时间 = (d: Doc): string => d.updated ?? d.created ?? ''
  const 代表 = new Map<number, Doc>()
  const 例子: string[] = []
  let 重复 = 0
  for (const d of docs) {
    const 先 = 代表.get(d.id)
    if (先 === undefined) {
      代表.set(d.id, d)
      continue
    }
    重复++
    let 留: Doc
    let 弃: Doc
    if (时间(先) < 时间(d)) {
      留 = d
      弃 = 先
      代表.set(d.id, d)
    } else {
      留 = 先
      弃 = d
    }
    弃.重复 = true
    if (例子.length < 5) 例子.push(`${弃.rel}（留 ${留.rel}）`)
  }
  if (重复 === 0) return
  // 一条说完，不逐文件列：一份复制了二十遍的导出物有一万三千条，逐条报会把
  // 「真正读不懂的那几个」挤出界面上那份清单
  errors.push({
    file: `同一个 id 出现了两次（${重复} 个文件）`,
    why: '一个目录里放了两份导出物，同一个 kestrel-id 只能落一篇，较旧的那些不写库：' + 例子.join('、'),
  })
}

/** 正文里指向导出目录 `attachments/` 的那些名字。
 *  只认**这一篇该长成的那一种写法**（层数算好的前缀 + 40 位十六进制 + 扩展名），
 *  别的路径里出现 `attachments/` 不算——那是用户自己的链接。 */
function 附件名单(text: string, 前缀: string): string[] {
  const out: string[] = []
  let at = 0
  for (;;) {
    const i = text.indexOf(前缀, at)
    if (i < 0) return out
    const 开 = i - 1
    if (text[开] !== '(') {
      at = i + 前缀.length
      continue
    }
    const end = text.indexOf(')', i + 前缀.length)
    if (end < 0) return out
    const name = text.slice(i + 前缀.length, end)
    if (像附件名(name)) out.push(name)
    at = end
  }
}

const HEX = '0123456789abcdefABCDEF'
/** `<40 位十六进制>.<2-5 位扩展名>`——内容寻址名就是这个形状，别的都不认 */
function 像附件名(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot !== 40) return false
  for (let i = 0; i < dot; i++) if (!HEX.includes(name[i])) return false
  const ext = name.slice(dot + 1)
  return ext.length >= 2 && ext.length <= 5 && /^[a-z0-9]+$/i.test(ext)
}

/** 该不该用文件覆盖库里那一篇：比 `updated`（没有就比 `created`），字符串比就行——
 *  两边都是同一个 `toISOString()` 产出的。相等也算不覆盖，那是「一模一样」。 */
function 文件更新(doc: Doc, db: { updatedAt: string; createdAt: string }): boolean {
  const 文件的时间 = doc.updated ?? doc.created ?? ''
  return 文件的时间 > db.updatedAt
}

/** 那一篇该落库成什么动作：新建 / 覆盖 / 原样不动。
 *
 *  `plan()` 与 `run()` 必须走这一个判定——界面上写「更新 0」点下去却改了 5 篇，
 *  那句计划就成了谎话，而它是用户按下确认前唯一的依据。
 *
 *  「不是明确更新」一律不动，包括**库里 id 对不上、但那天已有一篇日记**的情形：
 *  那多半是拿一份旧导出物往新库里导，让旧内容盖掉更新的那一份不是恢复，是毁数据。
 *  回收站里的条目同理——用户删掉的东西不该被一次导入复活。
 *  同一个 id 在这个目录里出现两次的那些也算这一档，见 `认重复()`。 */
function decide(d: Doc): { what: 'create' | 'update' | 'skip'; target: Entry | null } {
  if (d.重复 === true) return { what: 'skip', target: null }
  const 库里的 = entries.get(d.id)
  const 同日的 = d.kind === 'diary' ? entries.diaryOn(d.entryDate) : null
  const 目标 = 库里的 ?? 同日的
  if (目标 === null) return { what: 'create', target: null }
  if (目标.deletedAt !== null || !文件更新(d, 目标)) return { what: 'skip', target: 目标 }
  return { what: 'update', target: 目标 }
}

/** 只数不写：界面上要先给人看「新建 719 · 更新 0 · 跳过 0」再点确认。 */
export function plan(dir: string): ImportPlan {
  const s = survey(dir)
  const registered = new Map(props.keys().map((k) => [k.name, k.type]))
  const 已知主题 = new Set(topics.list().map((t) => t.name))
  let creates = 0
  let updates = 0
  let skips = 0
  const 新主题 = new Set<string>()
  const 新属性 = new Set<string>()
  for (const d of s.docs) {
    const what = decide(d).what
    if (what === 'create') creates++
    else if (what === 'update') updates++
    else skips++
    if (d.topic && !已知主题.has(d.topic)) 新主题.add(d.topic)
    for (const n of Object.keys(d.props)) if (!registered.has(n)) 新属性.add(n)
  }
  for (const t of s.lib.topics) if (!已知主题.has(t.name)) 新主题.add(t.name)
  // MANIFEST 里那份登记表也会被逐条登记，光报「正文里用到的那几个」会让界面上
  // 「登记 4 个新属性名」点下去变成 7 个——计划上写的数就是落库后的数，不多不少
  for (const [name, type] of Object.entries(s.lib.propTypes)) {
    if (!registered.has(name) && !RESERVED.includes(name) && isPropType(type)) 新属性.add(name)
  }
  if (s.docs.length === 0) {
    throw new Error(
      s.foreign.length > 0
        ? `这里没有一篇是 Kestrel 导出的（${s.foreign.length} 个 md 文件的包头里都没有 kestrel-id）`
        : '这个目录里没有 md 文件'
    )
  }
  return {
    dir,
    files: s.docs.length + s.foreign.length,
    ours: s.docs.length,
    foreign: s.foreign.length,
    foreignNames: s.foreign.slice(0, 6),
    creates,
    updates,
    skips,
    errors: s.errors.map((e) => `${e.file}：${e.why}`).slice(0, 20),
    errorCount: s.errors.length,
    assets: s.assets,
    newTopics: [...新主题].sort(),
    newPropKeys: [...新属性].sort(),
    library: {
      topics: s.lib.topics.length,
      savedQueries: s.lib.savedQueries.length,
      templates: s.lib.templates.length,
    },
  }
}

let progress: ImportProgress = { running: false, done: 0, total: 0 }
export function getProgress(): ImportProgress {
  return progress
}
export function requestCancel(): void {
  要停 = true
}
let 要停 = false

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** 猜类型只在 MANIFEST 没有 propTypes 那一列时用作兜底。
 *  认错的代价不对称：猜成 text 谁都装得下，猜成 number 会把后来的值挡掉，所以偏保守。 */
function 猜类型(v: FmValue): PropType {
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'checkbox'
  if (Array.isArray(v)) return 'list'
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) return 'date'
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}/.test(v)) return 'datetime'
  return 'text'
}

/** 落库。每一篇各走一遍既有的保存通道（重解析链接与标签、认领悬空引用），
 *  不是自己插表——正文是标签与双链的真相源，那条路不能绕。 */
export async function run(dir: string): Promise<ImportResult> {
  if (progress.running) throw new Error('上一次导入还没结束')
  const t0 = Date.now()
  const s = survey(dir)
  if (s.docs.length === 0) {
    throw new Error(
      s.foreign.length > 0
        ? `这里没有一篇是 Kestrel 导出的（${s.foreign.length} 个 md 文件的包头里都没有 kestrel-id）`
        : '这个目录里没有 md 文件'
    )
  }
  progress = { running: true, done: 0, total: s.docs.length }
  要停 = false
  const errors = s.errors.map((e) => `${e.file}：${e.why}`)

  const 登记 = new Map(props.keys().map((k) => [k.name, k.type]))
  const 主题表 = new Map(topics.list().map((t) => [t.name, t.id]))
  const 已存查询 = new Set(savedQueries.list().map((q) => q.name))
  const 已模板 = new Set(templates.list().map((t) => t.name))
  let created = 0
  let updated = 0
  let skipped = 0
  let assets = 0
  let newTopics = 0
  let newPropKeys = 0
  let 中止在 = -1

  // 附件的字节读一次就够（同一张图被 30 篇引用不该拷 30 次）
  const 附件缓存 = new Map<string, string>()
  async function 认附件(name: string): Promise<string | null> {
    const hit = 附件缓存.get(name)
    if (hit) return hit
    const from = join(dir, ASSET_DIR, name)
    if (!existsSync(from)) return null
    const wrote = await importAsset(name, new Uint8Array(readFileSync(from)))
    附件缓存.set(name, wrote)
    return wrote
  }

  try {
    // 先主题（library.json 里的父级排在前面，一轮挂不上就第二轮再挂）
    const 子 = s.lib.topics.filter((t) => t.parent !== null)
    for (const t of [...s.lib.topics.filter((t) => t.parent === null), ...子].sort(
      (a, b) => a.sortOrder - b.sortOrder
    )) {
      if (主题表.has(t.name)) continue
      if (t.description) {
        // `TopicPatch` 里压根没有 description 这一栏（界面上也没有地方填），
        // 导出物却带着它。今天必然是 null，但哪天有了内容就要在这里说清，
        // 不要等到有人对着「导出去又导回来」的库发现少了东西才来查
        errors.push(`主题「${t.name}」的说明（description）没带回来：那一栏现在没有写入的入口`)
      }
      try {
        const made = topics.create(t.name)
        主题表.set(t.name, made.id)
        newTopics++
        const 父 = t.parent === null ? null : 主题表.get(t.parent)
        const patch: Record<string, unknown> = {}
        if (t.icon) patch.icon = t.icon
        if (t.color) patch.color = t.color
        if (typeof t.sortOrder === 'number') patch.sortOrder = t.sortOrder
        if (父 !== undefined && 父 !== null) patch.parentId = 父
        if (Object.keys(patch).length) topics.update(made.id, patch)
      } catch (e) {
        errors.push(`主题「${t.name}」没建起来：${(e as Error).message}`)
      }
    }

    // 属性名：MANIFEST 里那份登记表优先，其次按值猜
    for (const [name, type] of Object.entries(s.lib.propTypes)) {
      if (登记.has(name) || RESERVED.includes(name) || !isPropType(type)) continue
      try {
        props.keyPut(name, type)
        登记.set(name, type)
        newPropKeys++
      } catch (e) {
        errors.push(`属性「${name}」没登记上：${(e as Error).message}`)
      }
    }
    for (const d of s.docs) {
      for (const [name, v] of Object.entries(d.props)) {
        if (登记.has(name)) continue
        const t = 猜类型(v)
        try {
          props.keyPut(name, t)
          登记.set(name, t)
          newPropKeys++
        } catch (e) {
          errors.push(`${d.rel}：属性「${name}」没登记上（${(e as Error).message}），这一篇的这个属性先丢了`)
        }
      }
    }

    for (const d of s.docs) {
      if (要停) {
        中止在 = d.id
        break
      }
      // 附件：相对路径 → 内容寻址名。库里没有的那个不动它（留成死链，和导出时一样）
      let content = d.body
      const 上跳 = '../'.repeat(d.depth) + ASSET_DIR + '/'
      for (const n of d.assets) {
        const wrote = await 认附件(n)
        if (wrote === null) {
          errors.push(`${d.rel}：附件 ${n} 不在导出物里，正文里那一处保持原样`)
          continue
        }
        content = content.split('(' + 上跳 + n + ')').join('(kestrel-asset://' + wrote + ')')
        assets++
      }

      const 取 = decide(d)
      if (取.what === 'skip') {
        skipped++
        progress.done++
        continue
      }
      const 目标 = 取.target
      if (目标 !== null) {
        // 覆盖之前先留一版：这一条 Revision 就是「导错了」的撤销路径
        entries.snapshotRevision(目标.id)
        const written = entries.update(目标.id, {
          content,
          title: d.kind === 'diary' ? null : (d.title ?? 目标.title),
          entryDate: d.entryDate,
          topicId: d.topic === null ? 目标.topicId : (主题表.get(d.topic) ?? 目标.topicId),
          status: d.status,
          props: 收敛属性(d, 目标.props, 登记, errors),
        })
        写回时间(written.id, d)
        updated++
      } else {
        let 新 =
          d.kind === 'diary'
            ? entries.ensureDiary(d.entryDate)
            : entries.create({ kind: 'article', title: d.title ?? '未命名文章', entryDate: d.entryDate })
        新 = entries.update(新.id, {
          content,
          title: d.title,
          entryDate: d.entryDate,
          topicId: d.topic === null ? null : (主题表.get(d.topic) ?? null),
          status: d.status,
          props: 收敛属性(d, {}, 登记, errors),
        })
        写回时间(新.id, d)
        created++
      }
      progress.done++
      if (progress.done % 100 === 0) await yieldToLoop()
    }

    // library.json 里那两份列表：按名字认人，重名不覆盖
    for (const q of s.lib.savedQueries) {
      if (已存查询.has(q.name)) continue
      try {
        const made = savedQueries.create(q.name, q.body)
        // 「这条查询是什么时候建的」是导出的元数据里带着的，侧栏那条列表按它排序；
        // 不写回去，恢复一次备份会把存查询的顺序顶到今天（与条目时间戳同一条规矩）
        if (typeof q.createdAt === 'string' && q.createdAt) {
          getDatabase()
            .prepare('update SavedQuery set created_at = ? where id = ?')
            .run(q.createdAt, made.id)
        }
      } catch (e) {
        errors.push(`存查询「${q.name}」没回来：${(e as Error).message}`)
      }
    }
    for (const t of s.lib.templates) {
      if (已模板.has(t.name)) continue
      try {
        templates.create({
          name: t.name,
          scope: t.scope === 'article' ? 'article' : 'diary',
          body: t.body,
          // 「哪一条是这一类的默认模板」是数据：不带回来的话，恢复一次之后
          // 「新建日记套谁」就悄悄变了（library.json 里本来有这个字段）
          isDefault: t.isDefault === true || t.isDefault === 1,
        })
      } catch (e) {
        errors.push(`模板「${t.name}」没回来：${(e as Error).message}`)
      }
    }

    return {
      dir,
      created,
      updated,
      skipped,
      assets,
      topics: newTopics,
      propKeys: newPropKeys,
      errors,
      ms: Date.now() - t0,
      aborted: 中止在 >= 0,
    }
  } finally {
    progress = { running: false, done: progress.done, total: progress.total }
  }
}

/** 属性逐个过登记表。合不上的**逐条报、不猜**，其余照写——
 *  一篇里一个坏属性不该让整篇进不了库。 */
function 收敛属性(
  d: Doc,
  现有: Record<string, unknown>,
  登记: Map<string, PropType>,
  errors: string[]
): Record<string, PropValue> {
  const out: Record<string, unknown> = { ...现有 }
  for (const [name, v] of Object.entries(d.props)) {
    const type = 登记.get(name)
    if (type === undefined) {
      errors.push(`${d.rel}：属性「${name}」没登记上，这个值先丢了`)
      continue
    }
    const check = normalizePropValue(type, v)
    if (check.status === 'ok') out[name] = check.value
    else if (check.status === 'empty') delete out[name]
    else errors.push(`${d.rel}：属性「${name}」的值 ${JSON.stringify(v)} 不合 ${type}（${check.reason}），先丢了`)
  }
  const clean: Record<string, PropValue> = {}
  for (const [k, v] of Object.entries(out)) if (v !== undefined && v !== null) clean[k] = v as PropValue
  return clean
}

/** 时间戳与升格标记照原样写回。`update` 一定会把 `updated_at` 刷成现在，
 *  所以这一刀只能在它后面补——恢复一次备份不该把全库的「最近记录」顶到今天，
 *  而 `promoted_at` 压根不在 `EntryPatch` 能写的列里（它是 `promote()` 的动作字段）。
 *
 *  `kestrel-updated` 缺席**不等于**「没有时间」：导出那一侧的规矩是
 *  「created 与 updated 相等就不写第二遍」（`exportFormat.ts:165`），所以这里要按同一条
 *  规矩反推回 `created`。不这么办，实测这份库里 130 篇「从没改过」的记录恢复一次就把
 *  「最近修改」顶到了导入那一刻。 */
function 写回时间(id: number, d: Doc): void {
  const 更 = d.updated ?? d.created
  const sets: string[] = []
  const values: unknown[] = []
  for (const [col, v] of [
    ['created_at', d.created],
    ['updated_at', 更],
    ['promoted_at', d.promoted],
  ] as [string, string | null][]) {
    if (v === null) continue
    sets.push(`${col} = ?`)
    values.push(v)
  }
  if (sets.length === 0) return
  values.push(id)
  getDatabase().prepare(`update Entry set ${sets.join(', ')} where id = ?`).run(...(values as never[]))
}
