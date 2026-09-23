import type { JSX } from 'react'
import type { DanglingLink, GraphNode, LocalGraph } from '../../../shared/types'
import { fitLabel, textWidth as textWidthOf } from './graphLabel'

/** 环半径照抄原型（R1=56 / R2=82），画布比原型大一圈：原型是 234×186，这里是 300×216。
 *  原型不改——234 宽塞不下环外的标签（R2 到画布边只剩 26px，最长标签要 49px，
 *  落在正上/正下/正左/正右的标签一定被切掉半个字），所以应用这边把画布放开，
 *  让标签一律排在环外。放宽的那部分只是边距，环、节点、字体全是原型的值
 *  （**只有悬空短枝的间距与画法动过**，量出来的理由见下面 STUB_TOP 那段）。
 *  改 W/H 时右栏列宽要一起看：app.css 的 .app 给右栏 300px，1:1 渲染需要这个宽度。 */
const W = 300
const H = 216
const CX = W / 2
const CY = H / 2
const R1 = 56
const R2 = 82

/** 节点上限，照设计稿「上限约 12 节点」。环上塞太多点会糊成一团线，图就不再是「一眼看懂关系」的工具。
 *  深度 1 优先留下：远亲不如近邻。
 *
 *  **超出不再静默丢弃**（期-06a §5.3，这条以前是 bug）：折成一个计数点画在最外环，
 *  tooltip 写清「还有 N 个，都在第几跳外」。判据是守恒——可见单元承载的条目数必须等于
 *  `graph.nodes.length`，一个都不许悄悄消失。
 *  与全屏图谱共用的是**计数节点这个形状与守恒判据**，不是同一个分组键：这里按跳数折
 *  （`LocalGraph` 的节点本来就带 `depth`），全库按主题折（`shared/graph.ts` 的 `aggregateByTopic`）。 */
const MAX_NODES = 12
/** 悬空短枝画成一束：一根从圆心出去的虚线柄 + 一条竖向虚线脊 + 挂在脊上的点。
 *  原型是「每条悬空目标各画一根从圆心出去的虚线 + 一个点」，点间距 9、半径 3.4。
 *  那个画法有两个毛病，都不是审美问题，是墨迹真的叠在一起（实机量的屏幕像素，缩放 0.88）：
 *  ① 点的墨迹直径 = 2×3.4 + 1.6（描边跨在路径两侧）= 8.4 视框单位，间距只有 9 ⇒
 *     相邻两点之间只剩 0.5px，虚线圈几乎相切，三个点读成一条虚线带；
 *  ② 三条虚线都从圆心发出、方向只差 2.4°，各取 60 个采样点两两比距离，
 *     56%~61% 的采样点上两条线的墨迹是叠着的——看上去不是三条线，是一坨。
 *  所以：间距放到 12（点之间留 3.6 的空），柄收成一根（悬空目标彼此没有区别，
 *  区别只在 tooltip 文字里，画三条线并不比画一条多传达任何东西）。
 *  环、节点、字号、点的半径与虚线样式仍然是原型的值。 */
const STUB_TOP = 74
const STUB_STEP = 12
/** 脊的位置：正好落在点的左沿（34 - 3.4 - 0.8 = 29.8），让点像是串在脊上 */
const STUB_STEM_X = 30
const STUB_DOT_X = 34

/** 悬空短枝的条数上限，是几何算出来的：第 i 个点画在 CY + STUB_TOP + i*STUB_STEP、
 *  半径 3.4、线宽 1.6，下沿要留在画布内 ⇒ 108 + 74 + 12i + 3.4 + 0.8 ≤ 214.5（H - 1.5），
 *  i 最大到 2，所以条数是 3。i = 3 时下沿到 222，整个点会被画布切掉——原型 186 高的画布
 *  （CY=93）上就是这个下场：那条「还有 N 条没画」的计数一并画到画布外，等于从来没显示过。
 *  改 STUB_TOP / STUB_STEP / H 任何一个都要重算这个数。 */
const MAX_STUBS = 3

const stubY = (i: number): number => CY + STUB_TOP + i * STUB_STEP

interface Placed {
  node: GraphNode
  x: number
  y: number
  /** 极角，用来决定标签朝哪边排 */
  angle: number
  radius: number
}

