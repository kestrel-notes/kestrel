/** 模板变量展开（期-07 §五）。纯函数：给一个时刻，回一段文本。
 *
 *  为什么展开在渲染层而不在主进程：变量以"哪一天"为准是**用户当下正在写的那一篇**的
 *  日期，不是墙上时钟——补写上周的日记时 `{{date}}` 该是上周那天。这个上下文只有
 *  编辑器知道。
 *
 *  为什么不引 dayjs / moment：要认的标记一共 13 个，一张表 + 一个 replace 就写完了
 *  （实测见 `scratch/p7-cost.mjs` P4，八种日常写法全对）。多一个依赖多一份审计面，
 *  而这里没有时区、没有加减、没有本地化回退——库的能力用不上十分之一。 */

export const WEEKDAY_LONG = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
export const WEEKDAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
export const MONTH_LONG = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']

/** 认这些标记。顺序要紧：`MMMM` 得排在 `MMM` 与 `MM` 前，`dddd` 排在 `ddd` 前，
 *  否则长的会被短的吃掉一半（`dddd` → 「四d」就是这么来的）。 */
const MARKERS: [RegExp, (d: Date) => string][] = [
  [/YYYY/, (d) => String(d.getFullYear())],
  [/YY/, (d) => pad(d.getFullYear() % 100)],
  [/MMMM/, (d) => MONTH_LONG[d.getMonth()]],
  [/MMM/, (d) => `${d.getMonth() + 1}月`],
  [/MM/, (d) => pad(d.getMonth() + 1)],
  [/M(?!m)/, (d) => String(d.getMonth() + 1)],
  [/DD/, (d) => pad(d.getDate())],
  [/D(?!o)/, (d) => String(d.getDate())],
  [/dddd/, (d) => WEEKDAY_LONG[d.getDay()]],
  [/ddd/, (d) => WEEKDAY_SHORT[d.getDay()]],
  [/HH/, (d) => pad(d.getHours())],
  [/(^|[^H])mm/, (d) => pad(d.getMinutes())],
  [/(^|[^m])ss/, (d) => pad(d.getSeconds())],
]

/** `Do`（带序数后缀的日）**不在名单里**：中文没有 1st/2nd 这套，硬造一个「24日」
 *  等于把英文语料的形状搬过来。但它会漏半截——`D` 先被吃掉，剩下一个孤零零的 `o`
 *  （实测：`MMMM Do` → 「九月 24o」）。所以名单外的字母串要被原样抓出来进
 *  `unknownMarkers`，由界面念给用户，而不是让用户对着一句怪话猜。 */

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 按标记表格式化一个时刻 */
export function formatWhen(d: Date, pattern: string): { text: string; unknown: string[] } {
  const unknown: string[] = []
  let out = ''
  let i = 0
  /** 连续"没有任何标记认领"的拉丁字母。`Do` 就是这么被抓出来的：`D` 后面挨着 `o`，
   *  那条 `(?!o)` 不让它匹配，于是这两个字母谁都不认——原样吐进正文就是「九月 Do」。 */
  let stray = ''
  const flush = (): void => {
    if (stray && !unknown.includes(stray)) unknown.push(stray)
    stray = ''
  }
  outer: while (i < pattern.length) {
    for (const [re, fn] of MARKERS) {
      const m = re.exec(pattern.slice(i))
      if (m && m.index === 0) {
        flush()
        // mm/ss 那两条带了个"前不挨着"的捕获组，命中时要把它原样吐回去
        out += (m[1] ?? '') + fn(d)
        i += m[0].length
        continue outer
      }
    }
    out += pattern[i]
    if (/[A-Za-z]/.test(pattern[i])) stray += pattern[i]
    else flush()
    i++
  }
  flush()
  return { text: out, unknown }
}

export interface TemplateContext {
  /** 以哪一天为准：正在写的这一篇的 entry_date，不是墙上今天 */
  date: Date
  /** `{{last_entry}}`：上一篇日记。null = 这是第一篇 */
  lastEntry?: { title: string | null; entryDate: string } | null
  mood?: string
  topic?: string
}

export interface Expanded {
  text: string
  /** 没认出来的 `{{…}}` 整体，例如 `['prev_date']` */
  unknownVars: string[]
  /** 认出了变量但没给值，例如填了空主题的 `{{topic}}` */
  missing: string[]
  /** 变量内部没认出来的日期标记，例如 `['Do']` */
  unknownMarkers: string[]
}

/** 变量名的形状：字母打头，后面是单词字符。
 *
 *  **冒号不放进名字里**——原来写成 `[a-zA-Z_][\w:-]*`，于是 `{{date:YYYY 年 M 月 D 日}}`
 *  被切成「名字 = `date:YYYY`、参数 = `年 M 月 D 日`」，整条落到"不认识的变量"那一支，
 *  原文一字不改地留在正文里（实机验收第 7 项撞出来的：标题那行没展开）。
 *  名字与参数之间两种写法都认：`{{date:…}}` 与 `{{date …}}`。 */
const VAR = /\{\{\s*([a-zA-Z_]\w*)(?:[:\s]\s*([^{}]*?))?\s*\}\}/g

/** 把模板正文里的 `{{…}}` 换成实际内容。
 *
 *  **不认识的变量原样留着**并回报：用户手一抖写成 `{{prev_date}}`，把它吃掉等于
 *  把模板里的一个字没告诉他的改动落进正文。留 + 报，才是能改回去的那种失败。 */
export function expandTemplate(body: string, ctx: TemplateContext): Expanded {
  const unknownVars: string[] = []
  const missing: string[] = []
  const unknownMarkers: string[] = []
  const d = ctx.date

  const text = String(body ?? '').replace(VAR, (whole, rawName: string, rawArg: string | undefined) => {
    const name = rawName.toLowerCase()
    const arg = (rawArg ?? '').trim()
    const when = (pattern: string, fallback: string): string => {
      const got = formatWhen(d, pattern || fallback)
      for (const u of got.unknown) if (!unknownMarkers.includes(u)) unknownMarkers.push(u)
      return got.text
    }

    switch (name) {
      case 'date':
        return when(arg, 'YYYY-MM-DD')
      case 'time':
        return when(arg, 'HH:mm')
      case 'weekday':
        return WEEKDAY_LONG[d.getDay()]
      case 'mood':
        if (!ctx.mood) {
          missing.push('mood')
          return whole
        }
        return ctx.mood
      case 'topic':
        if (!ctx.topic) {
          missing.push('topic')
          return whole
        }
        return ctx.topic
      case 'last_entry': {
        if (!ctx.lastEntry) {
          missing.push('last_entry')
          return ''
        }
        // 只插链接，不嵌摘要（用户 2026-09-24 拍板）：摘要要在插入那一刻跑一次全文压缩，
        // 而"接着写"要的只是那一个跳转点
        const t = ctx.lastEntry
        return `[[${t.title ?? t.entryDate}]]`
      }
      case 'title':
        // 标题由外层填（新建弹层里那一栏），模板这一层没有它，留着并报告
        missing.push('title')
        return whole
      default:
        unknownVars.push(rawName)
        return whole
    }
  })

  return { text, unknownVars, missing, unknownMarkers }
}

/** 模板里用到了哪些变量。给管理界面那一行「含 {{date}}、{{topic}}」的灰字，
 *  也让"套用前先问 mood/topic"这件事知道该不该问 */
export function varsIn(body: string): string[] {
  const out: string[] = []
  for (const m of String(body ?? '').matchAll(VAR)) {
    const n = String(m[1]).toLowerCase()
    if (!out.includes(n)) out.push(n)
  }
  return out
}
