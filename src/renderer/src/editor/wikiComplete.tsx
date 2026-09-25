/** `[[` 补全（期-05b）：打两个方括号就出候选，选一个就落成一个真链接节点。
 *
 *  为什么又走「ProseMirror 插件 + 一层薄 React 浮层」而不是引 `@tiptap/suggestion`：
 *  与斜杠菜单同一条理由（`SlashMenu.tsx` 头上那段）——离线是产品红线，不为一个菜单新增依赖链，
 *  而这件事需要的也只有"打开一个浮层、逐字过滤、↑↓/Enter/Esc 选一条插进去"。
 *  浮层的坐标计算、翻页、翻不到下方就翻到上方，全部照 `SlashPopup` 那一套，视觉直接复用 `.slash-*` 类：
 *  **两个都是"打字打出来的菜单"，长得不一样才是问题。**
 *
 *  候选三族（`scratch/p05b-pre.mjs` 量的）：主题名 / 带标题的记录 / **日期**。
 *  日期这一族**不是从库里枚举出来的**——那份 5001 篇的合成库里带标题的是 0 篇，
 *  枚举日期只会把 321 KB 塞过 IPC；它由查询本身生成（`今天`/`昨天` 这类相对词 + 打全了的数字日期），
 *  落进正文的也就是那一串字，认不认得到交给解析器（它本来就认日期，且悬空会被 `claimForEntry` 回头认领）。
 *
 *  与斜杠菜单故意不同的两处：
 *  1. **Esc 不删正文**。那边删掉 `/query` 是因为那一截本来就是给菜单用的；这边的 `[[拼音` 是用户打的字，
 *     删它是毁内容。
 *  2. **输入法组合态一概不接管**（`isComposing` / keyCode 229）。中文标题是 IME 打的，
 *     候选窗开着时那一声 Enter 是"选字"，不是"选补全项"——吞掉的后果比没有补全更糟。
 *     全仓 `grep isComposing` 在加这一档之前是 0 个命中，斜杠菜单只是触发面窄侥幸没炸（登记成 #153）。 */

import { useEffect, useState, type JSX } from 'react'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { matchScore } from '@/fuzzy'
import { useStore } from '@/store'
import { resolveDateRef } from '../../../shared/links'
import { todayKey } from '../../../shared/date'
import { wikiAttrs } from './markdown'
import { 换嵌入补全 } from './embed'
import type { Candidate } from '../../../shared/types'

interface 项 {
  /** 选中之后落在 `[[ ]]>` 里的那一串字 */
  name: string
  /** 行右侧那一点补充：是哪一种、以及日期族解出来的绝对日期 */
  hint: string
  /** 分组顺序：主题 → 记录 → 日期（与解析顺序无关，纯粹是"谁更像一个名字"） */
  组: 0 | 1 | 2
}

/** `resolveDateRef` 的词汇表（`shared/links.ts:32`），一处列两遍必然会漂，所以照抄那七个 */
const 相对词 = ['今天', '今日', '昨天', '昨日', '前天', '明天', '后天', '去年今天', '今年的今天']

/** 每一次弹层开起来都重取一份，**不做进程级缓存**（与 11b 决策 93 同族）：新建与改名下一趟就看得见。
 *  代价量过：5000 篇那一份库上一次全量取数 12–15ms（含 3024 行过 IPC），第一次弹层从打字到画出一行 14ms。
 *  一次取数还在路上时不重复发（`在取`），所以连打两次 `[[` 只有一趟往返，晚到的那一份喂给后一次弹层。 */
let 名录: Candidate[] = []
let 还有 = 0
let 在取 = false
let 序号 = 0

interface MenuState {
  active: boolean
  /** `[[` 那一截的区间 */
  from: number
  to: number
  query: string
  cursor: number
  /** 名录到第几版了：到货之后靠它重算一次列表 */
  版: number
}

const CLOSED: MenuState = { active: false, from: -1, to: -1, query: '', cursor: 0, 版: -1 }
const key = new PluginKey<MenuState>('kestrel-wiki-complete')

