/** 未链接提及（期-05e §十三）：别处正文里**平写**着这一篇的名字或它的别名，而没写成 `[[…]]`。
 *
 *  为什么是**算出来的**而不是存进 `Link`：
 *  "你提到过但还没连"是用户**还没做的决定**，存进表里就等于替他做完了（`Link.kind` 里那个
 *  `mention` 从 v2 起一直空着，正是因为没人该写它）。同一族判断见 09c「分页是读时算出来的」。
 *
 *  为什么不用 Aho-Corasick、不做增量重建、不进保存路径：全量实测过
 *  （`scratch/p05e-pre.mjs` / `-pre2.mjs`）——3012 个名字 × 97 万字，手写 AC 26.2 ms、
 *  一个正则联合 1.2 ms、逐个 indexOf 1344.8 ms；而这一档的针根本不是全库名单，
 *  是"当前这一篇的标题 + 它的别名"这么几根，现算一次 12–19 ms。
 *  为 12 ms 维护一份常驻结构，就是给"什么时候该失效"再写一套状态机——那一套才是真代价。
 *
 *  两个不变量：
 *  1. **最左最长**：一条正文里那一串字只能连到一个目标。`主题 1` 与 `主题 10` 都在针里时，
 *     正文写 `主题 10` 只能算 `主题 10`（这也是 AC 不合用的第二个理由：它天生把所有能结束的模式全吐出来）。
 *  2. **「连上」只动那一处，且带条件**：`update ... where id = ? and updated_at = ?`。
 *     这一档改的是**另一篇**的正文，而 9a 之后那一篇很可能正开在另一个标签里；
 *     条件写不成就报出来，宁可让人重数一遍，也不覆盖别人正在打的字。 */

import { formatDateZh } from '../../shared/date'
import type { EntryKind, MentionHit, MentionLinkAsk, MentionLinkResult, MentionList } from '../../shared/types'
import { transact, getDatabase } from './index'
import { entryKey, reparseEntry } from './links'

/** 界面上一次列这么多。合成库里那种"一个名字被平写 800 次"的场合，全列出来等于没有 */
const 上限 = 20

