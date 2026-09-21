/** 属性层：类型定义、属性名的规矩、值的规范化与校验。
 *
 *  与 `tags.ts` 是**反着走**的两条路（期-02-设计 §2.1）：标签的真相源在正文，
 *  属性的真相源在 `Entry.props` 这一列。所以这里没有解析器，只有类型系统——
 *  「`mood` 是文本还是数字」是全局绑定（`PropKey` 表），值本身是一篇一篇存的。
 *
 *  校验函数放 shared 而不是 main，是因为两边都要用：主进程在写入门口**严格**拦
 *  （§4.4），渲染层在输入框上**宽松**地提前提示同一个理由。一份判据，两处消费。 */

import type { PropConversion, PropType } from './types'

export const PROP_TYPES: readonly PropType[] = [
  'text',
  'list',
  'number',
  'checkbox',
  'date',
  'datetime',
]

/** 给人看的类型名。报错信息、面板里的 select 都用它，别再各写一份。 */
export const PROP_TYPE_LABEL: Record<PropType, string> = {
  text: '文本',
  list: '列表',
  number: '数字',
  checkbox: '勾选',
  date: '日期',
  datetime: '日期时间',
}

export function isPropType(value: unknown): value is PropType {
  return typeof value === 'string' && (PROP_TYPES as readonly string[]).includes(value)
}

/** 落库形态：text / date / datetime 是 string，number 是 number，checkbox 是 boolean，
 *  list 是 string[]。空值不落库（见 normalizePropValue 的 'empty'）。 */
export type PropValue = string | number | boolean | string[]

/* ── 属性名 ── */

/** 名字会拼进 JSON path（`$.名字`），所以禁掉 path 的元字符与控制字符；
 *  其余照收——中文名、空格、`#`、`/` 都不是问题，属性名不像标签那样要能从正文里扫出来。 */
