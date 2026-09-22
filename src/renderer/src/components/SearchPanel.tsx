/** 站内搜索面板（`Ctrl+F`，期-03 §4.1）。
 *
 *  与命令面板同族：同一个 `.sheet` 容器、同一套 `.pal-*` 列表与选中态，
 *  查询串 / 光标 / 防抖都留在组件里（store 只存「开没开」与定位请求），
 *  所以这里读到的状态与 Palette.tsx 是同一种形状，不必两头对账。 */

import type { JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useStore, entryLabel } from '@/store'
import { focusEditor } from '@/dom'
import type { FtsStatus, SearchResult, SearchResultRow } from '../../../shared/types'

/** 输入即搜的防抖（§4.1）。180ms 是「打字停一下就能看见结果」与
 *  「连打十个字不要发十趟查询」之间的折中。 */
const DEBOUNCE = 180
/** 面板开着时轮询索引进度的间隔。主进程不推事件（回调跨不过 IPC，§5.2），
 *  700ms 够那句「已完成 N%」看着在动 */
const POLL = 700
const PAGE = 8

/** 三条路径各自怎么说。面板底部那行要写明这次走的是哪条（§4.1），
 *  但它不是给用户看的术语表——所以是「索引 / 短词 / 逐行扫描」这种说法 */
const PATH_LABEL: Record<SearchResult['path'], string> = {
  match: '索引',
  like: '短词',
  scan: '逐行扫描',
}

/** 命中区间 → 高亮片段。IPC 上跑的是区间而不是拼好的 `<b>` 字符串，
 *  样式（`--accent` 下划线 + 底色）由这里决定（§6） */