/** 正则的字面量转义（针是用户起的名字，里面什么都有） */
function 转义(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 正文里需要屏蔽的区间：已有的 `[[…]]`（那些是连上了的，不是提及）与 ` ``` ` 围栏（卡上不演代码，
 *  代码与 mermaid 里出现的那个词更不是"你提到过它"） */
function 屏蔽区间(文: string): [number, number][] {
  const 段: [number, number][] = []
  const 链 = /\[\[[^[\]\n]*\]\]/g
  let m
  while ((m = 链.exec(文))) 段.push([m.index, m.index + m[0].length])
  const 栏 = /```[\s\S]*?(?:```|$)/g
  while ((m = 栏.exec(文))) 段.push([m.index, m.index + m[0].length])
  return 段
}
const 撞上 = (段: [number, number][], 位: number, 长: number): boolean =>
  段.some(([a, b]) => 位 < b && 位 + 长 > a)

const 是字母数字 = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c)
const 纯字母数字 = (s: string): boolean => /^[A-Za-z0-9\s\-_.]+$/.test(s)

/** 这一篇"在屏幕上会被怎么写出来"的那几串字：文章标题 / 日记的日期键 + 绑在这一篇上的别名。
 *
 *  日记只用日期键本身（`[[2024-07-07]]` 那种写法）：`2024 年 7 月 7 日` 这一种自然语言写法
 *  要不要算提及，取决于解析器认不认它——而它不认（`shared/links.ts` 那几档相对词与 ISO 日期）。
 *  列出来却连不上，比不列更坏。 */
function 针们(entryId: number): { 串: string; 经: MentionHit['经'] }[] {
  const db = getDatabase()
  const 我 = db
    .prepare('select kind, title, entry_date from Entry where id = ? and deleted_at is null')
    .get(entryId) as unknown as { kind: EntryKind; title: string | null; entry_date: string } | undefined
  if (!我) return []
  const 出: { 串: string; 经: MentionHit['经'] }[] = []
  const 加 = (串: string | null | undefined, 经: MentionHit['经']): void => {
    const s = String(串 ?? '').trim()
    if (s && !出.some((r) => r.串 === s)) 出.push({ 串: s, 经 })
  }
  if (我.kind === 'article') 加(我.title, 'title')
  else 加(我.entry_date, 'date')
  for (const r of db
    .prepare(`select name from Alias where target_type = 'entry' and target_id = ?`)
    .all(entryId) as unknown as { name: string }[])
    加(r.name, 'alias')
  // 最左最长：长的那一根排在前面，正则联合按排序取第一个能匹配的分支
  return 出.sort((a, b) => b.串.length - a.串.length)
}

/** 那一行怎么截给界面看：去掉行首空白与引用符，命中的起点跟着挪同样多 */
function 那一行(文: string, 绝对位: number): { 行: string; 行内位: number } {
  const 起 = 文.lastIndexOf('\n', 绝对位 - 1) + 1
  const 找 = 文.indexOf('\n', 绝对位)
  const 尾 = 找 === -1 ? 文.length : 找
  const 原 = 文.slice(起, 尾)
  const 头 = /^[\s>]+/.exec(原)?.[0].length ?? 0
  return { 行: 原.slice(头).replace(/\s+$/, ''), 行内位: 绝对位 - 起 - 头 }
}

/** 大小写归一。链接解析那一路本来就不区分大小写（`lower(replace(name,' ',''))`，
 *  别名表那条唯一索引同一个写法），提及这边要是区分，就会出现：
 *  正文里平写 `windows 计划` 不报，而同一串字套上 `[[ ]]` 当场就能连上——
 *  同一句话在两套判断里一个认一个不认，比两边都严更糟。
 *  空格那一截**没有**跟着归一（见 §14.4 记下的账），理由与代价都写在那儿。 */
const 归一 = (s: string): string => s.toLowerCase()

/** 别处平写着这几个词的那几处。当前这一篇自己不算（自指不是提及） */
export function mentionsOf(entryId: number): MentionList {
  const db = getDatabase()
  const 针 = 针们(entryId)
  if (!针.length) return { 针: [], 命中: [], 还有: 0, ms: 0 }
  const 联合 = new RegExp(
    针.map((r) => 转义(r.串)).join('|'),
    'gi'
  )
  // 命中回来的那串字是**屏幕上那一串**（大小写跟着正文走），所以经的查表也要按归一键走。
  // 长的针排在前面，同一条归一键只认第一次落进来的——与正则取分支的顺序是同一条规矩
  const 经of = new Map<string, MentionHit['经']>()
  for (const r of 针) if (!经of.has(归一(r.串))) 经of.set(归一(r.串), r.经)
  const 行们 = db
    .prepare(
      `select id, kind, title, entry_date, content, updated_at from Entry
       where deleted_at is null and id <> ? order by entry_date desc, id desc`
    )
    .all(entryId) as unknown as {
    id: number
    kind: EntryKind
    title: string | null
    entry_date: string
    content: string
    updated_at: string
  }[]

  const t0 = process.hrtime.bigint()
  const 命中: MentionHit[] = []
  let 还有 = 0
  for (const r of 行们) {
    const 文 = String(r.content ?? '')
    if (!文) continue
    const 段 = 屏蔽区间(文)
    联合.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = 联合.exec(文))) {
      const 串 = m[0]
      const 位 = m.index
      if (撞上(段, 位, 串.length)) continue
      // 纯 ASCII 的名字要求词边界：`ai` 撞进 `email` 那种，那份 5001 篇的库里占了 3120 处。
      // 中文**不加**这一条：汉字之间本来没有分隔，硬加了会把「磨过一片玻璃」里的 `玻璃` 挡掉
      if (纯字母数字(串) && (是字母数字(文[位 - 1]) || 是字母数字(文[位 + 串.length]))) continue
      if (命中.length >= 上限) {
        还有++
        continue
      }
      const { 行, 行内位 } = 那一行(文, 位)
      命中.push({
        id: r.id,
        点: entryKey(r.id),
        名字: r.title || (r.kind === 'diary' ? formatDateZh(r.entry_date) : '未命名文章'),
        种类: r.kind,
        日期: r.entry_date,
        串,
        经: 经of.get(归一(串)) ?? 'title',
        行,
        行内位,
        绝对位: 位,
        那一刻: r.updated_at,
      })
    }
  }
  return { 针: 针.map((r) => ({ 串: r.串, 经: r.经 })), 命中, 还有, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10 }
}

/** 把某一处平写的名字套上 `[[ ]]`。
 *
 *  写的是**屏幕上那一串字**本身：别名 `玻璃` 被平写 ⇒ 落成 `[[玻璃]]` 而不是 `[[毛玻璃工艺]]`——
 *  正文改动最小，而解析器（5c 那一层兜底）本来就认它。判据把这条钉住。
 *
 *  整件事在一个事务里：核 `updated_at`、核那一串字还在不在原位、写、重解析出链。
 *  应用层只有一条语句的位置可错，条件写就是最后一道。 */
export function linkMention(问: MentionLinkAsk): MentionLinkResult {
  return transact(() => {
    const db = getDatabase()
    const 在 = db
      .prepare('select content, updated_at from Entry where id = ? and deleted_at is null')
      .get(问.id) as unknown as { content: string; updated_at: string } | undefined
    if (!在) return { ok: false, 原因: '那一篇不在了' }
    if (在.updated_at !== 问.那一刻)
      return { ok: false, 原因: '那一篇在这期间被人改过，没动它——这一列先重数一遍' }
    const 文 = String(在.content ?? '')
    if (文.slice(问.绝对位, 问.绝对位 + 问.串.length) !== 问.串)
      return { ok: false, 原因: '那一处已经不原来那个位置上了，这一列先重数一遍' }
    const 变成 = `[[${问.串}]]`
    const 新 = 文.slice(0, 问.绝对位) + 变成 + 文.slice(问.绝对位 + 问.串.length)
    const 改 = db
      .prepare('update Entry set content = ?, updated_at = ? where id = ? and updated_at = ?')
      .run(新, new Date().toISOString(), 问.id, 问.那一刻)
    if (!Number(改.changes)) return { ok: false, 原因: '就在写这一瞬它又变了，没动它' }
    reparseEntry(问.id)
    return { ok: true, 变成 }
  })
}