/** 名录到货之后要有人喊一声：apply 是纯函数不能自己发事务，到货发生在 promise 里。
 *  一个 Set 而不是一个变量：**标签页（期-09a）之后编辑器实例不止一棵**，
 *  单变量的话最后挂载的那一棵（可能是阅读实例）会抢走这一声，另一棵就永远等不到重算。 */
const 敲门们 = new Set<() => void>()

function 取名录(): void {
  if (在取) return
  在取 = true
  void window.kestrel.links
    .candidates()
    .then((r) => {
      名录 = r.名录
      还有 = r.还有
      序号++
    })
    .catch(() => {
      名录 = []
      还有 = 0
    })
    .finally(() => {
      在取 = false
      for (const 敲 of [...敲门们]) 敲()
    })
}

/** 查询本身像不像一个日期：`2026-09-25`、`2026/9/25` 都算，缺日的（`2026-09`）不算——
 *  补全不许替人编一天出来。 */
const 数字日期 = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/

function 那一个日期(q: string): string | null {
  const m = 数字日期.exec(q)
  if (!m) return null
  const [年, 月, 日] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (月 < 1 || 月 > 12 || 日 < 1 || 日 > 31) return null
  const 串 = `${年}-${String(月).padStart(2, '0')}-${String(日).padStart(2, '0')}`
  const d = new Date(`${串}T00:00:00Z`)
  return d.getUTCMonth() + 1 === 月 && d.getUTCDate() === 日 ? 串 : null
}

function 列出(query: string): 项[] {
  const q = query.trim()
  const 出: 项[] = []

  // 日期族：打全了的日期排最前，其次相对词（空查询时只给三个，别把名单挤满）
  const 打全 = 那一个日期(q)
  if (打全) 出.push({ name: 打全, hint: '那一天', 组: 2 })
  const 起头 = useStore.getState().entry?.entryDate ?? todayKey()
  let 给的相对 = 0
  for (const w of 相对词) {
    if (q && matchScore(w, q) === null) continue
    if (!q && 给的相对 >= 3) continue
    const 绝 = resolveDateRef(w, 起头)
    if (!绝) continue
    给的相对++
    出.push({ name: w, hint: 绝, 组: 2 })
  }

  for (const c of 名录) 出.push({ name: c.name, hint: c.hint, 组: c.kind === 'topic' ? 0 : 1 })

  if (!q) return 出.slice(0, 20)

  const 中: { 项: 项; at: number; score: number }[] = []
  出.forEach((item, at) => {
    const score = matchScore(`${item.name} ${item.hint}`, q)
    if (score !== null) 中.push({ 项: item, at, score })
  })
  // 排序规则与命令面板一致（`Palette.tsx` 那一段）：分组顺序 → 命中分 → 原顺序。
  // 同一个词在 Ctrl+K、Ctrl+O、`/`、`[[` 四个地方排出来的顺序必须一样，否则用户学到的是"看地方"
  const 秩 = new Map<number, number>()
  for (const h of 中) if (!秩.has(h.项.组)) 秩.set(h.项.组, 秩.size)
  return 中
    .sort((a, b) => (秩.get(a.项.组) ?? 0) - (秩.get(b.项.组) ?? 0) || a.score - b.score || a.at - b.at)
    .slice(0, 20)
    .map((h) => h.项)
}

export interface WikiSnapshot {
  x: number
  y: number
  cursor: number
  items: 项[]
  /** 名录被上限截掉了几条：截断要说出来，不能让人以为"库里没有这个名字" */
  还有: number
  pick: (index: number) => void
}

let listener: ((snap: WikiSnapshot | null) => void) | null = null

export function subscribeWiki(fn: (snap: WikiSnapshot | null) => void): () => void {
  listener = fn
  return () => {
    if (listener === fn) listener = null
  }
}

function readState(state: EditorState): MenuState {
  return key.getState(state) ?? CLOSED
}

