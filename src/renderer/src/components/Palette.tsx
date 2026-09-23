/** 命令面板（`Ctrl+K`）与快速切换（`Ctrl+O`）。
 *
 *  一个组件两种模式：骨架完全一样（浮层 + 输入框 + 键盘导航的结果列表），
 *  差别只在**数据源**与**选中后干什么**。做成两套会出现两套视觉、两套键盘处理，
 *  改一次要改两处（设计文档 §2.1）。 */

import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, entryLabel } from '@/store'
import { COMMANDS, keyLabel } from '@/commands'
import { matchScore } from '@/fuzzy'
import { focusEditor } from '@/dom'
import { formatDateZh, parseDateKey, todayKey } from '../../../shared/date'

interface Row {
  key: string
  title: string
  /** 右侧的灰色补充信息（命令的键位 / 记录的类型与日期） */
  hint?: string
  group: string
  run: () => void
}

/** 键盘翻页的步长。列表行高 34，浮层最高 60vh，一屏大致十来行 */
const PAGE = 10

function buildCommandRows(): Row[] {
  const s = useStore.getState()
  const rows: Row[] = COMMANDS.filter((c) => !c.enabled || c.enabled(s)).map((c) => ({
    key: c.id,
    title: c.title,
    hint: c.keys?.map(keyLabel).join(' / '),
    group: c.group,
    run: () => void c.run(useStore.getState()),
  }))

  // 存查询与模板直接排在命令列表里（期-07 §四：命令面板列出存查询 → 回车在当前光标处插入）。
  // 插的是语句本身不是引用（决策 D10）——存的若是 `{{query:名字}}`，导出的 md 在别人手里就是死链
  for (const q of s.savedQueries) {
    rows.push({
      key: `q:${q.id}`,
      title: q.name,
      hint: `插入查询 · ${q.view}`,
      group: '存查询',
      run: () => void useStore.getState().insertQuery(q.body, q.id),
    })
  }
  for (const t of s.templates) {
    rows.push({
      key: `T:${t.id}`,
      title: t.name,
      hint: `套用模板 · ${t.scope === 'diary' ? '日记' : '文章'}`,
      group: '模板',
      run: () => void useStore.getState().applyTemplate(t.id),
    })
  }
  return rows
}

function buildSwitchRows(): Row[] {
  const s = useStore.getState()
  const rows: Row[] = s.switchRows.map((e) => ({
    key: `e:${e.id}`,
    title: entryLabel(e),
    hint: e.kind === 'diary' ? '日记' : '文章',
    group: e.kind === 'diary' ? '记录 · 日记' : '记录 · 文章',
    run: () => void useStore.getState().openEntry(e.id),
  }))

  for (const t of s.topics) {
    rows.push({
      key: `t:${t.id}`,
      title: t.name,
      hint: '主题',
      group: '主题',
      run: () => {
        void s.selectTopic(t.id)
        useStore.getState().setMode('topic')
      },
    })
  }
  return rows
}

/** 日期候选**现算**，不是预生成的一堆行：只有输入看起来像日期时才多出这一条
 *  「跳到那一天」。不存在的日期也会跳——打开它就会建出那天的日记（§8.2：不做创建项）。 */
function dateRow(query: string): Row | null {
  const q = query.trim()
  if (!/^\d{4}-\d{1,2}(-\d{1,2})?$/.test(q)) return null

  const [y, m = '01', d = '01'] = q.split('-')
  const key = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  if (!parseDateKey(key)) return null

  return {
    key: `d:${key}`,
    title: `跳到 ${formatDateZh(key)}`,
    hint: key === todayKey() ? '今天' : '日期',
    group: '日期',
    run: () => void useStore.getState().openDate(key),
  }
}

