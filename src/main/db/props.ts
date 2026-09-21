/** 属性层的数据侧：`PropKey` 登记表 + 按值分组的三级查询 + 写入门口的类型校验。
 *
 *  三条与标签层不同的决定都在 `docs/期-02-设计.md` §2.1 / §4.3 定过，这里只写落地形态：
 *
 *  1. **值住在 `Entry.props`，类型住在 `PropKey`**。同名属性在所有条目同类型（照搬 Obsidian），
 *     所以「这篇的 mood 是文本、那篇是数字」是不被允许的库状态——改类型时要顺手把
 *     不合规的值丢掉，见 `keyPut`。
 *  2. **分组在 JS 里数，不在 SQL 里**。六类各自的分组规则（数字按桶、列表按成员、勾选是
 *     真/假/未填）与 `shared/props.ts` 的 `propValueLabels()` 是同一份判据；抄进 SQL 就等于
 *     同一个属性有两套「什么算同一个值」，早晚会漂。代价是全库扫一遍 `props`，
 *     量级预算在 §7 第 2 项（5000 条 < 150 ms），超了才考虑派生表。
 *  3. **补登记而不是报错**。`props` 里出现没登记过的 key（导入、别的途径写的）时按 `text`
 *     登记下来（§4.3），因为报错拦不住用户看自己的数据，而补登记是幂等的。 */

import {
  isPropType,
  normalizePropKey,
  normalizePropValue,
  numberBucketRange,
  propValueLabels,
  reportConversion,
  validateProps,
} from '../../shared/props'
import type { PropValue } from '../../shared/props'
import type {
  PropConversion,
  PropKeyInfo,
  PropType,
  PropValueBuckets,
  PropValueGroup,
} from '../../shared/types'
import { getDatabase, parseJsonObject, transact } from './index'
import * as revision from './revision'

/** 全库的 props，按日期倒序（第三级那个条目列表要的顺序）。
 *
 *  回收站里的不参与分组，与 `tags.ts:tree()` 同一条口径——删掉的东西还占着属性视图的
 *  一个分组，会让人以为筛选出了幽灵。 */
function scanEntries(): { id: number; props: Record<string, unknown> }[] {
  const rows = getDatabase()
    .prepare(
      'select id, props from Entry where deleted_at is null order by entry_date desc, updated_at desc'
    )
    .all() as unknown as { id: number; props: string }[]
  return rows.map((r) => ({ id: r.id, props: parseJsonObject(r.props) }))
}

/* ── 登记表 ── */

function typeMap(): Map<string, PropType> {
  const rows = getDatabase().prepare('select name, type from PropKey').all() as unknown as {
    name: string
    type: PropType
  }[]
  return new Map(rows.map((r) => [r.name, r.type] as const))
}

function nextOrdinal(): number {
  const row = getDatabase()
    .prepare('select coalesce(max(ordinal), -1) as m from PropKey')
    .get() as { m: number }
  return row.m + 1
}

/** 没登记过的名字按 `text` 补上（§4.3）。幂等，且**不开事务**——它跑在调用方的事务里
 *  （写入门口那条路径上 `applyUpdate` 已经 begin 过了，`transact` 不能嵌套）。 */
function ensureRegistered(names: Iterable<string>, known: Map<string, PropType>): void {
  const insert = getDatabase().prepare(
    'insert or ignore into PropKey(name, type, ordinal) values(?, ?, ?)'
  )
  // 懒取：这条函数在每次保存上都会被走到（validateForWrite），大多数时候没有任何新名字，
  // 不该为此多问一次 max(ordinal)
  let ordinal: number | null = null
  for (const raw of names) {
    const name = normalizePropKey(raw)
    if (!name || known.has(name)) continue
    if (ordinal === null) ordinal = nextOrdinal()
    insert.run(name, 'text', ordinal++)
    known.set(name, 'text')
  }
}

/** 侧栏第一级，也是面板里那个类型下拉的数据源。
 *  先补登记再读表，所以「导入进来、还没打开过」的属性同样出现在列表里，
 *  而不是只有编辑过的那篇看得见。 */
export function keys(): PropKeyInfo[] {
  return transact(() => {
    const known = typeMap()
    const found = new Map<string, Set<string>>()
    const seen = new Set<string>()

    for (const row of scanEntries()) {
      for (const [name, value] of Object.entries(row.props)) {
        seen.add(name)
        const labels = propValueLabels(known.get(name) ?? 'text', value)
        if (!labels.length) continue
        const set = found.get(name) ?? new Set<string>()
        for (const l of labels) set.add(l)
        found.set(name, set)
      }
    }

    ensureRegistered(seen, known)
    const rows = getDatabase()
      .prepare('select name, type, ordinal from PropKey order by ordinal, name')
      .all() as unknown as PropKeyInfo[]
    return rows.map((r) => ({ ...r, valueCount: found.get(r.name)?.size ?? 0 }))
  })
}

