/** 查询块：正文里那截 ```query 围栏下面挂一块结果（期-07 §一）。
 *
 *  **结果不在树里**，这是整块设计最要紧的一条。期-07 §0.1 实测过：一张渲染出来的
 *  结果表如果被当成正文写进去，闸门**拦不住**（`table` 在 KNOWN_TAGS 名单里，
 *  raw HTML 被转义成文本之后两棵树仍然相等）。所以「结果不是内容」不能指望判据兜底，
 *  只能是实现事实——一个 widget 装饰器，从头到尾不在 ProseMirror 的文档里，
 *  序列化时看不见，md 里也就永远不会有它。
 *
 *  围栏本身今天就是无损的（同一批实测：```query 逐字往返、两次到不动点、
 *  嵌在 Callout 与列表里也不丢），所以 schema 一行不用改、闸门判据一行不用改。
 *  这也是它不进 `buildExtensions()` 的理由——那份名单是**闸门的 schema**，
 *  只改渲染不改树的东西（本文件、SlashMenu、Folding）都挂在 `RichEditor` 上。
 *
 *  两个坑值得写下来：
 *  1. **key 里不能带查询文本**。第一版把 code 拼进 `key`，于是每敲一个字装饰器就
 *     重建一次、每次重建都发一趟 IPC——防抖形同虚设。改成按块的**序号**当 key，
 *     文本变化由插件通知，控件自己决定什么时候真的去查。
 *  2. 装饰器里的 DOM 是外力改的：不声明 `stopEvent`，点一下结果里的链接会顺手把
 *     编辑区的选区抢走（期-01 那条「焦点被浮层抢」的同一个形状）。 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PmNode } from '@tiptap/pm/model'
import { parseQueryBlock, queryLines } from '../../../shared/queryLang'
import type { QueryBlockError } from '../../../shared/queryLang'
import type { QueryResult, QueryRow } from '../../../shared/types'

const key = new PluginKey('kestrel-query-blocks')

/** 围栏的语言名。就这一个词，改了要同步斜杠命令与源码档的提示 */
export const QUERY_LANG = 'query'

/** 打完字多久去查一次。§0.2 量过：解析 0.01ms、执行 ≤6ms，所以这不是性能线，
 *  是"用户还在不在打字"线——400ms 里没有新键，认定这句话暂时成形了 */
const DEBOUNCE = 400

/* ───────── 每块一个订阅：插件查到文本变了就通知那块的控件 ───────── */

type Listener = (code: string | null) => void
const subs = new Map<number, Set<Listener>>()

function subscribe(index: number, fn: Listener): () => void {
  let set = subs.get(index)
  if (!set) subs.set(index, (set = new Set()))
  set.add(fn)
  return () => {
    set.delete(fn)
    if (!set.size) subs.delete(index)
  }
}

function notify(index: number, code: string | null): void {
  for (const fn of subs.get(index) ?? []) fn(code)
}

/** 文档里所有查询块，按出现顺序 */
function blocksOf(doc: PmNode): { pos: number; code: string }[] {
  const out: { pos: number; code: string }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return true
    if (String(node.attrs.language ?? '') !== QUERY_LANG) return true
    out.push({ pos, code: node.textContent })
    return false
  })
  return out
}

/** 只比"每块的文本有没有变"，位置变不算变（光标移动不该触发重查） */
function sameBlocks(a: { code: string }[], b: { code: string }[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => x.code === b[i].code)
}

/* ───────── 控件 ───────── */

class ResultWidget {
  private dom: HTMLElement
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsub: (() => void) | null = null
  private code = ''
  /** 每次发出请求领一个号。迟到的答案如果号小了就直接丢——
   *  不然上一句查询的结果会盖到这一句下面（`mermaidBlock.ts` 同一个形状） */
  private gen = 0

  constructor(
    index: number,
    initial: string
  ) {
    this.code = initial
    this.dom = document.createElement('div')
    this.dom.className = 'qres'
    this.dom.contentEditable = 'false'
    this.dom.dataset.state = 'idle'
    this.dom.setAttribute('data-qblock', String(index))
    this.unsub = subscribe(index, (next) => this.onCode(next))
    this.schedule()
  }

