/** 斜杠命令 `/`：块级元素的目录（期-04 §4.9）。

 *
 *  为什么走「ProseMirror 插件 + 一层极薄的 React 浮层」而不是引 `@tiptap/suggestion`：
 *  离线是产品红线，不为一个菜单新增依赖；而这里需要的只有三件事——在 `/` 起头的空段
 *  落打开一个菜单、把之后的字符当查询来过滤、用 ↑↓/Enter/Esc 选一条插进去。这三件事
 *  用一个 pluginState 就装得下。
 *
 *  触发判据收得很紧，因为这是**中文日记**应用：`/` 常出现在日期（`2026/09/22`）和
 *  比值（`A/B`）里。所以只有当 `/` 是**当前块第一个非空字符、且其后到光标没有空格、
 *  光标后又紧跟块尾**时才打开——等价于「在一个空段落里打 `/` 开头」。半句话中间打
 *  `/` 不会误触菜单。
 *
 *  菜单目录只列**当前装得上、且不弹系统文件框**的块级元素。§4.9 里还点名了公式 / 脚注 /
 *  Mermaid / 图片 / 附件——它们各自属于 #88（附件）与 #91（公式/脚注/Mermaid），依赖没装
 *  就不进这张表，避免留一堆点了报错的死项。 */

import { useEffect, useState, type JSX } from 'react'
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { matchScore } from '@/fuzzy'

/** 一条斜杠项。`run` 自己负责先把 `/query` 那截删掉（`del`）再接插入命令，
 *  这样一个意图只落一个事务，不会闪一下空段再变表格。 */
export interface SlashItem {
  id: string
  title: string
  /** 右侧灰字提示（类型名） */
  hint?: string
  /** 参与过滤的额外关键词 */
  keywords: string
  run: (editor: Editor, del: { from: number; to: number }) => void
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'p',
    title: '段落',
    hint: '文本',
    keywords: 'paragraph text 正文',
    run: (ed, del) => ed.chain().focus().deleteRange(del).setParagraph().run(),
  },
  {
    id: 'h1',
    title: '标题 1',
    hint: '大',
    keywords: 'heading h1 一级 大标题',
    run: (ed, del) => ed.chain().focus().deleteRange(del).setHeading({ level: 1 }).run(),
  },
  {
    id: 'h2',
    title: '标题 2',
    hint: '中',
    keywords: 'heading h2 二级 中标题',
    run: (ed, del) => ed.chain().focus().deleteRange(del).setHeading({ level: 2 }).run(),
  },
  {
    id: 'h3',
    title: '标题 3',
    hint: '小',
    keywords: 'heading h3 三级 小标题',
    run: (ed, del) => ed.chain().focus().deleteRange(del).setHeading({ level: 3 }).run(),
  },
  {
    id: 'ul',
    title: '无序列表',
    hint: '•',
    keywords: 'bullet unordered list 项目符号',
    run: (ed, del) => ed.chain().focus().deleteRange(del).setParagraph().toggleBulletList().run(),
  },
  {
    id: 'ol',
    title: '有序列表',
    hint: '1.',
    keywords: 'ordered numbered list 编号',
    run: (ed, del) => ed.chain().focus().deleteRange(del).setParagraph().toggleOrderedList().run(),
  },
  {
    id: 'task',
    title: '待办列表',
    hint: '☑',
    keywords: 'task todo checkbox 待办 复选',
    run: (ed, del) => ed.chain().focus().deleteRange(del).setParagraph().toggleTaskList().run(),
  },
  {
    id: 'quote',
    title: '引用',
    hint: '"',
    keywords: 'blockquote quote 引用块',
    run: (ed, del) => ed.chain().focus().deleteRange(del).setBlockquote().run(),
  },
  {
    id: 'callout',
    title: 'Callout 提示框',
    hint: 'note',
    keywords: 'callout admonition 提示 标注 备注',
    // 直接插一棵带好 attrs 的 blockquote，而不是 setBlockquote().updateAttributes()：
    // 后者在这条链里 updateAttributes 会返回 false，把整个链式事务一起作废（连前面的
    // deleteRange 都不落），实测 `/cal` 残字留在正文里。insertContent 一步到位、返回 true。
    run: (ed, del) =>
      ed
        .chain()
        .focus()
        .deleteRange(del)
        .insertContent({
          type: 'blockquote',
          attrs: { calloutType: 'note', calloutTitle: '', calloutFold: '' },
          content: [{ type: 'paragraph' }],
        })
        .run(),
  },
  {
    id: 'code',
    title: '代码块',
    hint: '```',
    keywords: 'code block 代码 围栏',
    run: (ed, del) => ed.chain().focus().deleteRange(del).setCodeBlock().run(),
  },
  {
    id: 'table',
    title: '表格 3×3',
    hint: 'table',
    keywords: 'table 表格 单元格',
    run: (ed, del) =>
      ed
        .chain()
        .focus()
        .deleteRange(del)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    id: 'hr',
    title: '分割线',
    hint: '—',
    keywords: 'horizontal rule divider 分割线 分隔线',
    run: (ed, del) => ed.chain().focus().deleteRange(del).setHorizontalRule().run(),
  },
]

