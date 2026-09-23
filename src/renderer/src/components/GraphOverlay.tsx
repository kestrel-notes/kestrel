import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { useStore } from '@/store'
import { aggregateByTopic, conservedCount } from '../../../shared/graph'
import type { VisibleUnit } from '../../../shared/graph'
import type { GlobalGraph } from '../../../shared/types'
import { fitLabel } from './graphLabel'

/** 可见单元的上限，实测定的（`docs/期-06a-设计.md` 决策 D1）：
 *  600 节点一次性求解约 420ms 是「等一下但看得清」的上沿，3000 要 3.2 秒、
 *  而且布局铺到 4621×4618px，缩进窗口后节点只剩 1.5px、标签完全不可读。
 *  所以聚合的真正理由是**看得清**，求解耗时只是第二理由。 */
const VISIBLE_LIMIT = 600

/** 每帧给布局求解的预算。超了就开始掉帧，用户会觉得整个窗口卡住（决策 D3 的反转条件）。 */
const FRAME_BUDGET_MS = 8

/** d3-force 默认 alphaDecay 0.0228 收敛约 300 tick；我们提到 0.035，实测 194 tick 到 α<0.001。
 *  这个数字同时是进度条的分母。 */
const EXPECTED_TICKS = 194

/** 标签只在放大到这个倍率后才出现，否则一定糊成一片（§四） */
const LABEL_ZOOM = 1.2

/** fit-all 的倍率上限。不设上限的话 5 条的库会被顶到 6×，节点画成 18px 的饼——
 *  小库要的是"看得清"，不是"铺满"。 */
const FIT_MAX = 1.6

interface SimNode extends SimulationNodeDatum {
  key: string
  r: number
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  kind: string
}

/** 节点半径：入度越大越粗，但开方压一档（决策 D6——线性映射会让枢纽吃掉半个画布）。
 *  3px 是最小可点尺寸的下沿，9px 封顶是为了不盖住邻居的标签。 */
function radiusOf(inDeg: number): number {
  return 3 + 6 * Math.min(1, Math.sqrt(Math.max(0, inDeg)) / 3)
}

function unitRadius(u: VisibleUnit): number {
  if (u.kind === 'node') return radiusOf(u.node.inDeg)
  // 聚合节点按成员数开方，10–22px
  return Math.min(22, 10 + Math.sqrt(u.count) * 1.6)
}

function unitLabel(u: VisibleUnit): string {
  return u.kind === 'node' ? u.node.label : u.label
}

/** 主题着色：`--tag-1 … --tag-8`，下标 = 主题 id % 8（§四）。
 *  与标签色板共用 token 但哈希输入不同（标签按名字、主题按 id）。 */
function topicVar(u: VisibleUnit): string | undefined {
  const key = u.kind === 'node' ? u.node.topicKey : u.topicKey
  if (!key) return undefined
  const id = Number(key.slice(2))
  if (!Number.isFinite(id)) return undefined
  return `var(--tag-${(id % 8) + 1})`
}