/** 同心环静态布局。刻意不做力导向每帧重排：一帧几毫秒的 CPU 换来的是一张
 *  每次刷新都长得不一样的图，用户记不住「上次那个点在哪儿」。
 *
 *  返回值里的 `overflow` 是被折掉的那些：`count` 个数字、最深在 `maxDepth` 跳。
 *  丢弃它的旧写法是 bug（见上面 MAX_NODES 那段）。 */
function layout(graph: LocalGraph): { placed: Placed[]; overflow: { count: number; maxDepth: number } } {
  const sorted = [...graph.nodes].sort((a, b) => a.depth - b.depth)
  const keep = sorted.slice(0, MAX_NODES)
  const dropped = sorted.slice(MAX_NODES)
  const overflow = {
    count: dropped.length,
    maxDepth: dropped.reduce((m, n) => Math.max(m, n.depth), 0),
  }

  const rings = new Map<number, GraphNode[]>()
  for (const n of keep) {
    const arr = rings.get(n.depth) ?? []
    arr.push(n)
    rings.set(n.depth, arr)
  }

  const out: Placed[] = []
  for (const [depth, arr] of rings) {
    const radius = depth === 1 ? R1 : R2
    arr.forEach((node, i) => {
      // 第二环整体偏半格，免得正好卡在第一环两个点的连线上
      const angle = -Math.PI / 2 + i * ((2 * Math.PI) / arr.length) + (depth > 1 ? Math.PI / arr.length : 0)
      out.push({ node, x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle), angle, radius })
    })
  }
  return { placed: out, overflow }
}

function labelOf(text: string): string {
  return fitLabel(text, 13)
}

const FONT_SIZE = 7
/** 7px 字体下宽/窄字符的实宽，拿 getBBox 量过两个标签校准的（宁可略高估） */
const WIDE_PX = 7.2
const NARROW_PX = 3.5
/** 标签贴到画布边上就等于没有边距，留一点 */
const PAD = 1.5

type Anchor = 'start' | 'middle' | 'end'

/** 这张 300×216 画布自己的度量。截断与估宽的**规则**在 `graphLabel.ts`，与全屏图谱共用一份：
 *  两处各写一份的话，同一个标题会在一边被切成「9 月 1…」、另一边切成「9 月 16…」 */
function textWidth(text: string): number {
  return textWidthOf(text, WIDE_PX, NARROW_PX)
}

function anchorOf(angle: number): Anchor {
  const cos = Math.cos(angle)
  return cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle'
}

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

function boxOf(x: number, y: number, width: number, anchor: Anchor): Box {
  const left = anchor === 'start' ? x : anchor === 'end' ? x - width : x - width / 2
  // 基线到字框上下沿：7px 汉字实测上探 8.3、下探 2.1（上下都按实测值放，宁可保守）
  return { left, right: left + width, top: y - FONT_SIZE * 1.2, bottom: y + FONT_SIZE * 0.3 }
}

function inside(b: Box): boolean {
  return b.left >= PAD && b.right <= W - PAD && b.top >= PAD && b.bottom <= H - PAD
}

/** 标签一律排在节点外侧（径向朝外），首选就是第①个位置。
 *  ②内侧、③节点正上/正下方是兜底，按 300×216 算其实够用，留着的理由只有一个：
 *  textWidth 是按字符宽度估的（宽字 7.2px / 窄字 3.5px），拿不到真实字形度量，
 *  换个没有 --font-ui 的系统、或者冒出个超宽字形，估算就会偏小；
 *  真偏了由兜底接住，宁可标签翻到环内也不要被画布切掉半个字。 */
function placeLabel(p: Placed, text: string): { x: number; y: number; anchor: Anchor } {
  const width = textWidth(text)
  const middle = Math.sin(p.angle) >= 0
  const candidates: Array<{ x: number; y: number; anchor: Anchor }> = [
    {
      x: CX + (p.radius + 12) * Math.cos(p.angle),
      y: CY + (p.radius + 12) * Math.sin(p.angle) + 2.4,
      anchor: anchorOf(p.angle),
    },
    {
      x: CX + (p.radius - 12) * Math.cos(p.angle),
      y: CY + (p.radius - 12) * Math.sin(p.angle) + 2.4,
      anchor: anchorOf(p.angle),
    },
    { x: p.x, y: middle ? p.y - 10 : p.y + 12, anchor: 'middle' },
  ]
  for (const c of candidates) if (inside(boxOf(c.x, c.y, width, c.anchor))) return c
  return candidates[2]
}

const NODE_CLASS: Record<GraphNode['type'], string> = {
  diary: 'n-diary',
  article: 'n-article',
  topic: 'n-topic',
}

