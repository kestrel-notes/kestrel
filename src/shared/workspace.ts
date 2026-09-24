/** 工作区（期-09a）：开着哪几篇、哪一个在当前、各自滚到哪儿、光标在哪儿。
 *
 *  为什么不并进 `Settings`（`main/db/settings.ts` 的 `coerce`）：
 *  1. 失效规则不一样。设置里某一项读坏了是「那一项回默认」；工作区读坏了是「整个当没有」，
 *     退回今天。把两件事写进同一个 `coerce`，早晚会写成「工作区坏了顺手把主题也重置了」。
 *  2. `patchSettings` 每调一次就把整个 `Settings` 读改写一遍（`store.ts:1290`）。
 *     而工作区是**每切一次标签都要写**的东西（一次 4.3 ms，见 设计稿 §〇 M4）。
 *
 *  所以这里是独立的一份：`main/db/workspace.ts` 存 `Setting` 表里 `key='workspace'` 那一行，
 *  走 `workspace:load` / `workspace:save` 两条通道，不过 `settings:patch`。 */

export interface WorkspaceTab {
  entryId: number
  /** 固定的标签排在最前，且不吃 `Ctrl+W`（§一） */
  pinned: boolean
  /** 切走那一刻的 scrollTop（px）。设计稿 §〇 M2：今天完全不恢复 */
  scroll: number
  /** ProseMirror 文档坐标下的光标。`null` = 这一篇没有光标 ⇒ 回来时不抢焦点。
   *  这里只保证是整数，**不夹上界**：那一棵实例才知道自己这篇多长（§二） */
  anchor: number | null
  head: number | null
  /** 切走那一刻焦点确实在正文里。恢复时用它决定要不要把焦点还回去（§〇 M3、决策 35） */
  focused: boolean
}

export interface Workspace {
  v: 1
  tabs: WorkspaceTab[]
  /** 当前那一个标签是哪一篇。**存 entryId 不存下标**：一篇一个标签（决策 31），
   *  所以它是唯一键；而「丢掉几个坏标签之后下标还对不对」是要额外操心的一件事，不值 */
  activeEntryId: number
}

export const WORKSPACE_VERSION = 1

const 是整数 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v)

/** 只认非负整数，别的贴到 0：滚动位置错了不该拖垮整个工作区 */
const 非负 = (v: unknown): number => (是整数(v) && v >= 0 ? v : 0)

export function makeTab(entryId: number): WorkspaceTab {
  return { entryId, pinned: false, scroll: 0, anchor: null, head: null, focused: false }
}

function 一个标签(raw: unknown): WorkspaceTab | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (!是整数(o.entryId) || o.entryId <= 0) return null
  const 有光标 = 是整数(o.anchor) && 是整数(o.head)
  return {
    entryId: o.entryId,
    pinned: o.pinned === true,
    scroll: 非负(o.scroll),
    anchor: 有光标 ? (o.anchor as number) : null,
    head: 有光标 ? (o.head as number) : null,
    focused: 有光标 && o.focused === true,
  }
}

/** 固定的挪到最前，两档内部各自保持原顺序——界面上看到的就是这个顺序 */
export function sortTabs(tabs: WorkspaceTab[]): WorkspaceTab[] {
  return [...tabs].sort((a, b) => Number(b.pinned) - Number(a.pinned))
}

/** 从盘上读回来的那一份 → 能用的工作区，或者 `null`（= 当没有，界面退回今天）。
 *  `alive` 是当下没进回收站的那批 id：库里已经删掉的那一篇，标签自己消失，其余不动。
 *
 *  一律当不可信输入：这一行可能被手改过、被旧版本写过、从别的机器整库换过来。
 *  「猜一个能用」比「当没有」危险——猜错了会把用户送到他以为丢了的那一篇上去。 */
export function parseWorkspace(raw: unknown, alive: Set<number>): Workspace | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== WORKSPACE_VERSION) return null
  if (!Array.isArray(o.tabs)) return null

  const 见 = new Set<number>()
  const tabs: WorkspaceTab[] = []
  for (const 项 of o.tabs) {
    const t = 一个标签(项)
    if (!t || !alive.has(t.entryId) || 见.has(t.entryId)) continue
    见.add(t.entryId)
    tabs.push(t)
  }
  if (tabs.length === 0) return null

  const 排好的 = sortTabs(tabs)
  const 活动 = 是整数(o.activeEntryId) && 见.has(o.activeEntryId) ? o.activeEntryId : 排好的[0].entryId
  return { v: WORKSPACE_VERSION, tabs: 排好的, activeEntryId: 活动 }
}

export function emptyWorkspace(entryId: number): Workspace {
  return { v: WORKSPACE_VERSION, tabs: [makeTab(entryId)], activeEntryId: entryId }
}
