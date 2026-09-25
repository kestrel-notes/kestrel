/** 期-05d · 悬浮预览那一张卡：按住 `Ctrl` 停在正文里那条 `[[双链]]` 上 150ms，弹一张卡。
 *
 *  三件事决定了它的形状，都写在 `docs/期-05-设计稿.md` §十一：
 *  1. **一张全局单例**挂在 `App` 上，而不是每个链接自己长一张。9a 之后编辑器实例是复用的，
 *     隐藏的标签页里那些 NodeView 还活着——各处一张就是屏幕上叠两三张。
 *  2. **卡片不接鼠标**（CSS 上 `pointer-events: none`）。它弹在链接正下方，接了鼠标就会
 *     吞掉一次本该落在正文上的点击。
 *  3. **取数走 `window.kestrel.links.preview` 直接问主进程**，不进 store：那一张卡是
 *     一次性读数，进 store 就要为它写"什么时候该重算"，而那正是本档要避免的事
 *     （同一条约定见 `wikiComplete.tsx:74`、`queryBlock.ts:130`）。
 *
 *  手势只有"先按住 `Ctrl` 再移上去"这一种。已经停在链接上再按 `Ctrl` 不弹——那要监听全局
 *  keydown，而 `Ctrl+…` 这一族在命令表里早已是别的快捷键（§11.3-4）。作为交换，
 *  **松开 `Ctrl` 立刻收**：不该留在屏上的东西跟着人走是最烦的。 */

import { useEffect, useState, type JSX } from 'react'
import { formatMonthDayZh } from '../../../shared/date'
import type { PreviewAsk, PreviewCard } from '../../../shared/types'

/** 停多久才算"想看一下"。比这短的都是鼠标路过 */
const 停多久 = 150
/** 移开之后多久才收：在同一条链接上抖一下不该让卡闪 */
const 宽限 = 200
/** 同一条链接在这几毫秒内来回 hover 只问库一次。量的不是查询（µs 级），是不让鼠标来回动
 *  就来回发 IPC。过期就重问，所以改名/删除之后最迟 3 秒就能在卡上反映出来 */
const 新鲜多久 = 3000
const 缓存上限 = 40
const 卡宽 = 300
/** 画之前先估个数好决定翻不翻到上方（与 5b 那张菜单同一套算法），不是量出来的 */
const 卡高估计 = 104

interface 快照 {
  卡: PreviewCard
  top: number
  left: number
}

let 快照: 快照 | null = null
const 订阅们 = new Set<(s: 快照 | null) => void>()
/** 此刻被停上的那一个 DOM。收起时靠它判断"还在不在原处" */
let 当前: HTMLElement | null = null
let 弹时: ReturnType<typeof setTimeout> | null = null
let 收时: ReturnType<typeof setTimeout> | null = null
/** 每一次"换目标 / 收起"都进一号。晚到的取数结果对不上号就丢掉——
 *  否则鼠标已经移下一条了，卡上画的还是上一条（这条比"慢"更坏） */
let 序号 = 0
const 缓存 = new Map<string, { 卡: PreviewCard; 点: number }>()

function 发布(next: 快照 | null): void {
  快照 = next
  for (const f of 订阅们) f(next)
}

function 摘干净(): void {
  window.removeEventListener('keyup', 松了键, true)
  window.removeEventListener('scroll', 收起, true)
  window.removeEventListener('blur', 收起)
}

function 画上(el: HTMLElement, 卡: PreviewCard): void {
  const r = el.getBoundingClientRect()
  const 翻上 = r.bottom + 卡高估计 + 8 > window.innerHeight
  const top = Math.max(8, 翻上 ? r.top - 卡高估计 - 6 : r.bottom + 6)
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - 卡宽 - 8))
  发布({ 卡, top, left })
  window.addEventListener('keyup', 松了键, true)
  window.addEventListener('scroll', 收起, true)
  window.addEventListener('blur', 收起)
}

function 松了键(e: KeyboardEvent): void {
  if (e.key === 'Control') 收起()
}

