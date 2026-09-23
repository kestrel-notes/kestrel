import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { useStore } from '@/store'
import {
  NO_FILTER,
  aggregateByTopic,
  binLabel,
  binOf,
  buildTimeCells,
  conservedCount,
  filterGraph,
  isFilterActive,
  pickBinUnit,
} from '../../../shared/graph'
import type { BinUnit, GraphFilter, VisibleUnit } from '../../../shared/graph'
import type { GlobalGraph } from '../../../shared/types'
import { todayKey } from '../../../shared/date'
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

/** 时间视图的格距（6b §三）。列 46px 是"月"标签 `2026-09` 在 1× 下刚好不重叠的下沿；
 *  行 30px 由格子半径上限 ×2 反推（r ≤ 13 → 26px + 4px 缝）。 */
const COL_W = 46
const ROW_H = 30
/** 时间视图的轴沟宽度：左边留给主题名，上边留给日期。轴画在屏幕空间，平移缩放都不动它 */
const GUT_L = 108
const GUT_T = 26
/** 一格里最多画多少个成员名。超出就只报数，别把整格摊成一列清单 */
const CELL_LIST_MAX = 12

/** 格子半径：成员数开方。13px 封顶是被 ROW_H 逼出来的，不是审美选择 */
function cellRadius(count: number): number {
  return Math.min(13, 3 + Math.sqrt(count) * 2.6)
}

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
  // 时间视图的格子（带 `bin`）按格距封顶；主题折叠节点没有这个约束，可以画到 22px
  if (u.bin !== undefined) return cellRadius(u.count)
  return Math.min(22, 10 + Math.sqrt(u.count) * 1.6)
}

function unitLabel(u: VisibleUnit): string {
  return u.kind === 'node' ? u.node.label : u.label
}

/** 主题着色：`--tag-1 … --tag-8`，下标 = 主题 id % 8（6a §四）。
 *  与标签色板共用 token 但哈希输入不同（标签按名字、主题按 id）。 */
function topicVarOf(key: string | null | undefined): string | undefined {
  if (!key) return undefined
  const id = Number(key.slice(2))
  if (!Number.isFinite(id)) return undefined
  return `var(--tag-${(id % 8) + 1})`
}

function topicVar(u: VisibleUnit): string | undefined {
  return topicVarOf(u.kind === 'node' ? u.node.topicKey : u.topicKey)
}

/** 顶栏「主题」那一排 chip。超过 8 个主题就折成一行可滚的，不做下拉——
 *  下拉会把"我筛掉了什么"藏起来，而筛着的状态必须一直看得见 */
