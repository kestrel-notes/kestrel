/** 主题层。期 1 只交付了「列出 + 新建」，这一层欠的 update / remove / reorder 在期 2 §3.5 还账。
 *
 *  三条只在主题这边才说清的事：
 *  1. **改名的两步必须同事务**（§2.3 末段）。只改 `Topic.name`，几十篇正文还写着 `[[旧名]]`；
 *     只改正文，那一串 `[[新名]]` 会全部变悬空。所以 `rename` 自己 begin，里面调
 *     `topicLinkPlans` + `bulkRewriteContent`——那两个都是无事务内核，事务归这里。
 *  2. **`color` 存 token 名而不是色值**：`'tag-3'`（不带 `--` 前缀），渲染成 `var(--tag-3)`。
 *     自由色值不可能在四个主题里都读得清，理由与 §5 给标签定的那条一模一样。
 *  3. **`Entry.topic_id` 的外键是 `on delete set null`**，所以删主题在数据库层面永远"成功"，
 *     文章只是静悄悄地没了归属。§3.5 那句"有文章时拦住"必须由代码来保证，不能指望约束。 */

import type { Topic, TopicPatch, TopicRenameResult } from '../../shared/types'
import * as entries from './entries'
import { bindable, getDatabase, transact, type BindValue } from './index'
import { claimForTopic } from './links'
import * as text from './text'

interface TopicRow {
  id: number
  name: string
  slug: string
  icon: string | null
  color: string | null
  parent_id: number | null
  sort_order: number
  description: string | null
  article_count: number
}

/** `articleCount` 不是表上的列，是读出来时顺带数的一列（回收站里的文章不算）。
 *  管理 sheet 那一行要说「下面还挂着 N 篇」，删除那道闸拦的也是它——两头都得当场有数。 */
const TOPIC_COLUMNS = `t.id, t.name, t.slug, t.icon, t.color, t.parent_id, t.sort_order, t.description,
  (select count(*) from Entry e where e.topic_id = t.id and e.deleted_at is null) as article_count`

function toTopic(r: TopicRow): Topic {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    icon: r.icon,
    color: r.color,
    parentId: r.parent_id,
    sortOrder: r.sort_order,
    description: r.description,
    articleCount: Number(r.article_count),
  }
}

function rowById(id: number): TopicRow | undefined {
  return getDatabase()
    .prepare(`select ${TOPIC_COLUMNS} from Topic t where t.id = ?`)
    .get(id) as unknown as TopicRow | undefined
}

export function list(): Topic[] {
  const rows = getDatabase()
    .prepare(`select ${TOPIC_COLUMNS} from Topic t order by t.sort_order, t.name`)
    .all() as unknown as TopicRow[]
  return rows.map(toTopic)
}

/** slug 只做身份标识，中文名原样保留——这个库是给中文写的，没必要硬塞拼音 */
function toSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

/** 名字不同但 slug 撞车是可能的（'A B' 与 'a-b'），加序号兜开，别让用户看见 UNIQUE 报错。
 *  `exceptId` 是改名时那一行自己：它的旧 slug 不算被占用。 */
function uniqueSlug(base: string, exceptId: number | null = null): string {
  let slug = base
  let n = 2
  while (getDatabase().prepare('select 1 from Topic where slug = ? and id is not ?').get(slug, exceptId)) {
    slug = `${base}-${n++}`
  }
  return slug
}

/** 名字的三条规矩，新建与改名共用一份判据。`exceptId` 是改名时那一行自己 */
function checkName(name: string, exceptId: number | null = null): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('主题名不能为空')
  if (trimmed.length > 40) throw new Error('主题名最多 40 个字符')
  const taken = getDatabase()
    .prepare('select 1 from Topic where name = ? and id is not ?')
    .get(trimmed, exceptId)
  if (taken) throw new Error(`已存在同名主题「${trimmed}」`)
  return trimmed
}

export function create(name: string): Topic {
  return transact(() => {
    const trimmed = checkName(name)
    const result = getDatabase()
      .prepare('insert into Topic(name, slug, sort_order) values(?, ?, 0)')
      .run(trimmed, bindable(uniqueSlug(toSlug(trimmed))))

    const id = Number(result.lastInsertRowid)
    // 正文里早就写着 [[这个主题]] 的话，这一下就把它连上了
    claimForTopic(id)

    return toTopic(rowById(id) as TopicRow)
  })
}

function get(id: number): Topic {
  const row = rowById(id)
  if (!row) throw new Error(`没有 id 为 ${id} 的主题`)
  return toTopic(row)
}

/* ─ 编辑（§3.5） ─ */

/** `Topic.color` 存的是 token 名（`'tag-1' … 'tag-8'`），不带 `--` 前缀 */
const COLOR_TOKEN = /^tag-[1-8]$/

/** 图标那格只收一个字符或一枚 emoji。ZWJ 组合的 emoji（`👨‍👩‍👧`）按 code point 数是 5 个字符，
 *  所以限到 8：宁可放过组合 emoji，也不给一整串文案挤进那一格。 */
function checkIcon(icon: string | null): string | null {
  if (icon === null) return null
  const trimmed = icon.trim()
  if (trimmed === '') return null
  if (Array.from(trimmed).length > 8 || /[\n\r\t]/.test(trimmed))
    throw new Error('图标只能是一个字符或一枚 emoji')
  return trimmed
}

/** 归档的三条边界：不能自己当自己的父级、只能一层、父级得真的存在。
 *  「一层」是 §8-D3 那条精神的延伸——侧栏与主题格都只按一层画，两层以上没有地方摆。 */