export function 收起(): void {
  if (弹时) {
    clearTimeout(弹时)
    弹时 = null
  }
  if (收时) {
    clearTimeout(收时)
    收时 = null
  }
  当前 = null
  序号++
  发布(null)
  摘干净()
}

/** 那条链接现在被停上了。`取` 由编辑器实例给——**只有编辑/阅读那一份 bridge 有这根线**，
 *  幻灯片那一份没有，于是它的 NodeView 一个 mouseenter 监听都不挂（判据 7 的结构保证） */
export function 停上(el: HTMLElement, 问: PreviewAsk): void {
  if (收时) {
    clearTimeout(收时)
    收时 = null
  }
  if (当前 === el) return
  当前 = el
  if (弹时) clearTimeout(弹时)
  const 我 = ++序号
  弹时 = setTimeout(() => {
    弹时 = null
    void (async (): Promise<void> => {
      const 卡 = await 问库(问)
      if (我 !== 序号 || !当前 || 当前 !== el || !el.isConnected) return
      if (卡) 画上(el, 卡)
    })()
  }, 停多久)
}

/** 指针离开那一条链接。不立刻收：在同一条上抖一下不该让卡闪一下 */
export function 移开(el: HTMLElement): void {
  if (当前 !== el) return
  if (收时) clearTimeout(收时)
  收时 = setTimeout(收起, 宽限)
}

async function 问库(问: PreviewAsk): Promise<PreviewCard | null> {
  const 键 = `${问.nodeKey ?? '-'}|${问.key}`
  const 存 = 缓存.get(键)
  if (存 && Date.now() - 存.点 < 新鲜多久) return 存.卡
  try {
    const 卡 = await window.kestrel.links.preview(问)
    缓存.set(键, { 卡, 点: Date.now() })
    if (缓存.size > 缓存上限) 缓存.delete(缓存.keys().next().value as string)
    return 卡
  } catch {
    // 取不到就是不弹。一张弹不出来的卡不该变成一条错误提示，更不该是一声响铃
    return null
  }
}

/** 测试与实机探针用的那一道口子：现在屏上有没有卡、画的是哪一格 */
export function 当前卡片(): PreviewCard | null {
  return 快照?.卡 ?? null
}

const 种类字: Record<PreviewCard['是'], string> = {
  diary: '日记',
  article: '文章',
  topic: '主题',
  dangling: '还没有这一篇',
}

function 最后一行(卡: PreviewCard): string {
  if (卡.是 === 'topic') {
    return 卡.最近 ? `圈着 ${卡.数} 篇 · 最近一篇 ${formatMonthDayZh(卡.最近)}` : `圈着 ${卡.数} 篇`
  }
  if (卡.是 === 'dangling') {
    return 卡.最近 ? `这个写法被写了 ${卡.数} 处 · 最近一次在 ${formatMonthDayZh(卡.最近)}` : `这个写法被写了 ${卡.数} 处`
  }
  return 卡.数 === 0 ? '还没有别处指着它' : `被 ${卡.数} 处指向`
}

export function HoverPreviewCard(): JSX.Element | null {
  const [snap, setSnap] = useState<快照 | null>(null)
  useEffect(() => {
    订阅们.add(setSnap)
    setSnap(快照)
    return () => {
      订阅们.delete(setSnap)
    }
  }, [])
  if (!snap) return null
  const { 卡 } = snap
  return (
    <div className="hp-card" style={{ top: snap.top, left: snap.left, width: 卡宽 }} aria-hidden="true">
      <div className="hp-name">
        <span className="hp-label">{卡.名字}</span>
        <span className={`hp-kind hp-${卡.是}`}>{种类字[卡.是]}</span>
      </div>
      {卡.那截 ? (
        <div className="hp-snip">{卡.那截 + (卡.截了 ? '…' : '')}</div>
      ) : 卡.只有标题 ? (
        <div className="hp-snip hp-thin">这一篇除了标题没有别的</div>
      ) : 卡.是 === 'dangling' ? (
        <div className="hp-snip hp-thin">点它不会动 —— 库里还没有哪一篇叫这个</div>
      ) : null}
      <div className="hp-meta">{最后一行(卡)}</div>
    </div>
  )
}