function TopicChips({
  topics,
  value,
  onChange,
}: {
  topics: { key: string; label: string; count: number }[]
  value: string[]
  onChange: (next: string[]) => void
}): JSX.Element | null {
  if (topics.length === 0) return null
  const on = new Set(value)
  return (
    <span className="go-chips" role="group" aria-label="按主题筛选">
      {topics.map((t) => (
        <button
          key={t.key}
          className={`go-chip${on.has(t.key) ? ' on' : ''}`}
          style={{ '--tc': topicVarOf(t.key) } as React.CSSProperties}
          onClick={() => onChange(on.has(t.key) ? value.filter((k) => k !== t.key) : [...value, t.key])}
          title={`${t.count} 条`}
        >
          {t.label}
        </button>
      ))}
    </span>
  )
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

  /** 视图模式。`time` 那一档是 6b 加的：力导向回答"谁连着谁"，时间轴回答"什么时候开始关心"。
   *  两档共用同一套单元、同一套过滤、同一个缩放器，只有坐标的来路不同。
   *  存在 store 而不是组件里，是为了 `Ctrl+Shift+G` 能直接开到时间轴那一档 */
  const mode = useStore((s) => s.graphMode)
  const setMode = useStore((s) => s.setGraphMode)
  /** 过滤器只活在组件里，**不落 Setting**（6b 决策 D3）：落了盘的下一次 Ctrl+G 会开出一个
   *  被藏掉九成的图，而用户不记得自己筛过什么。关窗不丢（覆盖层常驻），刷新才丢。 */
  const [filter, setFilter] = useState<GraphFilter>(NO_FILTER)
  const [binPick, setBinPick] = useState<'auto' | BinUnit>('auto')

  const topicName = useCallback(
    (key: string | null): string => {
      if (key === null) return '未归主题'
      return data?.topics.find((t) => t.key === key)?.label ?? key
    },
    [data]
  )

  /** 先过滤，后折叠（6b §四）。反了就会报出"显示 240 / 共 3001"这种分母筛前、分子筛后的假数 */
  const shown = useMemo(
    () => (data ? filterGraph(data.nodes, data.edges, filter, todayKey()) : { nodes: [], edges: [] }),
    [data, filter]
  )

  /** 时间轴的列宽档：`auto` 时按跨度选，24 列是"1× 下不横向挤"的上沿（46px × 24 = 1104px） */
  const binUnit: BinUnit = useMemo(() => {
    if (binPick !== 'auto') return binPick
    let lo = ''
    let hi = ''
    for (const n of shown.nodes) {
      if (!n.date) continue
      if (lo === '' || n.date < lo) lo = n.date
      if (n.date > hi) hi = n.date
    }
    if (lo === '') return 'month'
    return pickBinUnit(Math.round((Date.parse(`${hi}T00:00:00Z`) - Date.parse(`${lo}T00:00:00Z`)) / 86400000), 24)
  }, [binPick, shown.nodes])

  /** 时间视图的折叠单元：主题 × 时间箱。折不动的时候（格子比条目还多）它就退化成散点 */
  const cells = useMemo(
    () =>
      mode === 'time' && shown.nodes.length > 0
        ? buildTimeCells(shown.nodes, shown.edges, binUnit, topicName)
        : null,
    [mode, shown, binUnit, topicName]
  )

  const base = useMemo(() => {
    if (mode === 'time') return cells
    if (shown.nodes.length === 0) return null
    return aggregateByTopic(shown.nodes, shown.edges, VISIBLE_LIMIT, (k) => topicName(k))
  }, [mode, cells, shown, topicName])

  /** 展开过的主题把聚合节点换回成员。成员坐标还没有，所以先在父位置周围铺一圈。
   *  只对力导向有意义：时间格子的"展开"是点上去看成员清单，不是把格子打散回轴上 */
  const units = useMemo<VisibleUnit[]>(() => {
    if (!base || mode === 'time' || expanded.size === 0) return base?.units ?? []
    const byKey = new Map(shown.nodes.map((n) => [n.key, n]))
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
  }, [base, expanded, shown.nodes, mode])

  const edges = useMemo(() => {
    if (!base) return []
    if (mode === 'time' || expanded.size === 0) return base.edges
    // 展开之后原先挂在聚合节点上的边要改指向成员。整图重算一遍聚合，
    // 而不是手写边的搬运——`aggregateByTopic` 幂等，喂回未折的集合就是同一套规则
    const keep = new Set(units.map(unitKeyOf))
    const flat = shown.nodes.filter((n) => keep.has(n.key))
    return aggregateByTopic(flat, shown.edges, Number.MAX_SAFE_INTEGER).edges
  }, [base, shown, expanded, units, mode])

  /** 时间视图的坐标：格子在哪一列哪一行是数据本身决定的，不求解（6b §3.2）。
   *  这条路子顺带解决了 6a 的一个毛病——力导向每次开图都要重解一遍、点位会晃，
   *  时间轴上同一个格子永远在同一个位置。 */
  const timeCoords = useMemo(() => {
    if (!cells) return null
    const colOf = new Map(cells.bins.map((b, i) => [b, i]))
    const rowOf = new Map(cells.lanes.map((l, i) => [l, i]))
    const out = new Map<string, { x: number; y: number }>()
    for (const u of cells.units) {
      const lane = u.kind === 'node' ? (u.node.topicKey ?? 'untouched') : (u.topicKey ?? 'untouched')
      const bin = u.kind === 'agg' ? (u.bin ?? '') : binOf(u.node.date, cells.unit)
      out.set(unitKeyOf(u), { x: (colOf.get(bin) ?? 0) * COL_W, y: (rowOf.get(lane) ?? 0) * ROW_H })
    }
    return out
  }, [cells])

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

  // 拓扑到手 / 主题展开 → 重解一次（仅此两处，跑完即停）。
  // 时间轴不在这条路上：它的坐标由 (主题, 箱) 直接算出来，一次求解都不做（§3.2）
  useEffect(() => {
    if (!data) return
    if (mode === 'time') {
      stopSim()
      setCoords(timeCoords ?? new Map())
      setPhase('ready')
      setProgress(1)
      return
    }
    solve(units)
    return stopSim
  }, [data, mode, units, timeCoords, solve, stopSim])

  /** fit-all：把布局包围盒等比塞进画布。求解期与收敛后都用它兜住"不要飞出屏幕" */
  const fit = useCallback(() => {
    const el = wrapRef.current
    if (!el || coords.size === 0) return
    const xs = [...coords.values()].map((p) => p.x)
    const ys = [...coords.values()].map((p) => p.y)
    // 时间轴要绕开两条轴沟：左边放主题名、上边放日期，包围盒挤进去就会压在字上
    const padL = mode === 'time' ? GUT_L : 40
    const padT = mode === 'time' ? GUT_T : 40
    const w = el.clientWidth - padL - 40
    const h = el.clientHeight - padT - 40
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const bw = Math.max(1, maxX - minX)
    const bh = Math.max(1, maxY - minY)
    const k = Math.min(FIT_MAX, Math.max(0.2, Math.min(w / bw, h / bh)))
    setView({ k, x: padL + (w - bw * k) / 2 - minX * k, y: padT + (h - bh * k) / 2 - minY * k })
  }, [coords, mode])

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
        // 一层层退：选中 → 过滤 → 关闭。筛空了又直接关掉，用户会以为图不见了
        if (selected) setSelected(null)
        else if (isFilterActive(filter)) setFilter(NO_FILTER)
        else setOpen(false)
        break
      case 't':
      case 'T':
        setMode(mode === 'force' ? 'time' : 'force')
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
        if (!key) break
        const u = units.find((x) => unitKeyOf(x) === key)
        // 格子与折叠节点都能跳：进这一格的**第一篇**（成员 key 形如 `e:12`，数值序 = 时间序）。
        // 6a 时折叠节点按 Enter 什么都不做，只能点一下摊开——时间轴上格子多、摊开又只是把
        // 同一列打散，跳进去才是用户要的
        const target = u?.kind === 'node' ? u.node.key : u?.members[0]
        if (target && target.startsWith('e:')) {
          e.preventDefault()
          void openNode(target)
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

  /** 时间视图只画"焦点弧"。前置实测（`scratch/p6b-cell-shape.mjs`）：3000 库里折到月格
   *  之后单元之间仍有 4994 条边（原始 5660）——**折叠救不了全边画弧**，所以这一档
   *  平时只画密度，点中某一格才画它自己的连线（那一格被连的边数实测 p90=48、max=159）。 */
  const focusEdges = useMemo(() => {
    if (mode !== 'time') return []
    const focus = selected ?? hover
    if (!focus) return []
    return edges.filter((e) => e.source === focus || e.target === focus)
  }, [mode, edges, selected, hover])

  /** 每主题一条轨迹线：把该行占了的格子按时间顺序连起来。
   *  验收第 2 项"某主题从稀疏到密集"看的就是这条线加格子半径。
   *  跨了空档的那一段画成虚线——空的那几个月是真没写，不是画不下 */
  const trajectories = useMemo(() => {
    if (mode !== 'time' || !cells) return []
    const colOf = new Map(cells.bins.map((b, i) => [b, i]))
    const out: { x1: number; y1: number; x2: number; y2: number; gap: boolean; topicKey: string | null }[] = []
    for (const lane of cells.lanes) {
      const row = cells.lanes.indexOf(lane) * ROW_H
      const cols = cells.units
        .map((u) => {
          const unitLane = u.kind === 'node' ? (u.node.topicKey ?? 'untouched') : (u.topicKey ?? 'untouched')
          if (unitLane !== lane) return null
          const bin = u.kind === 'agg' ? (u.bin ?? '') : binOf(u.node.date, cells.unit)
          const col = colOf.get(bin)
          return col === undefined ? null : col
        })
        .filter((c): c is number => c !== null)
        .sort((a, b) => a - b)
      for (let i = 1; i < cols.length; i++)
        out.push({
          x1: cols[i - 1] * COL_W,
          y1: row,
          x2: cols[i] * COL_W,
          y2: row,
          gap: cols[i] - cols[i - 1] > 1,
          topicKey: lane === 'untouched' ? null : lane,
        })
    }
    return out
  }, [mode, cells])

  /** 选中格子的成员清单。没有这一段，点进一格只能跳"第一篇"，其余成员就成了二等公民 */
  const memberList = useMemo(() => {
    if (mode !== 'time' || !selected || !data) return null
    const u = units.find((x) => unitKeyOf(x) === selected)
    if (!u || u.kind !== 'agg') return null
    const byKey = new Map(data.nodes.map((n) => [n.key, n]))
    const list = u.members
      .map((k) => byKey.get(k))
      .filter((n): n is NonNullable<typeof n> => Boolean(n))
      .sort((a, b) => (a.date === b.date ? a.key.localeCompare(b.key, undefined, { numeric: true }) : a.date.localeCompare(b.date)))
    return { label: u.label, list, cut: list.length > CELL_LIST_MAX }
  }, [mode, selected, units, data])

  /** 当前在看的那篇落在哪个单元。时间轴上多半落进一个格子，命中的格描一圈亮边——
   *  "我正在写的东西在网络里的哪儿"这个问题，在时间轴上只有这一种答法 */
  const centerKey = useMemo(() => {
    if (currentId === null) return null
    const entry = `e:${currentId}`
    for (const u of units) {
      if (u.kind === 'node' ? u.node.key === entry : u.members.includes(entry)) return unitKeyOf(u)
    }
    return entry
  }, [currentId, units])

  /* ── 渲染 ── */

  if (!open) return null

  const aggCount = base?.collapsed.reduce((s, c) => s + c.count, 0) ?? 0
  const visibleCount = units.length
  const conserved = base ? conservedCount(base.units) : 0
  const focusables = units.filter((u) => coords.has(unitKeyOf(u)))
  /** 求解期不画边。实测 511 个可见单元配 1437 条边，每提交一次就要重排两千个 SVG 元素，
   *  主线程最长一次被占 233ms —— 那是用户能感知的卡顿。点本来就在动，这时候线是噪声；
   *  收敛后一次性把线画出来，反而是"网络成型"的那一下。 */
  const drawEdges = phase === 'ready' && mode === 'force'
  const lineEdges = mode === 'time' ? focusEdges : edges
  const filtering = isFilterActive(filter)

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
            {data ? (
              filtering ? (
                <span className="go-filtering" title="筛过之后分母仍是全库；这行报的是筛后规模，不是折叠">
                  显示 {shown.nodes.length} / 共 {data.nodes.length} 条 · {shown.edges.length} 条连线
                </span>
              ) : (
                `${data.nodes.length} 条 · ${data.edges.length} 条连线`
              )
            ) : (
              '读取中'
            )}
          </em>
        </div>
        <div className="go-modes" role="group" aria-label="视图模式">
          <button
            className={`tb-btn${mode === 'force' ? ' active' : ''}`}
            onClick={() => setMode('force')}
            title="谁连着谁 · 力导向（T 切换）"
          >
            关系
          </button>
          <button
            className={`tb-btn${mode === 'time' ? ' active' : ''}`}
            onClick={() => setMode('time')}
            title="什么时候开始关心 · 主题 × 时间（T 切换）"
          >
            时间
          </button>
        </div>
        <div className="go-right">
          {mode === 'time' && (
            <label className="go-bin">
              分箱
              <select
                value={binPick}
                onChange={(e) => setBinPick(e.target.value as 'auto' | BinUnit)}
                title={`自动档按跨度选，当前落在「${binLabel('2026-01', binUnit)}」这一级`}
              >
                <option value="auto">自动</option>
                <option value="day">按天</option>
                <option value="week">按周</option>
                <option value="month">按月</option>
                <option value="quarter">按季</option>
                <option value="year">按年</option>
              </select>
            </label>
          )}
          <label className="go-bin">
            类型
            <select
              value={filter.kind}
              onChange={(e) => setFilter({ ...filter, kind: e.target.value as GraphFilter['kind'] })}
            >
              <option value="all">全部</option>
              <option value="diary">只看日记</option>
              <option value="article">只看文章</option>
            </select>
          </label>
          <label className="go-bin">
            时间
            <select
              value={filter.sinceDays === null ? 'all' : String(filter.sinceDays)}
              onChange={(e) =>
                setFilter({ ...filter, sinceDays: e.target.value === 'all' ? null : Number(e.target.value) })
              }
              title="以今天为基准，不是以库里最新那天"
            >
              <option value="all">全部</option>
              <option value="30">近 30 天</option>
              <option value="90">近 90 天</option>
              <option value="365">近一年</option>
            </select>
          </label>
          <TopicChips topics={data?.topics ?? []} value={filter.topics} onChange={(t) => setFilter({ ...filter, topics: t })} />
          {filtering && (
            <button className="tb-btn go-clear" onClick={() => setFilter(NO_FILTER)} title="清掉全部过滤">
              清除筛选
            </button>
          )}
          {phase === 'solving' && (
            <span className="go-progress solving">布局中 {Math.round(progress * 100)}%</span>
          )}
          {phase === 'ready' && mode === 'force' && aggCount > 0 && (
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
        {!error && data && filtering && shown.nodes.length === 0 && (
          <p className="go-empty">
            筛选后一条都不剩。<button className="go-link" onClick={() => setFilter(NO_FILTER)}>清掉筛选</button> 再看。
          </p>
        )}
        {!error && data && data.nodes.length <= 1 && (
          <p className="go-empty">
            还没有网络。正文里写 <code>[[双链]]</code> 或 <code>#标签</code>，连起来再回来看。
          </p>
        )}
        {!error && data && data.nodes.length > 1 && shown.nodes.length > 0 && (
          <svg
            className="go-svg"
            ref={svgRef}
            role="img"
            aria-label={`全库图谱，${visibleCount} 个可见单元`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={(e) => {
              if (!(e.target as Element).closest('.g-any')) setSelected(null)
            }}
          >
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {/* 主题轨迹：一行一条，把占了的格子按时间连起来。跨空档那一段画虚线 */}
              {mode === 'time' &&
                trajectories.map((t, i) => (
                  <line
                    key={`t${i}`}
                    className={`go-traj${t.gap ? ' gap' : ''}`}
                    x1={t.x1}
                    y1={t.y1}
                    x2={t.x2}
                    y2={t.y2}
                    style={t.topicKey ? ({ '--tc': topicVarOf(t.topicKey) } as React.CSSProperties) : undefined}
                  />
                ))}

              {(drawEdges ? edges : lineEdges).map((e, i) => {
                const a = coords.get(e.source)
                const b = coords.get(e.target)
                if (!a || !b) return null
                const dim = neighborKeys !== null && !(neighborKeys.has(e.source) && neighborKeys.has(e.target))
                if (mode === 'time') {
                  // 焦点弧往上鼓：同一段日期里直线会把"跨了 8 个月"和"就在隔壁格"画成同一个东西
                  const mx = (a.x + b.x) / 2
                  const my = (a.y + b.y) / 2 - Math.abs(b.x - a.x) * 0.22 - 12
                  return (
                    <path
                      key={`e${i}`}
                      className={`go-arc${dim ? ' dim' : ''}`}
                      d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`}
                    />
                  )
                }
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
                        // 时间轴上的格子不是"摊开"对象：把它打散回同一列只是噪声，
                        // 点一下要的是"这一格是谁、连到哪"
                        if (mode === 'time') {
                          setSelected((s) => (s === key ? null : key))
                          return
                        }
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
                        // 格子双击 = 进这一格最早的那篇（成员清单里可以挑别的）
                        const target = u.kind === 'node' ? u.node.key : u.members[0]
                        if (!target || !target.startsWith('e:')) return
                        void openNode(target)
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
                          ? `${u.label} · ${u.count} 条${u.bin !== undefined ? '（点一下看成员与连线）' : '（点一下摊开）'}`
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
          {/* 轴画在屏幕空间、不跟着缩放：横向拖远了列名不会跟着跑掉，
              字也不会被 scale 拉糊（6a 的标签踩过这个坑，才定的 LABEL_ZOOM 门） */}
          {mode === 'time' && cells && (
            <div className="go-axis" aria-hidden={false}>
              <div className="go-cols">
                {(() => {
                  /** 列名按"上一个的右边界"让位，不按固定步长跳。
                   *  固定步长在最左边会翻车（实机截图上 `2024-01` 和 `2024-02` 叠成一坨）：
                   *  起点那一列被改成左对齐之后，它占的宽度不再是"居中 ±半格" */
                  const stride = Math.max(1, Math.ceil(56 / (COL_W * view.k)))
                  const half = 24
                  const out: JSX.Element[] = []
                  let lastRight = -1e9
                  cells.bins.forEach((b, i) => {
                    if (i % stride !== 0) return
                    const x = view.x + i * COL_W * view.k - GUT_L
                    if (x < -20) return
                    const edge = x < half * 2
                    const left = edge ? 2 : x
                    const right = edge ? left + half * 2 : x + half
                    if (left - lastRight < 8) return
                    lastRight = right
                    out.push(
                      <span
                        key={b}
                        className={`go-col${edge ? ' edge' : ''}`}
                        style={{ left: Math.max(2, x) }}
                      >
                        {binLabel(b, cells.unit)}
                      </span>
                    )
                  })
                  return out
                })()}
              </div>
              <div className="go-lanes">
                {cells.lanes.map((lane, r) => {
                  // 点就画在 r*ROW_H 这个坐标上（格子的中心即行的坐标），所以名字也得落在同一个 y。
                  // 以前多减了半行，整列名字低了一行：第一行的点没人认领，最后一行只剩个名字没有点
                  const y = view.y + r * ROW_H * view.k
                  const on = filter.topics.includes(lane)
                  const count = shown.nodes.filter((n) => (n.topicKey ?? 'untouched') === lane).length
                  return (
                    <button
                      key={lane}
                      className={`go-lane${on ? ' on' : ''}`}
                      style={
                        {
                          top: y,
                          '--tc': topicVarOf(lane === 'untouched' ? null : lane),
                        } as React.CSSProperties
                      }
                      onClick={() =>
                        setFilter({
                          ...filter,
                          topics: on ? filter.topics.filter((k) => k !== lane) : [...filter.topics, lane],
                        })
                      }
                      title={on ? '不再只看这一行' : '只看这一行主题'}
                    >
                      {fitLabel(lane === 'untouched' ? '未归主题' : topicName(lane), 11)}
                      <em>{count}</em>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {memberList && (
            <aside className="go-members">
              <header>
                {memberList.label}
                <button className="tb-btn" onClick={() => setSelected(null)} title="收起 · Esc">
                  ×
                </button>
              </header>
              {memberList.list.slice(0, CELL_LIST_MAX).map((n) => (
                <button
                  key={n.key}
                  className="go-member"
                  onClick={() => {
                    void openNode(n.key)
                    setOpen(false)
                  }}
                >
                  <span className="m-date">{n.date.slice(5)}</span>
                  <span className="m-kind">{n.type === 'diary' ? '日记' : '文章'}</span>
                  <span className="m-label">{n.label}</span>
                </button>
              ))}
              {memberList.cut && <p className="go-more">还有 {memberList.list.length - CELL_LIST_MAX} 条没列出</p>}
            </aside>
          )}
      </div>

      <footer className="go-foot">
        <span>
          {mode === 'time'
            ? '点一格看它的连线与成员 · 点左边的主题名只看那一行 · 滚轮缩放 · 拖动平移 · T 切回关系图'
            : '滚轮缩放 · 拖动平移 · 双击进正文 · Esc 关闭'}
        </span>
        {data && data.danglingCount > 0 && (
          <span title="写了 [[…]] 但目标还不存在。不进拓扑，只报数">悬空链接 {data.danglingCount} 条</span>
        )}
        {mode === 'time' && selected && (
          <span title="时间视图平时不画全库的线：折到月格之后仍有近五千条，画出来是一团糊">
            这一格向外 {focusEdges.length} 条连线
          </span>
        )}
        {base && conserved !== shown.nodes.length && (
          <span className="go-warn">守恒不对：{conserved} / {shown.nodes.length}</span>
        )}
      </footer>
    </div>
  )
}

function unitKeyOf(u: VisibleUnit): string {
  return u.kind === 'node' ? u.node.key : u.id
}