  private onCode(next: string | null): void {
    if (next === null) {
      // 这块没了（被删、或者语言名被改掉）：装饰器本身也会消失，这里只停手
      if (this.timer) clearTimeout(this.timer)
      this.dom.replaceChildren()
      return
    }
    if (next === this.code) return
    this.code = next
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.run(), DEBOUNCE)
  }

  private async run(): Promise<void> {
    const mine = ++this.gen
    const code = this.code
    // 空围栏与半截句子都不发：刚打出 ```query 那行时查一次"空"，
    // 结果只能是一句"第一行要写视图名"的红字钉在用户眼前，那是打扰不是反馈
    if (!code.trim() || 'error' in parseQueryBlock(code)) {
      if (mine === this.gen) this.renderIdle(code)
      return
    }
    this.dom.dataset.state = 'loading'
    let res: Awaited<ReturnType<typeof window.kestrel.query.run>>
    try {
      res = await window.kestrel.query.run(code)
    } catch (err) {
      if (mine !== this.gen) return
      this.renderError(`查询没跑起来：${(err as Error).message.split('\n')[0]}`, null, code)
      return
    }
    if (mine !== this.gen) return
    if ('error' in res) this.renderError(res.error.msg, res.error, code)
    else this.renderResult(res.result)
  }

  private head(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'qres-bar'
    const dot = document.createElement('i')
    dot.className = 'qres-dot'
    bar.append(dot)
    return bar
  }

  private renderIdle(code: string): void {
    this.dom.dataset.state = 'idle'
    this.dom.replaceChildren()
    const tip = document.createElement('div')
    tip.className = 'qres-hint'
    const empty = !code.trim()
    tip.textContent = empty
      ? '空查询：第一行写视图名，例如 `table title`'
      : '这句还没写完（缺视图名，或者某个值没填）'
    this.dom.append(tip)
  }

  private renderError(msg: string, at: QueryBlockError | null, code: string): void {
    this.dom.dataset.state = 'error'
    this.dom.replaceChildren()
    this.dom.append(this.head())
    const box = document.createElement('div')
    box.className = 'qres-err'
    const lines = queryLines(code)
    if (at) {
      const src = lines[at.line - 1] ?? ''
      const pre = document.createElement('pre')
      pre.className = 'qres-src'
      pre.textContent = src
      const caret = document.createElement('pre')
      caret.className = 'qres-caret'
      caret.textContent = ' '.repeat(Math.max(0, at.col - 1)) + '^'
      box.append(pre, caret)
    }
    const why = document.createElement('div')
    why.className = 'qres-why'
    why.textContent = at ? `第 ${at.line} 行：${msg}` : msg
    box.append(why)
    this.dom.append(box)
  }

  private renderResult(res: QueryResult): void {
    this.dom.dataset.state = 'ready'
    this.dom.replaceChildren()
    const bar = this.head()
    const meta = document.createElement('span')
    meta.className = 'qres-meta'
    const more = res.truncated ? `（还有，被 limit ${res.rows.length} 截住）` : ''
    meta.textContent = `${res.rows.length} 条${more} · ${res.ms}ms`
    bar.append(meta, this.saveButton())
    this.dom.append(bar)

    for (const n of res.notes) {
      const note = document.createElement('div')
      note.className = 'qres-note'
      note.textContent = n
      this.dom.append(note)
    }
    if (!res.rows.length) {
      const empty = document.createElement('div')
      empty.className = 'qres-empty'
      // 空结果与出错是两件事：这句查询完全可能就该是 0 条。把条件念回去，
      // 用户才看得出是哪一句写狠了
      empty.textContent = '没有符合条件的（0 条）'
      this.dom.append(empty)
      return
    }
    this.dom.append(VIEWS[res.view] ? VIEWS[res.view](res) : VIEWS.list(res))
  }

  /** 「存为」：就地起一个输入框，不弹层。弹层会抢焦点，而用户下一步多半还想改这句。
   *  语句取的是**这一刻的** `this.code`，不是结果里回显的那一份——中间改过的字要一起存走 */
  private saveButton(): HTMLElement {
    const btn = document.createElement('button')
    btn.className = 'qres-save'
    btn.type = 'button'
    btn.textContent = '存为'
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const box = document.createElement('span')
      box.className = 'qres-savebox'
      const input = document.createElement('input')
      input.placeholder = '给这条查询起个名字'
      input.maxLength = 60
      const yes = document.createElement('button')
      yes.type = 'button'
      yes.textContent = '好'
      const no = document.createElement('button')
      no.type = 'button'
      no.textContent = '算'
      const done = (msg: string): void => {
        const tip = document.createElement('em')
        tip.textContent = msg
        box.replaceChildren(tip)
        setTimeout(() => box.remove(), 2400)
      }
      yes.addEventListener('click', () => {
        const name = input.value.trim()
        if (!name) return done('名字得写一个')
        import('@/store')
          .then(({ useStore }) => useStore.getState().saveQuery(name, this.code))
          .then((r) => done(r.ok ? '存好了' : r.msg))
          .catch(() => done('没存上：通道没接上'))
      })
      no.addEventListener('click', () => box.remove())
      box.append(input, yes, no)
      btn.replaceWith(box)
      input.focus()
    })
    return btn
  }

  get element(): HTMLElement {
    return this.dom
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer)
    this.unsub?.()
    this.gen++
  }
}

/* ───────── 五种视图（§三）。全部 textContent 建 DOM，一次 innerHTML 都不用 ───────── */