function 插入(view: EditorView, s: MenuState, 项: 项): void {
  // 先给嵌入一次机会：`![[qu` 打了一半就选了项，落的就该是嵌入（#167）。
  // 不给这一句的话，屏幕上留下的是「一个 `!` 加一条链接」——它的 Markdown 写法确实是 `![[x]]`，
  // 于是重载之后变成一张卡、重载之前不是：**同一篇文档前后两副样子**，正是这一档要避免的那种
  if (换嵌入(view, s, 项)) return
  const attrs = wikiAttrs(`[[${项.name}]]`)
  const 结 = attrs ? view.state.schema.nodes.wikiLink?.create(attrs) : null
  if (!结) return
  // 只换掉 `[[query` 那一截，光标后面已有的字一个字都不碰；补全自己不写正文
  view.dispatch(view.state.tr.replaceWith(s.from, s.to, 结).scrollIntoView())
}

/** `![[` 起头且那一整行除它之外没有别的字 ⇒ 整行换成一棵嵌入。
 *  判"整行"这把尺与 `embed.ts` 的 `一行嵌` 是同一条：行首只许 ≤3 个空格、行尾只许空白。
 *  行里还有别的字（`先看 ![[玻` 打到一半）那一种在 Markdown 里本来就不是嵌入，不换 */
function 换嵌入(view: EditorView, s: MenuState, 项: 项): boolean {
  const st = view.state
  const 叹 = s.from - 1
  if (叹 < 0 || !st.schema.nodes.embed) return false
  if (st.doc.textBetween(叹, s.from, '\uFFFC', ' ') !== '!') return false
  const $从 = st.doc.resolve(s.from)
  if ($从.depth < 1) return false
  const 头 = st.doc.textBetween($从.start($从.depth), 叹, '\uFFFC', ' ')
  const 尾 = st.doc.textBetween(s.to, $从.end($从.depth), '\uFFFC', ' ')
  if (!/^ {0,3}$/.test(头) || !/^[ \t]*$/.test(尾)) return false
  return 换嵌入补全(view, 叹, `${头}![[${项.name}]]${尾}`)
}