/** 添加属性，或**改类型**。
 *
 *  改类型顺带按新类型过一遍全库这个 key 的值，丢不下的删键（§3.2 末段）。
 *  登记表与值的改写必须在同一个事务里——改了一半、清了一半比失败更糟；
 *  动手前每篇存一份 `manual` 版本，这就是它的撤销（与标签重命名同一套，§2.3）。
 *
 *  「N 篇能转换 / M 篇会被丢」的确认在 UI 做，dry-run 走 `convertReport()`。 */
export function keyPut(rawName: string, type: PropType): void {
  const name = normalizePropKey(rawName)
  if (!name) throw new Error('属性名不能是空的，也不能含 . " 或反斜杠')
  if (!isPropType(type)) throw new Error(`不认识的属性类型：${String(type)}`)

  const current = typeMap().get(name)
  if (current === type) return

  transact(() => {
    if (current === undefined) {
      getDatabase()
        .prepare('insert into PropKey(name, type, ordinal) values(?, ?, ?)')
        .run(name, type, nextOrdinal())
      return
    }
    getDatabase().prepare('update PropKey set type = ? where name = ?').run(type, name)
    rewriteValues(name, type)
  })
}

/** 按新类型把这个 key 在全库的值过一遍：留得下的写规范化后的值，留不下的**删键**。
 *  值没变化的条目不动，也不留快照——否则改一次类型会给全库每篇都添一条历史。 */
function rewriteValues(name: string, type: PropType): void {
  const db = getDatabase()
  const write = db.prepare('update Entry set props = ?, updated_at = ? where id = ?')
  const ts = new Date().toISOString()

  for (const row of scanEntries()) {
    if (!(name in row.props)) continue
    const check = normalizePropValue(type, row.props[name])

    const next: Record<string, unknown> = { ...row.props }
    if (check.status === 'ok') next[name] = check.value
    else delete next[name]
    if (JSON.stringify(next) === JSON.stringify(row.props)) continue

    revision.snapshot(row.id, 'manual')
    write.run(JSON.stringify(next), ts, row.id)
  }
}

/** 改类型的 dry-run：面板那句「N 篇能转换 / M 篇会被丢，比如 …」。 */
export function convertReport(rawName: string, to: PropType): PropConversion {
  const name = normalizePropKey(rawName)
  if (!name || !isPropType(to)) return { convertible: 0, dropped: 0, samples: [] }

  const current = typeMap().get(name) ?? 'text'
  const values: unknown[] = []
  for (const row of scanEntries()) {
    const value = row.props[name]
    if (value === undefined) continue
    // 现在就已经是空的值不算「被丢」：它本来就该是删键，只是还没被写过
    if (normalizePropValue(current, value).status === 'empty') continue
    values.push(value)
  }
  return reportConversion(values, (v) => normalizePropValue(to, v))
}

/** 只动登记表与 `props` 里的键名，**不动正文**（§4.5：属性名与 `#tag` 不同源，
 *  改名不该跨库改文本）。目标名已存在时直接拒绝——两个类型不同的属性合成一个，
 *  得先决定谁的类型作数，那是另一件事，不塞在这里顺手做。 */
export function keyRename(from: string, rawTo: string): void {
  const to = normalizePropKey(rawTo)
  if (!to) throw new Error('属性名不能是空的，也不能含 . " 或反斜杠')
  if (to === from) return
  if (typeMap().has(to)) throw new Error(`已经有叫「${to}」的属性了`)

  const rows = scanEntries()
  // 撞名要连「值在 props 里、但还没登记过」那一种一起查，只看登记表会漏，
  // 漏了就等于把人家已有的同名值顶掉
  if (typeMap().has(to) || rows.some((r) => to in r.props)) {
    throw new Error(`已经有叫「${to}」的属性了`)
  }

  transact(() => {
    getDatabase().prepare('update PropKey set name = ? where name = ?').run(to, from)
    const write = getDatabase().prepare('update Entry set props = ?, updated_at = ? where id = ?')
    const ts = new Date().toISOString()

    for (const row of rows) {
      if (!(from in row.props)) continue
      const next: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row.props)) next[k === from ? to : k] = v
      write.run(JSON.stringify(next), ts, row.id)
    }
  })
}

/* ── 侧栏的第二、三级 ── */

/** 组的顺序按类型给，不是按计数：
 *  - 数字：桶天然升序（`-10–-1` 排最前），按计数排会把「0–9」和「100–109」挨在一起
 *  - 勾选：是 → 否 →（未填），读法与界面那个复选框一致
 *  - 其余：计数倒序（多的排前面），同数按值
 *  「未填」永远最后一条：它是兜底那一组，混进值里会被当成一个真实的空值。 */