const MAX_ROWS = 200

function linkTo(row: QueryRow, label: string): HTMLElement {
  const a = document.createElement('button')
  a.className = 'qres-link'
  a.type = 'button'
  a.textContent = label
  a.title = row.entryDate
  a.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    void import('@/store').then(({ useStore }) => void useStore.getState().openEntry(row.id))
  })
  return a
}

/** `table title, props.字数` 里那一列该显示什么。属性从 props 里挑，别的一律取本体字段 */
function cellOf(row: QueryRow, col: string): string {
  if (col.startsWith('props.')) {
    const v = row.props[col.slice(6)]
    if (v === undefined || v === null) return ''
    return typeof v === 'boolean' ? (v ? '是' : '否') : String(v)
  }
  switch (col) {
    case 'title':
      return row.title ?? ''
    case 'topic':
      return row.topicName ?? ''
    case 'kind':
      return row.kind === 'diary' ? '日记' : '文章'
    case 'promoted_at':
      return row.promotedAt ? row.promotedAt.slice(0, 10) : ''
    case 'entry_date':
      return row.entryDate
    case 'created_at':
      return row.createdAt.slice(0, 10)
    case 'updated_at':
      return row.updatedAt.slice(0, 10)
    default:
      return ''
  }
}

const VIEWS: Record<string, (res: QueryResult) => HTMLElement> = {
  table: (res) => {
    const cols = res.cols.length ? res.cols : ['title', 'entry_date']
    const wrap = document.createElement('div')
    wrap.className = 'qres-table-wrap'
    const t = document.createElement('table')
    t.className = 'qres-table'
    const thead = document.createElement('thead')
    const hr = document.createElement('tr')
    for (const c of cols) {
      const th = document.createElement('th')
      th.textContent = c
      hr.append(th)
    }
    thead.append(hr)
    const body = document.createElement('tbody')
    for (const row of res.rows.slice(0, MAX_ROWS)) {
      const tr = document.createElement('tr')
      for (const c of cols) {
        const td = document.createElement('td')
        // 标题列可点，其余是纯文本：一行的跳转点有一个就够，两个就开始挡路
        if (c === 'title') td.append(linkTo(row, cellOf(row, c) || row.entryDate))
        else td.textContent = cellOf(row, c)
        tr.append(td)
      }
      body.append(tr)
    }
    t.append(thead, body)
    wrap.append(t)
    if (res.rows.length > MAX_ROWS) wrap.append(more(MAX_ROWS))
    return wrap
  },

  list: (res) => {
    const ul = document.createElement('ul')
    ul.className = 'qres-list'
    for (const row of res.rows.slice(0, MAX_ROWS)) {
      const li = document.createElement('li')
      li.append(linkTo(row, row.title ?? row.entryDate))
      const when = document.createElement('em')
      when.textContent = row.topicName ?? row.entryDate
      li.append(when)
      ul.append(li)
    }
    if (res.rows.length > MAX_ROWS) ul.append(more(MAX_ROWS))
    return ul
  },

  cards: (res) => {
    const grid = document.createElement('div')
    grid.className = 'qres-cards'
    for (const row of res.rows.slice(0, 60)) {
      const card = document.createElement('div')
      card.className = 'qres-card'
      card.append(linkTo(row, row.title ?? row.entryDate))
      const meta = document.createElement('em')
      meta.textContent = [row.entryDate, row.topicName].filter(Boolean).join(' · ')
      card.append(meta)
      grid.append(card)
    }
    if (res.rows.length > 60) grid.append(more(60))
    return grid
  },

  calendar: (res) => calendarLike(res, 'month'),
  timeline: (res) => calendarLike(res, 'line'),
}

function more(n: number): HTMLElement {
  const li = document.createElement('div')
  li.className = 'qres-more'
  li.textContent = `视图里只画前 ${n} 条，要更多把 limit 写大点`
  return li
}

/** 一个视图周期铺多少个月。`calendar` 是 3（设计稿 §三那一档），`timeline` 是 24。
 *  超出的部分不画，但要说出来——静默截断会让人以为库里就只有这些 */
const SPAN: Record<'month' | 'line', number> = { month: 3, line: 24 }

/** `calendar` 与 `timeline` 共用一次分组：按 YYYY-MM 归桶。
 *  分组在渲染层做——§0.2 量过 171 行 0.5ms，为这点事多一趟 SQL 不值 */