export function GraphView({
  graph,
  onOpen,
}: {
  graph: LocalGraph
  onOpen: (key: string) => void
}): JSX.Element {
  const { placed, overflow } = layout(graph)
  // 中心不在 placed 里（它永远画在正中央），但边要能查到它的坐标——
  // 漏掉这一步，所有连到中心的边都会被当成「两端不全」而静默丢掉，
  // 图上就只剩一圈孤零零的点和几根悬空短枝。
  const pos = new Map(placed.map((p) => [p.node.key, p]))
  pos.set(graph.center.key, { node: graph.center, x: CX, y: CY, angle: 0, radius: 0 })
  const stubs: DanglingLink[] = graph.dangling.slice(0, MAX_STUBS)
  const hiddenStubs = graph.dangling.length - stubs.length

  return (
    <>
      <div className="graph-wrap">
        <svg className="graph" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="局部知识图谱">
          {graph.edges.map((edge, i) => {
            const a = pos.get(edge.source)
            const b = pos.get(edge.target)
            if (!a || !b) return null
            return (
              <line
                key={`e${i}`}
                className={`g-edge k-${edge.kind}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
              />
            )
          })}

          {stubs.length > 0 && (
            <line
              className="g-edge k-dangling"
              x1={CX}
              y1={CY}
              x2={CX + STUB_STEM_X}
              y2={stubY(Math.floor((stubs.length - 1) / 2))}
            />
          )}
          {stubs.length > 1 && (
            <line
              className="g-edge k-dangling"
              x1={CX + STUB_STEM_X}
              y1={stubY(0)}
              x2={CX + STUB_STEM_X}
              y2={stubY(stubs.length - 1)}
            />
          )}

          {stubs.map((d, i) => (
            <circle
              key={`d${d.raw}${i}`}
              className="g-node dangling"
              cx={CX + STUB_DOT_X}
              cy={stubY(i)}
              r={3.4}
            >
              <title>{`${d.alias ?? d.raw} · 还没写`}</title>
            </circle>
          ))}
          {hiddenStubs > 0 && (
            <text
              className="g-label"
              x={CX + STUB_DOT_X + 12}
              y={stubY(stubs.length - 1) + 2.4}
              textAnchor="start"
            >
              {`+${hiddenStubs}`}
            </text>
          )}

          {/* 被折掉的那些邻居：画成一个空心虚线圈 + `+N`，不可点（没有目标可跳）。
              位置定在最外环外的右上 45°，与悬空短枝（右下那束）分处两侧，不会读成同一类东西 */}
          {overflow.count > 0 &&
            (() => {
              const angle = -Math.PI / 4
              const radius = R2 + 16
              const x = CX + radius * Math.cos(angle)
              const y = CY + radius * Math.sin(angle)
              return (
                <g>
                  <circle className="g-node overflow" cx={x} cy={y} r={5}>
                    <title>{`还有 ${overflow.count} 个，都在第 ${overflow.maxDepth} 跳外`}</title>
                  </circle>
                  <text className="g-label" x={x + 9} y={y + 2.4} textAnchor="start">
                    {`+${overflow.count}`}
                  </text>
                </g>
              )
            })()}

          <circle
            className={`g-node ${NODE_CLASS[graph.center.type]} center`}
            cx={CX}
            cy={CY}
            r={8}
          >
            <title>{`${graph.center.label} · 当前这篇`}</title>
          </circle>

          {placed.map((p) => {
            const text = labelOf(p.node.label)
            const at = placeLabel(p, text)
            return (
              <g key={p.node.key}>
                <circle
                  className={`g-node ${NODE_CLASS[p.node.type]}`}
                  cx={p.x}
                  cy={p.y}
                  r={5}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(p.node.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onOpen(p.node.key)
                    }
                  }}
                >
                  <title>{`${p.node.label} · 点一下跳过去`}</title>
                </circle>
                <text className="g-label" x={at.x} y={at.y} textAnchor={at.anchor}>
                  {text}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      <div className="graph-legend">
        <span>
          <i className="lg lg-wiki" />
          双链
        </span>
        <span>
          <i className="lg lg-dangling" />
          还没写
        </span>
        <span>
          <i className="lg lg-diary" />
          日记
        </span>
        <span>
          <i className="lg lg-article" />
          文章
        </span>
        <span>
          <i className="lg lg-topic" />
          主题
        </span>
      </div>
    </>
  )
}