/** 按查询过滤，规则与命令面板一致：分组顺序即目录顺序，命中分再排。 */
function filterItems(query: string): SlashItem[] {
  const q = query.trim()
  if (!q) return SLASH_ITEMS
  const hits: { item: SlashItem; at: number; score: number }[] = []
  SLASH_ITEMS.forEach((item, at) => {
    const score = matchScore(`${item.title} ${item.keywords}`, q)
    if (score !== null) hits.push({ item, at, score })
  })
  return hits.sort((a, b) => a.score - b.score || a.at - b.at).map((h) => h.item)
}

interface MenuState {
  active: boolean
  /** `/query` 这一截的区间：from = 块内容起点，to = 光标 */
  from: number
  to: number
  query: string
  cursor: number
}

const CLOSED: MenuState = { active: false, from: -1, to: -1, query: '', cursor: 0 }
const slashKey = new PluginKey<MenuState>('slash')

/** 插件算出的、浮层要画的那一份。null = 关掉 */
export interface SlashSnapshot {
  x: number
  y: number
  cursor: number
  items: SlashItem[]
  pick: (index: number) => void
}

let listener: ((snap: SlashSnapshot | null) => void) | null = null

export function subscribeSlash(fn: (snap: SlashSnapshot | null) => void): () => void {
  listener = fn
  return () => {
    if (listener === fn) listener = null
  }
}

function readState(state: EditorState): MenuState {
  return slashKey.getState(state) ?? CLOSED
}