export function Palette(): JSX.Element | null {
  const mode = useStore((s) => s.palette)
  const pool = useStore((s) => s.switchRows)
  // 只有开关与输入会让列表重算，那不够：`Ctrl+K` 打开时正好存查询刚被改过，
  // 面板里就该立刻看到新那条（所以这两个也要进 rows 的依赖）
  const savedQueries = useStore((s) => s.savedQueries)
  const templates = useStore((s) => s.templates)
  const close = useStore((s) => s.closePalette)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 打开时清空并聚焦；关掉时把焦点还给正文
  useEffect(() => {
    if (!mode) return
    setQuery('')
    setCursor(0)
    if (mode === 'command') void useStore.getState().refreshLibrary()
    inputRef.current?.focus()
    return () => {
      // 面板里跑的命令经常就是「再开一个浮层」（升格 / 回收站 / 设置）。
      // 那时浮层的输入框刚在 commit 里拿到 autoFocus，这里再把焦点抢回正文，
      // 打字就打到身后的文档上去了——实测标题没改、正文反被选中替换掉。
      const s = useStore.getState()
      if (s.palette || s.searchOpen || s.promoteOpen || s.binOpen || s.sheetOpen || s.libraryOpen || s.versionOf) return
      focusEditor()
    }
  }, [mode])

  const rows = useMemo(() => {
    if (!mode) return []
    const source = mode === 'command' ? buildCommandRows() : buildSwitchRows()
    const dated = mode === 'switch' ? dateRow(query) : null
    const all = dated ? [dated, ...source] : source

    const q = query.trim()
    const hits: { row: Row; at: number; score: number }[] = []
    all.forEach((row, at) => {
      const score = matchScore(`${row.title} ${row.hint ?? ''}`, q)
      if (score !== null) hits.push({ row, at, score })
    })

    // 分组顺序 → 匹配分 → 原顺序。**不调模糊权重**，先用简单规则（设计文档 §3.3）。
    // 分组顺序取第一次出现的次序（即 COMMANDS 的排列），不另立一张分组权重表。
    const rank = new Map<string, number>()
    for (const h of hits) if (!rank.has(h.row.group)) rank.set(h.row.group, rank.size)
    hits.sort(
      (a, b) =>
        (rank.get(a.row.group) ?? 0) - (rank.get(b.row.group) ?? 0) ||
        a.score - b.score ||
        a.at - b.at
    )
    return hits.map((h) => h.row)
  }, [mode, query, pool, savedQueries, templates])

  // 结果变了就把光标收回第一行，否则会停在一个已经不存在的位置上
  useEffect(() => setCursor(0), [query, pool])

  useEffect(() => {
    listRef.current?.querySelector('.pal-row.on')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!mode) return null

  function pick(row: Row): void {
    close()
    row.run()
  }

  function onKey(e: ReactKeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setCursor((c) => (rows.length === 0 ? 0 : (c + delta + rows.length) % rows.length))
      return
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault()
      const delta = e.key === 'PageDown' ? PAGE : -PAGE
      setCursor((c) => Math.min(Math.max(c + delta, 0), Math.max(rows.length - 1, 0)))
      return
    }
    if (e.key === 'Enter' && rows[cursor]) {
      e.preventDefault()
      pick(rows[cursor])
    }
    // Esc 不在这里处理：它要走 App.tsx 的优先级链（还有别的浮层要按顺序关）
  }

  let lastGroup = ''

  return (
    <div className="sheet open" onClick={close}>
      <div
        className="palette-card"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'command' ? '命令面板' : '快速切换'}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="pal-input"
          value={query}
          placeholder={mode === 'command' ? '输入命令…' : '搜索或跳到…'}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          aria-controls="pal-list"
          aria-activedescendant={rows[cursor] ? `pal-${rows[cursor].key}` : undefined}
        />

        <div className="pal-list" id="pal-list" role="listbox" ref={listRef}>
          {rows.length === 0 && (
            <div className="empty-hint" style={{ padding: '14px 4px' }}>
              {mode === 'switch' ? '没有匹配的记录或主题。' : '没有匹配的命令。'}
            </div>
          )}
          {rows.map((row, i) => {
            const head = row.group !== lastGroup ? row.group : ''
            lastGroup = row.group
            return (
              <div key={row.key}>
                {head && <div className="sec-label pal-group">{head}</div>}
                <button
                  id={`pal-${row.key}`}
                  role="option"
                  aria-selected={i === cursor}
                  className={`pal-row ${i === cursor ? 'on' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(row)}
                >
                  <span className="pal-title">{row.title}</span>
                  {row.hint && <span className="pal-hint">{row.hint}</span>}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}