function compareGroups(type: PropType): (a: PropValueGroup, b: PropValueGroup) => number {
  const byType = typeComparator(type)
  // 「未填」单独提到最前面比，而不是让类型那条规则去顺带排它：
  // 它带的计数可以高过任何真实值（多数条目压根没填），让「多的排前面」这条去管它就会把它顶到第一行；
  // 数字那一边更糟，`numberBucketRange('') → null → 0`，它会被塞到「0–9」旁边。
  // 两种都是注释里说的那件不该发生的事：兜底那一组被当成一个真实的空值来读。
  return (a, b) =>
    Number(a.value === null) - Number(b.value === null) || byType(a, b)
}

function typeComparator(type: PropType): (a: PropValueGroup, b: PropValueGroup) => number {
  if (type === 'number') {
    return (a, b) => (numberBucketRange(a.value ?? '')?.lo ?? 0) - (numberBucketRange(b.value ?? '')?.lo ?? 0)
  }
  if (type === 'checkbox') {
    const rank = { 是: 0, 否: 1 } as Record<string, number>
    return (a, b) => (rank[a.value ?? ''] ?? 2) - (rank[b.value ?? ''] ?? 2)
  }
  return (a, b) =>
    b.count - a.count || String(a.value).localeCompare(String(b.value), 'zh-Hans')
}

/** 第二级：值分组 + 计数，含「未填」那一组（§3.3：不然按 mood 分组看不到没写 mood 的那批，
 *  会让人以为筛选漏了）。 */
export function values(rawName: string): PropValueBuckets {
  const name = normalizePropKey(rawName)
  if (!name) throw new Error('不认识的属性名')
  const type = typeMap().get(name) ?? 'text'

  const counts = new Map<string, number>()
  let unfilled = 0
  for (const row of scanEntries()) {
    const labels = propValueLabels(type, row.props[name])
    if (!labels.length) {
      unfilled += 1
      continue
    }
    for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1)
  }

  const groups: PropValueGroup[] = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort(compareGroups(type))
  if (unfilled) groups.push({ value: null, count: unfilled })

  return { type, groups }
}

/** 第三级要的那批条目 id（日期倒序）。`value === null` 取「未填」那一组。
 *
 *  返回 id 而不是 EntrySummary：摘要的 `SUMMARY_SELECT` 归 `entries.ts` 所有，
 *  查询写在哪由返回类型决定（`listByTag` 那条分工一样）。 */
export function entryIds(rawName: string, value: string | null): number[] {
  const name = normalizePropKey(rawName)
  if (!name) return []
  const type = typeMap().get(name) ?? 'text'

  const ids: number[] = []
  for (const row of scanEntries()) {
    const labels = propValueLabels(type, row.props[name])
    if (value === null ? labels.length === 0 : labels.includes(value)) ids.push(row.id)
  }
  return ids
}

/* ── 写入门口 ── */

/** 保存前对 `Entry.props` 做**严格**校验（§4.4）。不合规就抛干净 message，
 *  它经 `handle()` 原样回到渲染层，落在状态栏那条 `.err` 上。
 *
 *  返回规范化后的 props，**调用方要写这一份而不是入参**：半截日期、`'42'` 这样的数字串、
 *  列表里的空项和重复项，都在这一趟落成唯一一种写法，读的人不必再防第二种。
 *
 *  与 `bulkRewriteContent` 同样的约束：自己不开事务，跑在 `applyUpdate` 的那一个里。 */
export function validateForWrite(props: Record<string, unknown>): Record<string, PropValue> {
  const known = typeMap()
  ensureRegistered(Object.keys(props), known)
  const { props: clean, errors } = validateProps(props, (name) => known.get(name) ?? 'text')

  if (errors.length) {
    const rest = errors.length - 3
    throw new Error(
      `属性没能保存：${errors.slice(0, 3).join('；')}${rest > 0 ? `；另有 ${rest} 处` : ''}`
    )
  }
  return clean
}

/** 恢复历史版本那一条路用的**宽松**版本：合不上的键丢掉，不抛。
 *
 *  为什么这里是两套判据（§4.4 定的是「写入门口必须严格」）：类型绑定是全局的，
 *  而历史版本是过去某一天的产物——用户先把 `mood` 从文本改成了数字，再去恢复上周那版
 *  「mood: 平静」。严格判据会让恢复整个失败，等于**属性类型挡住了回退这条安全绳**，
 *  而那正是期 1 花了一整个任务做出来、专门用来兜住误操作的东西。
 *  丢掉的那个值也还在 Revision 行里，改回文本再恢复一次就回来。 */
export function sanitizeForRestore(props: Record<string, unknown>): Record<string, PropValue> {
  const known = typeMap()
  ensureRegistered(Object.keys(props), known)
  // validateProps 本来就把不合规的值排除在返回值之外，errors 只是它顺手报出来的清单
  return validateProps(props, (name) => known.get(name) ?? 'text').props
}