export const SlashMenu = Extension.create({
  name: 'slashMenu',

  addProseMirrorPlugins() {
    const editor = this.editor

    /** 关掉菜单：删掉 `/query` 再发一版。删文本这一步保证「Esc 不留残余」。 */
    function closeAndClear(view: EditorView, s: MenuState, clear: boolean): void {
      const tr = view.state.tr
      if (clear && s.active) tr.delete(s.from, s.to)
      view.dispatch(tr.setMeta(slashKey, { close: true }))
    }

    function applyPick(view: EditorView, s: MenuState, item: SlashItem): void {
      // run 自带 deleteRange，这里不再单独删 `/query`
      item.run(editor, { from: s.from, to: s.to })
      void view
    }

    return [
      new Plugin<MenuState>({
        key: slashKey,
        state: {
          init: () => CLOSED,
          apply(tr: Transaction, value: MenuState, _old: EditorState, next: EditorState): MenuState {
            const meta = tr.getMeta(slashKey) as { close?: boolean; cursor?: number } | undefined
            if (meta?.close) return CLOSED

            const sel = next.selection
            if (!sel.empty) return CLOSED
            const head = sel.head
            const $h = next.doc.resolve(head)
            const blockStart = $h.start()
            const before = next.doc.textBetween(blockStart, head, '￼', ' ')
            const after = next.doc.textBetween(head, $h.end(), '￼', ' ')
            const m = /^\/([^\s]*)$/.exec(before)
            if (!m || after !== '') return CLOSED

            const query = m[1]
            if (filterItems(query).length === 0) return CLOSED
            let cursor = value.active && value.query === query ? value.cursor : 0
            if (meta && typeof meta.cursor === 'number') cursor += meta.cursor
            return { active: true, from: blockStart, to: head, query, cursor }
          },
        },
        view(view) {
          let last = ''
          const push = (state: EditorState): void => {
            const s = readState(state)
            // 阅读实例复用了同一棵 PM：不可编辑时保持沉默，绝不弹菜单
            if (!s.active || !view.editable) {
              if (last !== 'closed') {
                last = 'closed'
                listener?.(null)
              }
              return
            }
            const items = filterItems(s.query)
            const cursor = Math.max(0, Math.min(s.cursor, items.length - 1))
            const c = view.coordsAtPos(s.to)
            const snap: SlashSnapshot = {
              x: c.left,
              y: c.bottom,
              cursor,
              items,
              pick: (index) => {
                const cur = readState(view.state)
                const list = filterItems(cur.query)
                const item = list[index]
                if (item) applyPick(view, cur, item)
              },
            }
            const key = `${cursor}|${s.query}|${items.length}|${Math.round(c.left)},${Math.round(c.bottom)}`
            if (key !== last) {
              last = key
              listener?.(snap)
            }
          }
          return {
            update: () => push(view.state),
            destroy: () => {
              last = ''
              listener?.(null)
            },
          }
        },
        props: {
          handleKeyDown(view, event) {
            const s = readState(view.state)
            if (!s.active || !view.editable) return false
            const items = filterItems(s.query)

            if (event.key === 'ArrowDown') {
              view.dispatch(view.state.tr.setMeta(slashKey, { cursor: 1 }))
              return true
            }
            if (event.key === 'ArrowUp') {
              view.dispatch(view.state.tr.setMeta(slashKey, { cursor: -1 }))
              return true
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              const item = items[s.cursor] ?? items[0]
              if (item) applyPick(view, s, item)
              return true
            }
            if (event.key === 'Escape') {
              closeAndClear(view, s, true)
              return true
            }
            // 其余字符交给编辑器落进正文，下一次 apply 会重算 query 与列表
            return false
          },
        },
      }),
    ]
  },
})

const ROW = 34
const MENU_W = 260

/** 浮层：只读插件 publish 出来的那一份快照，自己不做任何选区计算。
 *  用 `position: fixed` 挂到 body，避开给编辑器套一层 relative 容器。 */
export function SlashPopup(): JSX.Element | null {
  const [snap, setSnap] = useState<SlashSnapshot | null>(null)
  useEffect(() => subscribeSlash(setSnap), [])
  if (!snap || snap.items.length === 0) return null

  // 下面放不下就翻到光标上方；左右夹在视口内。高度按行数估，够准，不必实测回流
  const h = Math.min(snap.items.length, 10) * ROW + 12
  const flip = snap.y + h + 8 > window.innerHeight
  const top = Math.max(8, flip ? snap.y - h - 6 : snap.y + 6)
  const left = Math.min(Math.max(8, snap.x), Math.max(8, window.innerWidth - MENU_W - 8))

  return (
    <div className="slash-menu" role="listbox" style={{ top, left }}>
      {snap.items.map((item, i) => (
        <button
          key={item.id}
          role="option"
          aria-selected={i === snap.cursor}
          className={`slash-row ${i === snap.cursor ? 'on' : ''}`}
          // 别把焦点从编辑器抢走：抢了 ProseMirror 会收回选区，菜单也就没了落点
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => snap.pick(i)}
        >
          <span className="slash-title">{item.title}</span>
          {item.hint && <span className="slash-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  )
}