function markHits(row: SearchResultRow): ReactNode[] {
  const text = row.excerpt ?? ''
  const out: ReactNode[] = []
  let at = 0
  for (const [a, b] of row.hits) {
    // 主进程按词逐个算区间，相邻词的区间会搭在一起；重叠的部分只保留一次
    const from = Math.max(a, at)
    if (b <= from) continue
    if (from > at) out.push(text.slice(at, from))
    out.push(<b key={from}>{text.slice(from, b)}</b>)
    at = b
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

export function SearchPanel(): JSX.Element | null {
  const open = useStore((s) => s.searchOpen)
  const close = useStore((s) => s.closeSearch)
  const openHit = useStore((s) => s.openSearchHit)
  const notify = useStore((s) => s.notify)

  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState<FtsStatus | null>(null)
  const [cursor, setCursor] = useState(0)
  // 运算符提示：查询为空时挂着，`Esc` 先收它再收面板（§4.3 那句「逐层退」）
  const [hint, setHint] = useState(true)
  // 索引刚追平时让它重跑一次：上一次是走原表兜底拿到的，路径该换成索引
  const [nonce, setNonce] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** 每次真正发出的查询领一个号。回来时对不上号就丢掉——连打时先发出的宽查询
   *  往往后到，不丢就会用旧结果盖掉新结果（§10 第 8 项） */
  const seq = useRef(0)

  // 打开时清掉上一次的查询：搜索面板要的是「进来就能打」，接着改词的场景太少，
  // 而留着旧串会让人以为结果就是旧串的那一份
  useEffect(() => {
    if (!open) return
    setQuery('')
    setResult(null)
    setPending(false)
    setCursor(0)
    setHint(true)
    inputRef.current?.focus()
    return () => {
      seq.current++
      // 面板里不跑命令，不会像 Palette 那样把焦点抢在别人刚要到的输入框上
      if (!useStore.getState().confirm) focusEditor()
    }
  }, [open])

  // 查询 → 结果。整个 effect 就是那条防抖：query 一变就把上一次的排钟撤了重排
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    // 输入变更先丢掉上一次结果，不追加、不留着闪烁（§4.1）
    setResult(null)
    setPending(!!q)
    if (!q) return

    const timer = setTimeout(() => {
      const my = ++seq.current
      void window.kestrel
        .search.run(q)
        .then((res) => {
          if (my !== seq.current) return
          setResult(res)
          setPending(false)
          setStatus(res.status.state === 'ready' ? null : res.status)
        })
        .catch((err: unknown) => {
          if (my !== seq.current) return
          setPending(false)
          notify(err instanceof Error ? err.message : String(err))
        })
    }, DEBOUNCE)

    return () => clearTimeout(timer)
  }, [open, query, nonce, notify])

  // 索引进度：只在面板开着时问，问到 ready 就停。ready 之后没有会变的东西了
  useEffect(() => {
    if (!open) return
    let stopped = false
    let building = false
    const tick = (): void => {
      void window.kestrel.fts
        .status()
        .then((st) => {
          if (stopped) return
          if (st.state === 'ready') {
            setStatus(null)
            if (building) setNonce((n) => n + 1)
            building = false
            return
          }
          building = true
          setStatus(st)
        })
        .catch(() => undefined)
    }
    tick()
    const timer = setInterval(tick, POLL)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [open])

  // 结果变了把光标收回第一行；换行时把它留在视口里
  useEffect(() => setCursor(0), [result])
  useEffect(() => {
    listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!open) return null

  const rows = result?.rows ?? []
  const total = result?.total ?? 0
  const capped = result?.capped ?? false

  function pick(row: SearchResultRow): void {
    void openHit(row.id, row.pos, row.hits.length > 0 && row.excerpt ? hitText(row) : null)
  }

  function onKey(e: ReactKeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape' && hint && !query.trim()) {
      // §4.3：先退运算符提示，再退面板。停在提示上按 Esc 直接关面板的话，
      // 「那一行提示是什么」就永远问不完了
      e.preventDefault()
      e.stopPropagation()
      setHint(false)
      return
    }
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
  }

  // 计数那一行。四种说法按「用户下一步要什么」排：
  // 索引没追平要先说清楚（结果可能缺），没命中要说不命中，宽查询要说的是截断
  let count = ''
  if (status && status.state !== 'ready') {
    const pct = status.total > 0 ? Math.floor((status.done * 100) / status.total) : 0
    count = `索引建立中（已完成 ${pct}%），结果可能不全`
  } else if (pending) {
    // 在途：占位而不是「搜索中」。这一行有 min-height，留着空才不会上下跳，
    // 而 180ms + ≤30ms 的一拍里闪出四个字反而像卡顿
    count = ''
  } else if (result && query.trim()) {
    count =
      rows.length === 0
        ? '没有命中'
        : `${total} 条命中${capped || total > rows.length ? `（显示前 ${rows.length} 条）` : ''}`
  }

  return (
    <div className="sheet open" onClick={close}>
      <div
        className="palette-card search-card"
        role="dialog"
        aria-modal="true"
        aria-label="站内搜索"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="pal-input"
          value={query}
          placeholder="搜索全库…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          aria-controls="search-list"
          aria-activedescendant={rows[cursor] ? `sr-${rows[cursor].id}` : undefined}
        />

        {hint && !query.trim() && (
          <div className="search-ops">
            {/* 运算符提示。§4.3 那句「Esc 逐层退，先退运算符提示」退的就是这一行；
                自动补全下拉不做（§9），所以把语法写在台面上而不是等着被敲出来 */}
            <span>
              <b>空格</b> 是「并且」，<b>大写 OR</b> 才是并集
            </span>
            <span>
              <b>title:</b> 只搜标题 · <b>content:</b> 只搜正文 · <b>tag:a/b</b> 含子标签 ·{' '}
              <b>topic:名</b> 精确 · <b>kind:diary</b> · <b>date:2026-09</b> 前缀 · <b>-词</b> 排除
            </span>
            <span>「精确短语」与裸词等价（trigram 本来就是精确子串）</span>
          </div>
        )}

        <div className="search-count">{count}</div>

        <div className="pal-list" id="search-list" role="listbox" ref={listRef}>
          {rows.length === 0 && !pending && query.trim() !== '' && (
            <div className="empty-hint" style={{ padding: '14px 10px' }}>
              没有命中。trigram 索引是**精确子串**，打错一个字就是 0 命中；
              词长了再试短一点的，或者去掉运算符。
            </div>
          )}
          {rows.map((row, i) => (
            <button
              key={row.id}
              id={`sr-${row.id}`}
              role="option"
              aria-selected={i === cursor}
              className={`pal-row sr-row ${i === cursor ? 'on' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(row)}
            >
              <span className="sr-title">{entryLabel(row)}</span>
              {row.excerpt && <span className="sr-excerpt">{markHits(row)}</span>}
              <span className="sr-meta">
                {row.kind === 'diary' ? '日记' : '文章'}
                {row.kind === 'article' && ` · ${row.topicName ?? '未归主题'}`} · {row.entryDate}
              </span>
            </button>
          ))}
        </div>

        {result && rows.length > 0 && (
          <div className="search-foot">
            <span>
              {/* §4.1 底部那行：走哪条路 + 上限。capped 时说「2000+」而不是「2000」——
                  候选集就是在那个封顶前停下的（§5.3） */}
              {PATH_LABEL[result.path]}
              {capped ? ` · 命中 ${total}+` : ` · 命中 ${total}`} · 显示 {rows.length} 条
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/** 送去定位的那串字。`pos` 是**原始 Markdown** 里的下标，源码模式直接能用；
 *  所见即所得的 DOM 里 markdown 语法字符不在，所以编辑器那半边改拿命中词去找它
 *  （§4.4）。取区间最长的那一个——它更像整段查询里最具体的那个词 */
function hitText(row: SearchResultRow): string {
  let best = row.hits[0]
  for (const h of row.hits) if (h[1] - h[0] > best[1] - best[0]) best = h
  return (row.excerpt ?? '').slice(best[0], best[1]).trim()
}