export function GraphOverlay(): JSX.Element | null {
  const open = useStore((s) => s.graphOpen)
  const setOpen = useStore((s) => s.setGraphOpen)
  const openNode = useStore((s) => s.openNode)
  const currentId = useStore((s) => s.currentId)

  const [data, setData] = useState<GlobalGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<'loading' | 'solving' | 'ready'>('loading')
  const [progress, setProgress] = useState(0)

  /** 展开过的主题。展开只改可见单元、不改数据范围——这就是「聚合不是过滤」那条界（§5.2） */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [hover, setHover] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const svgRef = useRef<SVGSVGElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null)
  const rafRef = useRef<number | null>(null)
  /** 收敛后冻结的坐标。展开主题时靠它把已有的点钉住，只让新点动起来（=「局部微调」） */
  const posRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const unitsRef = useRef<VisibleUnit[]>([])
  const [coords, setCoords] = useState<Map<string, { x: number; y: number }>>(new Map())

  const base = useMemo(() => {
    if (!data) return null
    return aggregateByTopic(data.nodes, data.edges, VISIBLE_LIMIT)
  }, [data])

  /** 展开过的主题把聚合节点换回成员。成员坐标还没有，所以先在父位置周围铺一圈 */
  const units = useMemo<VisibleUnit[]>(() => {
    if (!base || !data) return []
    if (expanded.size === 0) return base.units
    const byKey = new Map(data.nodes.map((n) => [n.key, n]))
    const out: VisibleUnit[] = []
    for (const u of base.units) {
      if (u.kind === 'agg' && u.topicKey && expanded.has(u.topicKey)) {
        for (const k of u.members) {
          const node = byKey.get(k)
          if (node) out.push({ kind: 'node', node })
        }
      } else out.push(u)
    }
    return out
  }, [base, expanded, data])

  const edges = useMemo(() => {
    if (!base || !data) return []
    if (expanded.size === 0) return base.edges
    // 展开之后原先挂在聚合节点上的边要改指向成员。整图重算一遍聚合，
    // 而不是手写边的搬运——`aggregateByTopic` 幂等，喂回未折的集合就是同一套规则
    const keep = new Set(units.map(unitKeyOf))
    const flat = data.nodes.filter((n) => keep.has(n.key))
    return aggregateByTopic(flat, data.edges, Number.MAX_SAFE_INTEGER).edges
  }, [base, data, expanded, units])

  useEffect(() => {
    if (!open) return
    let dead = false
    setData(null)
    setError(null)
    setPhase('loading')
    setProgress(0)
    setExpanded(new Set())
    setSelected(null)
    setHover(null)
    posRef.current = new Map()
    void window.kestrel.links
      .graphAll()
      .then((g) => {
        if (!dead) setData(g)
      })
      .catch((e) => {
        if (!dead) setError(String(e instanceof Error ? e.message : e))
      })
    return () => {
      dead = true
    }
  }, [open])

  const stopSim = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    simRef.current?.stop()
    simRef.current = null
  }, [])

  /** 一次性求解，分片跑在 rAF 里。
   *
   *  这不是"每帧重排的动画"（那是红线）：求解**有终点**，α 冷却即 stop()，此后零 CPU。
   *  分片只是为了不把 200–420ms 塞进一帧，让整窗（含标题栏）冻住（决策 D3）。 */
  const solve = useCallback(
    (list: VisibleUnit[]) => {
      stopSim()
      if (list.length === 0) {
        setPhase('ready')
        setCoords(new Map())
        return
      }
      const nodes: SimNode[] = list.map((u) => {
        const key = unitKeyOf(u)
        const at = posRef.current.get(key)
        const n: SimNode = { key, r: unitRadius(u) }
        if (at) {
          n.x = at.x
          n.y = at.y
        }
        // 展开出来的成员没有历史坐标：留在聚合节点原来的位置上，力导向会把它们推开
        else if (u.kind === 'node') {
          const parent = posRef.current.get(`agg:${u.node.topicKey ?? ''}`)
          if (parent) {
            n.x = parent.x
            n.y = parent.y
          }
        }
        // 已有坐标的点全钉住：展开时只有新点动，老点不动——这就是设计稿说的「局部微调」
        if (at) {
          n.fx = at.x
          n.fy = at.y
        }
        return n
      })
      const known = new Map(nodes.map((n) => [n.key, n]))
      const links: SimLink[] = []
      for (const e of edges) {
        const a = known.get(e.source)
        const b = known.get(e.target)
        if (a && b) links.push({ source: e.source, target: e.target, kind: e.kind })
      }

      const reduce =
        typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

      const sim = forceSimulation<SimNode>(nodes)
        .force(
          'link',
          forceLink<SimNode, SimLink>(links)
            .id((d) => d.key)
            .distance(34)
            .strength(0.32)
        )
        // 斥力随节点数走：固定 -110 在 501 个单元上把图压成一坨星芒（实机截图量的），
        // 而同一个值在 20 个单元上又散得太开。√n 这一档是试出来的折中。
        .force(
          'charge',
          // distanceMax：斥力只在 400 单位内生效。没有这条时，一个没有任何连线的孤点
          // 会被 500 个邻居一路推到画布外（实机截图右上那个点），居中力又拉不回来
          forceManyBody().strength(-60 - Math.sqrt(nodes.length) * 6).theta(0.9).distanceMax(400)
        )
        .force('collide', forceCollide<SimNode>().radius((d) => d.r + 1.5).iterations(1))
        // 居中力不能太弱：上一版 0.05 时有一个孤点被斥力推到画布外 800px 处（截图右上那个点）
        .force('x', forceX(0).strength(0.12))
        .force('y', forceY(0).strength(0.12))
        .force('center', forceCenter(0, 0))
        .alpha(1)
        .alphaDecay(0.035)
        .stop()

      simRef.current = sim
      unitsRef.current = list

      const commit = (): void => {
        const next = new Map<string, { x: number; y: number }>()
        for (const n of nodes) if (Number.isFinite(n.x) && Number.isFinite(n.y)) next.set(n.key, { x: n.x!, y: n.y! })
        for (const [k, v] of next) posRef.current.set(k, v)
        setCoords(next)
      }

      // reduced-motion：不逐帧晃，直接跑满再一次性画（会卡一下，但不晃眼）
      if (reduce) {
        for (let i = 0; i < EXPECTED_TICKS && sim.alpha() > sim.alphaMin(); i++) sim.tick()
        sim.stop()
        simRef.current = null
        commit()
        setPhase('ready')
        setProgress(1)
        return
      }

      setPhase('solving')
      let ticks = 0
      let frames = 0
      const step = (): void => {
        const t0 = performance.now()
        // 每帧跑到预算用完为止：节点少的时候一帧能跑几十个 tick，多的时候一帧只跑一个
        do {
          sim.tick()
          ticks++
        } while (sim.alpha() > sim.alphaMin() && performance.now() - t0 < FRAME_BUDGET_MS)
        setProgress(Math.min(1, ticks / EXPECTED_TICKS))
        if (sim.alpha() > sim.alphaMin()) {
          // **不是每帧都提交**：一次 commit 就是 301 个节点的一轮 React 重渲染，实测每帧提交
          // 把 300 节点的收敛从 208ms（纯求解）拖到 659ms。隔帧提交省下这一半，
          // 观感上仍然是"聚拢"动画（约 30fps），而求解的 CPU 本身一点没变。
          if (frames++ % 2 === 0) commit()
          rafRef.current = requestAnimationFrame(step)
          return
        }
        sim.stop()
        simRef.current = null
        commit()
        setPhase('ready')
        setProgress(1)
      }
      rafRef.current = requestAnimationFrame(step)
    },
    [edges, stopSim]
  )

  // 拓扑到手 / 主题展开 → 重解一次（仅此两处，跑完即停）
  useEffect(() => {
    if (!data) return
    solve(units)
    return stopSim
  }, [data, units, expanded, solve, stopSim])

  /** fit-all：把布局包围盒等比塞进画布。求解期与收敛后都用它兜住"不要飞出屏幕" */
  const fit = useCallback(() => {
    const el = wrapRef.current
    if (!el || coords.size === 0) return
    const xs = [...coords.values()].map((p) => p.x)
    const ys = [...coords.values()].map((p) => p.y)
    const pad = 40
    const w = el.clientWidth - pad * 2
    const h = el.clientHeight - pad * 2
    const bw = Math.max(1, Math.max(...xs) - Math.min(...xs))
    const bh = Math.max(1, Math.max(...ys) - Math.min(...ys))
    const k = Math.min(FIT_MAX, Math.max(0.2, Math.min(w / bw, h / bh)))
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2
    setView({ k, x: el.clientWidth / 2 - cx * k, y: el.clientHeight / 2 - cy * k })
  }, [coords])

  useEffect(() => {
    if (phase === 'ready' && coords.size > 0) fit()
  }, [phase, coords, fit])

  /* ── 缩放 / 平移 / 拖拽 ── */

  useEffect(() => {
    const el = svgRef.current
    if (!el || !open) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      setView((v) => {
        const k = Math.min(6, Math.max(0.2, v.k * Math.pow(1.0015, -e.deltaY)))
        // 以指针为中心：指针底下那个点在缩放后还得在原地
        return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [open])

  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if ((e.target as Element).closest('.g-any')) return // 点的是节点，不是背景
    dragRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = dragRef.current
    if (!d) return
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }))
  }
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    dragRef.current = null
    ;(e.currentTarget as SVGSVGElement).releasePointerCapture?.(e.pointerId)
  }

  /* ── 键盘：全程不碰鼠标也能进出与浏览 ── */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const stepPx = 60
    const jump = (dx: number, dy: number): void => setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
    switch (e.key) {
      case 'Escape':
        if (selected) setSelected(null)
        else setOpen(false)
        break
      case '+':
      case '=':
        setView((v) => ({ ...v, k: Math.min(6, v.k * 1.25) }))
        break
      case '-':
        setView((v) => ({ ...v, k: Math.max(0.2, v.k / 1.25) }))
        break
      case '0':
        fit()
        break
      case 'ArrowUp':
        e.preventDefault()
        jump(0, stepPx)
        break
      case 'ArrowDown':
        e.preventDefault()
        jump(0, -stepPx)
        break
      case 'ArrowLeft':
        e.preventDefault()
        jump(stepPx, 0)
        break
      case 'ArrowRight':
        e.preventDefault()
        jump(-stepPx, 0)
        break
      case 'Enter': {
        // 有焦点在节点上时才跳：焦点在背景上不动作
        const el = document.activeElement as Element | null
        const key = el?.getAttribute('data-key')
        if (key && !key.startsWith('agg:')) {
          e.preventDefault()
          void openNode(key)
          setOpen(false)
        }
        break
      }
      default:
        return
    }
    // 走到这里说明键已被处理，别再让 App.tsx 的全局 keydown 抢同一次按键
    e.stopPropagation()
  }

  const neighborKeys = useMemo(() => {
    const focus = hover ?? selected
    if (!focus || !data) return null
    const set = new Set<string>([focus])
    for (const e of edges) {
      if (e.source === focus) set.add(e.target)
      if (e.target === focus) set.add(e.source)
    }
    return set
  }, [hover, selected, edges, data])

  /* ── 渲染 ── */

  if (!open) return null

  const aggCount = base?.collapsed.reduce((s, c) => s + c.count, 0) ?? 0
  const shown = units.length
  const conserved = base ? conservedCount(base.units) : 0
  const centerKey = currentId === null ? null : `e:${currentId}`
  const focusables = units.filter((u) => coords.has(unitKeyOf(u)))
  /** 求解期不画边。实测 511 个可见单元配 1437 条边，每提交一次就要重排两千个 SVG 元素，
   *  主线程最长一次被占 233ms —— 那是用户能感知的卡顿。点本来就在动，这时候线是噪声；
   *  收敛后一次性把线画出来，反而是"网络成型"的那一下。 */
  const drawEdges = phase === 'ready'

  return (
    <div
      className="graph-overlay open glass-strong"
      role="dialog"
      aria-modal="true"
      aria-label="全局知识图谱"
      onKeyDown={onKeyDown}
      tabIndex={-1}
      ref={(el) => {
        el?.focus()
      }}
    >
      <header className="go-head">
        <div className="go-title">
          知识图谱
          <em className="go-count">
            {data ? `${data.nodes.length} 条 · ${data.edges.length} 条连线` : '读取中'}
          </em>
        </div>
        <div className="go-right">
          {phase === 'solving' && (
            <span className="go-progress solving">布局中 {Math.round(progress * 100)}%</span>
          )}
          {phase === 'ready' && aggCount > 0 && (
            <span className="go-progress" title="按主题折叠是为了看得清，不是筛掉了">
              已折叠 {base?.collapsed.length} 个主题 · {aggCount} 条
            </span>
          )}
          <button className="tb-btn" onClick={() => setOpen(false)} title="关闭 · Esc">
            ×
          </button>
        </div>
      </header>

      <div className="go-canvas" ref={wrapRef}>
        {error && <p className="go-empty">读不到图谱：{error}</p>}
        {!error && data && data.nodes.length <= 1 && (
          <p className="go-empty">
            还没有网络。正文里写 <code>[[双链]]</code> 或 <code>#标签</code>，连起来再回来看。
          </p>
        )}
        {!error && data && data.nodes.length > 1 && (
          <svg
            className="go-svg"
            ref={svgRef}
            role="img"
            aria-label={`全库图谱，${shown} 个可见单元`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={(e) => {
              if (!(e.target as Element).closest('.g-any')) setSelected(null)
            }}
          >
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {drawEdges &&
                edges.map((e, i) => {
                const a = coords.get(e.source)
                const b = coords.get(e.target)
                if (!a || !b) return null
                const dim = neighborKeys !== null && !(neighborKeys.has(e.source) && neighborKeys.has(e.target))
                return (
                  <line
                    key={`e${i}`}
                    className={`g-edge k-${e.kind}${dim ? ' dim' : ''}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                  />
                )
              })}

              {focusables.map((u) => {
                const key = unitKeyOf(u)
                const at = coords.get(key)!
                const r = unitRadius(u)
                const tc = topicVar(u)
                const dim = neighborKeys !== null && !neighborKeys.has(key)
                const isCenter = key === centerKey
                const isSel = key === selected
                const shape =
                  u.kind === 'node' && u.node.type === 'article' ? (
                    <rect
                      className={`g-any go-node n-article${dim ? ' dim' : ''}${isCenter ? ' is-center' : ''}${isSel ? ' is-sel' : ''}`}
                      x={at.x - r}
                      y={at.y - r}
                      width={r * 2}
                      height={r * 2}
                      rx={2}
                      style={tc ? ({ '--tc': tc } as React.CSSProperties) : undefined}
                    />
                  ) : (
                    <circle
                      className={`g-any go-node${u.kind === 'agg' ? ' n-agg' : u.kind === 'node' && u.node.type === 'diary' ? ' n-diary' : ''}${dim ? ' dim' : ''}${isCenter ? ' is-center' : ''}${isSel ? ' is-sel' : ''}`}
                      cx={at.x}
                      cy={at.y}
                      r={r}
                      style={tc ? ({ '--tc': tc } as React.CSSProperties) : undefined}
                    />
                  )
                return (
                  <g key={key}>
                    <g
                      role="button"
                      tabIndex={0}
                      data-key={key}
                      aria-label={unitLabel(u)}
                      onClick={() => {
                        if (u.kind === 'agg' && u.topicKey) {
                          setExpanded((prev) => {
                            const next = new Set(prev)
                            if (next.has(u.topicKey!)) next.delete(u.topicKey!)
                            else next.add(u.topicKey!)
                            return next
                          })
                          return
                        }
                        setSelected((s) => (s === key ? null : key))
                      }}
                      onDoubleClick={() => {
                        if (u.kind !== 'node') return
                        void openNode(key)
                        setOpen(false)
                      }}
                      onPointerEnter={() => setHover(key)}
                      onPointerLeave={() => setHover((h) => (h === key ? null : h))}
                    >
                      {shape}
                      {u.kind === 'agg' && (
                        <text className="go-agg-count" x={at.x} y={at.y + 3.4}>
                          {u.count}
                        </text>
                      )}
                      <title>
                        {u.kind === 'agg'
                          ? `${u.label} · ${u.count} 条（点一下摊开）`
                          : `${u.node.label}${data.topics.find((t) => t.key === u.node.topicKey) ? ` · ${data.topics.find((t) => t.key === u.node.topicKey)!.label}` : ''} · 被 ${u.node.inDeg} 处链接指向`}
                      </title>
                    </g>
                    {view.k >= LABEL_ZOOM && u.kind === 'node' && (
                      <text className="go-label" x={at.x} y={at.y + r + 9} textAnchor="middle">
                        {fitLabel(unitLabel(u), 12)}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>
        )}
      </div>

      <footer className="go-foot">
        <span>滚轮缩放 · 拖动平移 · 双击进正文 · Esc 关闭</span>
        {data && data.danglingCount > 0 && (
          <span title="写了 [[…]] 但目标还不存在。不进拓扑，只报数">悬空链接 {data.danglingCount} 条</span>
        )}
        {base && conserved !== data?.nodes.length && (
          <span className="go-warn">守恒不对：{conserved} / {data?.nodes.length}</span>
        )}
      </footer>
    </div>
  )
}

function unitKeyOf(u: VisibleUnit): string {
  return u.kind === 'node' ? u.node.key : u.id
}