export const WikiComplete = Extension.create({
  name: 'wikiComplete',

  addProseMirrorPlugins() {
    return [
      new Plugin<MenuState>({
        key,
        state: {
          init: () => CLOSED,
          apply(tr: Transaction, value: MenuState, _old: EditorState, next: EditorState): MenuState {
            const meta = tr.getMeta(key) as { close?: boolean; cursor?: number; 开?: boolean } | undefined
            if (meta?.close) return CLOSED

            const sel = next.selection
            if (!sel.empty) return CLOSED
            const $h = next.doc.resolve(sel.head)
            // 代码块里不弹：那一段是要照原样存进正文的字（与斜杠菜单同一条例外）
            if ($h.parent.type.spec.code) return CLOSED
            const before = next.doc.textBetween($h.start(), sel.head, '￼', ' ')
            const m = /\[\[([^[\]\n]*)$/.exec(before)
            if (!m) return CLOSED

            const query = m[1]
            const 版 = 序号
            const 新 = !value.active || value.query !== query
            let cursor = 新 ? 0 : value.cursor
            if (meta && typeof meta.cursor === 'number') cursor += meta.cursor
            return { active: true, from: sel.head - m[0].length, to: sel.head, query, cursor, 版 }
          },
        },
        view(view) {
          let last = ''
          let 开着 = false
          /** 这一棵视图有没有把快照报给那个**全局唯一**的 listener。收菜单时只由报过的那一棵去收：
           *  标签页之后编辑器不止一棵，阅读实例那句 `listener?.(null)` 会把别人正开着的弹层一起关掉
           *  （与 `#136` 那条"单例换注册表"是同一族，先在这一档把互相踩住的那条路堵掉） */
          let 我报过 = false
          /** 名录到货时发一记空事务，让 apply 与 push 重跑一遍（不然弹层停在空列表） */
          const 敲 = () => {
            if (readState(view.state).active) view.dispatch(view.state.tr.setMeta(key, { 开: true }))
          }
          敲门们.add(敲)
          const 收 = (): void => {
            if (!我报过) return
            我报过 = false
            listener?.(null)
          }
          const push = (state: EditorState): void => {
            const s = readState(state)
            // 阅读实例复用的是同一棵 PM：不可编辑时保持沉默，绝不弹菜单
            if (!s.active || !view.editable) {
              开着 = false
              收()
              return
            }
            // 从关到开的那一记重取名录：这一档不做进程级缓存（头顶那段）
            if (!开着 || 名录.length === 0) 取名录()
            开着 = true
            const items = 列出(s.query)
            if (items.length === 0) {
              收()
              return
            }
            const cursor = Math.max(0, Math.min(s.cursor, items.length - 1))
            const c = view.coordsAtPos(s.to)
            const snap: WikiSnapshot = {
              x: c.left,
              y: c.bottom,
              cursor,
              items,
              还有,
              pick: (index) => {
                const cur = readState(view.state)
                const list = 列出(cur.query)
                const item = list[index]
                if (item) 插入(view, cur, item)
              },
            }
            const 签 = `${cursor}|${s.query}|${items.length}|${还有}|${Math.round(c.left)},${Math.round(c.bottom)}`
            if (签 !== last) {
              last = 签
              我报过 = true
              listener?.(snap)
            }
          }
          return {
            update: () => push(view.state),
            destroy: () => {
              敲门们.delete(敲)
              last = ''
              收()
            },
          }
        },
        props: {
          handleKeyDown(view, event) {
            const s = readState(view.state)
            if (!s.active || !view.editable) return false
            // 输入法正在组合：这一声键是给候选字的，一个字都不许吞（见文件头第 2 条）
            if (event.isComposing || event.keyCode === 229) return false
            const items = 列出(s.query)
            if (items.length === 0) return false

            if (event.key === 'ArrowDown') {
              view.dispatch(view.state.tr.setMeta(key, { cursor: 1 }))
              return true
            }
            if (event.key === 'ArrowUp') {
              view.dispatch(view.state.tr.setMeta(key, { cursor: -1 }))
              return true
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              const item = items[Math.min(s.cursor, items.length - 1)] ?? items[0]
              if (item) 插入(view, s, item)
              return true
            }
            if (event.key === 'Escape') {
              // 只关窗：那半截 `[[` 与已经打下的字原样留着
              view.dispatch(view.state.tr.setMeta(key, { close: true }))
              return true
            }
            return false
          },
        },
      }),
    ]
  },
})

const ROW = 30
const MENU_W = 300

/** 浮层：只读插件 publish 出来的那一份快照，自己不做任何选区计算（与 `SlashPopup` 同一条分工） */
export function WikiCompletePopup(): JSX.Element | null {
  const [snap, setSnap] = useState<WikiSnapshot | null>(null)
  useEffect(() => subscribeWiki(setSnap), [])
  if (!snap || snap.items.length === 0) return null

  const 可见 = Math.min(snap.items.length, 9)
  const h = 可见 * ROW + (snap.还有 > 0 ? 20 : 0) + 12
  const flip = snap.y + h + 8 > window.innerHeight
  const top = Math.max(8, flip ? snap.y - h - 6 : snap.y + 6)
  const left = Math.min(Math.max(8, snap.x), Math.max(8, window.innerWidth - MENU_W - 8))

  return (
    <div className="slash-menu" role="listbox" aria-label="双链补全" style={{ top, left, width: MENU_W }}>
      {snap.items.map((item, i) => (
        <button
          key={`${item.组}-${item.name}-${i}`}
          role="option"
          aria-selected={i === snap.cursor}
          className={`slash-row ${i === snap.cursor ? 'on' : ''}`}
          // 焦点绝不能从编辑器抢走：抢了 ProseMirror 会收回选区，那一截 `[[` 就没了落点
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => snap.pick(i)}
        >
          <span className="slash-title">{item.name}</span>
          <span className="slash-hint">{item.hint}</span>
        </button>
      ))}
      {snap.还有 > 0 && <div className="slash-hint wc-more">另有 {snap.还有} 条名字没列进候选，接着打字把它筛出来</div>}
    </div>
  )
}