function calendarLike(res: QueryResult, shape: 'month' | 'line'): HTMLElement {
  const byMonth = new Map<string, QueryRow[]>()
  for (const row of res.rows) {
    const m = row.entryDate.slice(0, 7)
    const list = byMonth.get(m)
    if (list) list.push(row)
    else byMonth.set(m, [row])
  }
  // 月份按**行回来的先后**排，不再自己按月份重排：查询里那句 `sort entry_date desc` 已经
  // 定了哪一段更要紧，重排成升序会把「最新的 3 个月」变成「最旧的 3 个月」
  const months = [...byMonth.entries()]
  const cap = SPAN[shape]
  const shown = months.slice(0, cap)
  const wrap = document.createElement('div')
  wrap.className = shape === 'month' ? 'qres-cal' : 'qres-tl'
  for (const [month, rows] of shown) {
    const sec = document.createElement('div')
    sec.className = 'qres-mon'
    const h = document.createElement('h6')
    h.textContent = shape === 'month' ? `${month.replace('-', ' 年 ')} 月` : `${month} · ${rows.length} 条`
    sec.append(h)
    if (shape === 'month') {
      const grid = document.createElement('div')
      grid.className = 'qres-days'
      const days = new Map<string, QueryRow[]>()
      for (const r of rows) {
        const d = r.entryDate.slice(8, 10)
        const l = days.get(d)
        if (l) l.push(r)
        else days.set(d, [r])
      }
      for (const [d, dr] of days) {
        const cell = document.createElement('div')
        cell.className = 'qres-day'
        const n = document.createElement('b')
        n.textContent = String(Number(d))
        cell.append(n)
        for (const r of dr.slice(0, 3)) cell.append(linkTo(r, r.title ?? '（无题）'))
        if (dr.length > 3) {
          const tail = document.createElement('em')
          tail.textContent = `还 ${dr.length - 3} 条`
          cell.append(tail)
        }
        grid.append(cell)
      }
      sec.append(grid)
    } else {
      const ul = document.createElement('ul')
      ul.className = 'qres-list tight'
      for (const r of rows.slice(0, 12)) {
        const li = document.createElement('li')
        const day = document.createElement('span')
        day.className = 'qres-dow'
        day.textContent = r.entryDate.slice(8, 10)
        li.append(day, linkTo(r, r.title ?? '（无题）'))
        ul.append(li)
      }
      if (rows.length > 12) {
        const li = document.createElement('li')
        li.append(more(12))
        ul.append(li)
      }
      sec.append(ul)
    }
    wrap.append(sec)
  }
  if (months.length > cap) {
    const oops = document.createElement('div')
    oops.className = 'qres-note'
    oops.textContent = `这里只铺 ${cap} 个月，后面还有 ${months.length - cap} 个没画——把日期条件写窄，或换另一种视图`
    wrap.append(oops)
  }
  return wrap
}

/* ───────── 插件 ───────── */

/** 装饰器 DOM → 控件。`destroy` 只给得到那个节点，所以拿这张表接一下 */
const pending = new WeakMap<HTMLElement, ResultWidget>()

export const QueryBlocks = Extension.create({
  name: 'queryBlocks',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_c, s) => blocksOf(s.doc),
          apply: (_tr, old, _o, next) => {
            const now = blocksOf(next.doc)
            // 位置变了不算变化（光标移动、外部改动都会重排 pos），只有每块的**文本**
            // 变了才通知。不这么判的话，点一下结果里的链接就触发一次重查
            if (!sameBlocks(old, now)) {
              now.forEach((b, i) => notify(i, b.code))
              for (let i = now.length; i < old.length; i++) notify(i, null)
            }
            return now
          },
        },
        props: {
          decorations: (s) => {
            const blocks = key.getState(s) as { pos: number; code: string }[] | undefined
            if (!blocks?.length) return DecorationSet.empty
            const doc = s.doc
            return DecorationSet.create(
              doc,
              blocks
                .map((b, i) => {
                  const node = doc.nodeAt(b.pos)
                  if (!node) return null
                  return Decoration.widget(
                    b.pos + node.nodeSize,
                    () => {
                      const w = new ResultWidget(i, b.code)
                      pending.set(w.element, w)
                      return w.element
                    },
                    {
                      // key 里**不带查询文本**：带了就每敲一个字重建一次（见文件头那条）
                      key: `qblk-${i}`,
                      side: 1,
                      // 结果里的链接与输入框都是这块屏自己的交互：不拦一下，
                      // 点它们会顺带走 PM 的选区（期-01 那条「焦点被浮层抢」同形）
                      stopEvent: (e) => !!(e.target as HTMLElement | null)?.closest?.('.qres'),
                      ignoreSelection: true,
                      destroy: (node) => {
                        pending.get(node as HTMLElement)?.destroy()
                        pending.delete(node as HTMLElement)
                      },
                    }
                  )
                })
                .filter((d): d is Decoration => !!d)
            )
          },
        },
      }),
    ]
  },
})

/** 当前文档里所有查询块的语句。插入与"从存查询带一句进来"要用 */
export function queryBlockBodies(view: EditorView): string[] {
  return blocksOf(view.state.doc).map((b) => b.code)
}