const BAD_KEY_CHAR = /[."\\\u0000-\u001f\u007f]/

/** 去首尾空白后的合法名字；不合法返回 null。 */
export function normalizePropKey(raw: string): string | null {
  const name = raw.trim()
  if (!name || name.length > 32) return null
  return BAD_KEY_CHAR.test(name) ? null : name
}

export function isPropKeyName(raw: string): boolean {
  return normalizePropKey(raw) !== null
}

/** JSON path。名字过不了 `normalizePropKey` 就别用它——path 是拼出来的。 */
export function propPath(name: string): string {
  return `$.${name}`
}

/* ── 值 ── */

/** `ok` = 落库值；`empty` = 视同没填（删键，不留 `''` / `[]`，也不留 `null`——
 *  「没有这个属性」与「这个属性的值是空」在属性视图的「未填」分组和第 8 期的
 *  frontmatter 导出上会读出两种结果，§3.2 为此定的是**去掉这个 key**）；
 *  `bad` = 拦下来，`reason` 直接进状态栏那条 `.err`。 */
export type PropValueCheck =
  | { status: 'ok'; value: PropValue }
  | { status: 'empty' }
  | { status: 'bad'; reason: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/
const NUMERIC_STRING_RE = /^-?\d+(\.\d+)?$/

/** 日历上真有这一天吗。`Date.parse` 会容忍 `2026-02-30`（滚到 3 月 2 日），
 *  所以格式过了还得回读一次年月日。 */
function isRealDate(text: string): boolean {
  const parts = text.split('-').map(Number)
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
  return (
    !Number.isNaN(d.getTime()) &&
    d.getUTCFullYear() === parts[0] &&
    d.getUTCMonth() === parts[1] - 1 &&
    d.getUTCDate() === parts[2]
  )
}

/** 单个值按类型过一遍，顺带**规范化**（`2026-02-30` 这种假日期一律拦掉，
 *  半截输入 `2026-0` 也拦——但渲染层输入框不拦它，见 §4.4 的分工）。
 *
 *  对导入数据留了两处宽容：数字类型接受 `'42'` 这样的纯数字串、列表类型接受裸字符串
 *  （当成一项）。这两处都是「明摆着是同一个值，只是写法不同」，
 *  而 `'abc'` 塞进 number 那种就是真不合规——拦下来，别猜。 */
export function normalizePropValue(type: PropType, value: unknown): PropValueCheck {
  switch (type) {
    case 'text': {
      if (typeof value === 'string') {
        const text = value.trim()
        return text ? { status: 'ok', value: text } : { status: 'empty' }
      }
      // 文本是最宽的落点：把 mood 从数字改回文本，不该有任何值因此被丢
      if (typeof value === 'number' || typeof value === 'boolean') {
        return { status: 'ok', value: String(value) }
      }
      return { status: 'bad', reason: '要填文本' }
    }

    case 'number': {
      if (typeof value === 'string') {
        if (!NUMERIC_STRING_RE.test(value.trim())) return { status: 'bad', reason: '要填数字' }
        value = Number(value.trim())
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { status: 'bad', reason: '要填数字' }
      }
      return { status: 'ok', value }
    }

    case 'checkbox': {
      if (typeof value === 'boolean') return { status: 'ok', value }
      // JSON 里没有独立的布尔，导入路径上 0/1 就是它俩
      if (value === 0 || value === 1) return { status: 'ok', value: value === 1 }
      return { status: 'bad', reason: '勾选框只能是勾上或没勾' }
    }

    case 'date': {
      if (typeof value !== 'string' || !DATE_RE.test(value)) {
        return { status: 'bad', reason: '要填日期（2026-09-21 这样）' }
      }
      return isRealDate(value)
        ? { status: 'ok', value }
        : { status: 'bad', reason: '这个日期不存在' }
    }

    case 'datetime': {
      if (typeof value !== 'string') return { status: 'bad', reason: '要填日期时间' }
      const m = DATETIME_RE.exec(value)
      if (!m || !isRealDate(m[1]) || Number(m[2].slice(0, 2)) > 23) {
        return { status: 'bad', reason: '要填日期时间（2026-09-21T08:30 这样）' }
      }
      // 统一存 T 分隔、到分钟——`datetime-local` 给的就是这个形状，别留两种写法
      return { status: 'ok', value: `${m[1]}T${m[2]}` }
    }

    case 'list': {
      // 与 text 同一条理由：改成列表不该丢掉任何值，所以裸值（字符串 / 数字 / 勾选）当成一项
      const items = Array.isArray(value)
        ? value
        : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? [typeof value === 'string' ? value : String(value)]
          : null
      if (!items) return { status: 'bad', reason: '要填若干条文本' }
      const out: string[] = []
      for (const item of items) {
        if (typeof item !== 'string') return { status: 'bad', reason: '列表的每一项都得是文本' }
        const text = item.trim()
        // 去重保序：chip 点两下同一个是重复，不是两个值
        if (text && !out.includes(text)) out.push(text)
      }
      return out.length ? { status: 'ok', value: out } : { status: 'empty' }
    }
  }
}

/** 整坨 props 过一遍。`typeOf` 由调用方给（主进程拿 `PropKey` 表，渲染层拿 store 里那份），
 *  shared 不碰数据库。返回的 `props` 是规范化后的，**写入要用它而不是入参**。 */
export function validateProps(
  props: Record<string, unknown>,
  typeOf: (name: string) => PropType
): { props: Record<string, PropValue>; errors: string[] } {
  const out: Record<string, PropValue> = {}
  const errors: string[] = []

  for (const [name, raw] of Object.entries(props)) {
    const check = normalizePropValue(typeOf(name), raw)
    if (check.status === 'ok') {
      // 键名也在校验范围内：path 是拼出来的，`a.b` 这种落库就回不来了
      const key = normalizePropKey(name)
      if (!key) errors.push(`${key ?? name}：属性名不能含 . " 或反斜杠`)
      else out[key] = check.value
      continue
    }
    if (check.status === 'empty') continue
    errors.push(`${name}：${check.reason}`)
  }

  return { props: out, errors }
}

/** 一次改类型的代价，dry-run 与正式执行共用（期-02-设计 §3.2 末段）。
 *  `samples` 是前三个不合规值的写法，弹层里给人看一眼就知道要不要取消。 */
export function reportConversion(
  values: unknown[],
  check: (value: unknown) => PropValueCheck
): PropConversion {
  const report: PropConversion = { convertible: 0, dropped: 0, samples: [] }
  for (const v of values) {
    if (check(v).status === 'bad') {
      report.dropped += 1
      if (report.samples.length < 3) report.samples.push(stringifyPropValue(v))
    } else {
      report.convertible += 1
    }
  }
  return report
}

/** 给人看的值写法（报错与 dry-run 用）。 */
export function stringifyPropValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return '（空）'
  if (typeof value === 'object') return JSON.stringify(value) ?? '（对象）'
  return String(value)
}

/* ── 数字分桶 ── */

/** 第二级里数字属性的桶宽（期-02-设计 §3.3「桶宽写死在查询里，别做配置」）。
 *  写成导出的常量而不是散进 SQL：标签与筛选必须同源，否则「10–19」这一组点进去
 *  会少掉边界值。 */
export const NUMBER_BUCKET = 10

/** `17` → `'10–19'`。负数桶 `-10–-1` 读着别扭，但个人库里的数字属性（评分、字数）
 *  极少为负，先不做两套标签。 */
export function numberBucket(value: number): string {
  const lo = Math.floor(value / NUMBER_BUCKET) * NUMBER_BUCKET
  return `${lo}–${lo + NUMBER_BUCKET - 1}`
}

/** 标签还原成 `[lo, hi)`。不认识的写法返回 null，调用方按「查无此组」处理。 */
export function numberBucketRange(label: string): { lo: number; hi: number } | null {
  const m = /^(-?\d+)–(-?\d+)$/.exec(label)
  if (!m) return null
  const lo = Number(m[1])
  const hi = Number(m[2]) + 1
  return hi - lo === NUMBER_BUCKET ? { lo, hi } : null
}

/** 一个落库值属于哪个分组。返回 null 表示这个值读不出来（类型对不上，
 *  多半是历史遗留或别的途径写的）——按「未填」那一组归它，比凭空造一组好。 */
export function propValueLabel(type: PropType, value: unknown): string | null {
  switch (type) {
    case 'text':
    case 'date':
    case 'datetime':
      return typeof value === 'string' && value ? value : null
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? numberBucket(n) : null
    }
    case 'checkbox':
      return value === true || value === 1 ? '是' : value === false || value === 0 ? '否' : null
    case 'list':
      // 列表在第二级按成员展开，走的是 propValueLabels（复数）
      return null
  }
}

/** 列表属性的每一项各自成组（一条有两个值就在两个组里各出现一次，§3.3）。
 *  非列表类型直接包一个元素，调用方不必分类型写两套循环。 */
export function propValueLabels(type: PropType, value: unknown): string[] {
  if (type === 'list') {
    if (!Array.isArray(value)) return []
    return value.filter((v): v is string => typeof v === 'string' && v !== '')
  }
  const label = propValueLabel(type, value)
  return label === null ? [] : [label]
}

/** 「未填」这一组的标签。渲染层与主进程都拿它比较，别写两份字面量。 */
export const PROP_UNFILLED = '（未填）'