function checkParent(id: number, parentId: number | null): number | null {
  if (parentId === null) return null
  if (parentId === id) throw new Error('不能把主题归档到它自己下面')
  const parent = getDatabase()
    .prepare('select id, name, parent_id from Topic where id = ?')
    .get(parentId) as { id: number; name: string; parent_id: number | null } | undefined
  if (!parent) throw new Error('没有那个父主题')
  if (parent.parent_id === id) throw new Error(`「${parent.name}」本来就归档在它下面，绕成一个环了`)
  if (parent.parent_id !== null)
    throw new Error(`「${parent.name}」自己已经归在别下面了，只支持一层归档`)
  const kids = getDatabase()
    .prepare('select count(*) as n from Topic where parent_id = ?')
    .get(id) as { n: number }
  if (kids.n > 0) throw new Error('它下面已经归档了主题，再往上挂就变两层了')
  return parentId
}

/** 改图标 / 颜色 / 归档 / 排序。**名字不在这里改**——改名要连带搬正文里的 `[[旧名]]`，
 *  那是另一个通道（`rename`），混进 patch 里就等于给「只改一半」留了一条路。 */
export function update(id: number, patch: TopicPatch): Topic {
  const cur = get(id)
  const sets: string[] = []
  const args: BindValue[] = []

  if (patch.icon !== undefined) {
    sets.push('icon = ?')
    args.push(bindable(checkIcon(patch.icon)))
  }
  if (patch.color !== undefined) {
    if (patch.color !== null && !COLOR_TOKEN.test(patch.color))
      throw new Error('颜色只能从色板那 8 个里选')
    sets.push('color = ?')
    args.push(bindable(patch.color))
  }
  if (patch.parentId !== undefined) {
    sets.push('parent_id = ?')
    args.push(bindable(checkParent(id, patch.parentId)))
  }
  if (patch.sortOrder !== undefined) {
    if (!Number.isInteger(patch.sortOrder)) throw new Error('排序得是整数')
    sets.push('sort_order = ?')
    args.push(patch.sortOrder)
  }

  if (sets.length === 0) return cur
  args.push(id)
  getDatabase().prepare(`update Topic set ${sets.join(', ')} where id = ?`).run(...args)
  return get(id)
}

/** 改名。`rewriteLinks` 就是 §8-D4 那个勾选框：
 *  - 勾上 → 同一个事务里把全库正文的 `[[旧名]]` 改成 `[[新名]]`（每篇动手前先存一版历史，那是撤销）
 *  - 不勾 → 只改这一行，旧引用**降级成悬空**（`target_id` 清空、`target_raw` 留着旧名），
 *    所以它们会出现在悬空那一栏里而不是静悄悄消失（§10 第 12 项要的就是这个）。 */
export function rename(id: number, to: string, rewriteLinks: boolean): TopicRenameResult {
  const before = get(id)
  const trimmed = checkName(to, id)
  if (trimmed === before.name) return { entries: 0, hits: 0, claimed: 0 }

  // 干跑必须在动任何东西之前算：它数的是「正文里还写着旧名的地方」
  const impact = text.countTopicRename(before.name)

  return transact(() => {
    getDatabase()
      .prepare('update Topic set name = ?, slug = ? where id = ?')
      .run(trimmed, bindable(uniqueSlug(toSlug(trimmed), id)), id)

    let rewritten = 0
    if (rewriteLinks) {
      // 两个内核都不自己 begin：快照与重解析在 bulkRewriteContent 里层，事务边界在这一层
      rewritten = entries.bulkRewriteContent(text.topicLinkPlans(before.name, trimmed))
    } else {
      getDatabase()
        .prepare(
          `update Link set target_id = null, target_type = null
           where target_type = 'topic' and target_id = ?`
        )
        .run(id)
    }
    // 正文里可能早有一个悬空写着的 `[[新名]]`，这一下归它认领
    const claimed = claimForTopic(id)
    return { entries: rewritten, hits: impact.hits, claimed }
  })
}

/** 删除。有文章时先拦住（§3.5）：FK 是 `on delete set null`，不拦的话文章只是静悄悄没了归属。
 *  `detach` 是弹层给的那条出路：把文章的 `topic_id` 清空，主题删掉，内容一篇都不动。 */
export function remove(id: number, detach: boolean): void {
  const cur = get(id)
  if (cur.articleCount > 0 && !detach)
    throw new Error(`「${cur.name}」下面还有 ${cur.articleCount} 篇文章，先给它们找个去处`)

  transact(() => {
    const db = getDatabase()
    // 回收站里那些也一起清：它们哪天恢复出来不该指向一个已经不存在的主题
    db.prepare('update Entry set topic_id = null where topic_id = ?').run(id)
    // 收藏不留悬空行（§10 第 13 项）。正文里的 `[[这个名字]]` 反过来要留成悬空，看得见才修得了
    db.prepare(`delete from Bookmark where kind = 'topic' and ref = ?`).run(id)
    db.prepare(
      `update Link set target_id = null, target_type = null
       where target_type = 'topic' and target_id = ?`
    ).run(id)
    // 子主题靠 parent_id 的 `on delete set null` 回到顶层，不写 SQL 也是一种写
    db.prepare('delete from Topic where id = ?').run(id)
  })
}

/** 整表重排。列表只有几十个主题的量级，按数组下标写回 `sort_order` 比增量挪位省事。
 *  认不出的 id 跳过而不是报错：拖拽与删除并发时少一行是正常事。 */
export function reorder(orderedIds: number[]): void {
  transact(() => {
    const db = getDatabase()
    orderedIds.forEach((id, i) => {
      if (!Number.isInteger(id)) return
      db.prepare('update Topic set sort_order = ? where id = ?').run(i, id)
    })
  })
}