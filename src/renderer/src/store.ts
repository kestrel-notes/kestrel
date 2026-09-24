import { create } from 'zustand'
import { addDays, dateKey, formatDateZh, shiftYears, todayKey } from '../../shared/date'
import { normalizeLinkKey, parseLinks } from '../../shared/links'
import { crossYearHits, type PastCandidate } from '../../shared/chronicle'
import { isTagName, normalizeTagKey } from '../../shared/tags'
import { PROP_TYPE_LABEL, type PropValue } from '../../shared/props'
import { expandTemplate } from '../../shared/template'
import { roundTrip } from '@/editor/markdown'
import { getRichEditor } from '@/editor/richView'
import type { PropConversion, PropType } from '../../shared/types'
import {
  DEFAULT_SETTINGS,
  type Backlink,
  type Bookmark,
  type BookmarkKind,
  type CrossYearHit,
  type DayCount,
  type Entry,
  type EntrySummary,
  type LocalGraph,
  type OutgoingLink,
  type PromoteInput,
  type PropKeyInfo,
  type PropValueGroup,
  type RenameImpact,
  type Revision,
  type RevisionSummary,
  type SavedQuery,
  type SearchOrder,
  type Settings,
  type TagNode,
  type Template,
  type Topic,
  type TopicPatch,
} from '../../shared/types'

/** 侧栏的视图（期-02-设计 §3.1）。「今天 / 主题」是**写作现场**（该写哪一篇），
 *  「标签」与 §3.3 那第四格是**回头看**（按标签 / 按属性筛全库）：
 *  两类不是一个东西，所以标题栏那几格不平均分配视觉权重。 */
export type ViewMode = 'diary' | 'topic' | 'tag' | 'prop'
/** 属性视图（§3.3）钻到哪一层了。数组长度就是层数，所以不需要额外的 `at`：
 *  `[]` 在第一级（属性名列表）、`[{name}]` 在第二级（值分组）、
 *  `[{name}, {name, value}]` 在第三级（该组条目，`value === null` 是「未填」那一组）。 */
export interface PropCrumb {
  name: string
  value: string | null
}
/** 同一个 Palette 组件的两种模式：一个找命令，一个找记录 */
export type PaletteMode = 'command' | 'switch'
/** 搜索面板点中一行后要干的事（期-03 §4.4）。两种编辑器各要一样，所以两样都带：
 *  `pos` 是 Markdown 原文里的下标（源码模式用），`needle` 是命中的那串字
 *  （所见即所得用——那边 DOM 里没有语法字符，偏移对不上）。
 *  只命中标题时两个都是 null，那就是「只打开、不定位」 */
export interface SearchJump {
  entryId: number
  pos: number | null
  needle: string | null
  /** 请求号。与 headingJump 同一个道理：连点同一行也要能再滚一次 */
  at: number
}
/** 编辑器的三种模式（期-04 §4.1）。**只有源码模式是无损的**：另外两档都要经过
 *  Markdown → 富文本树 → Markdown 的往返（reading 挂同一棵 ProseMirror，只是
 *  `editable: false`），所以切过去/在打开时停在那一档都要通过 roundTrip() 那道闸门。
 *  不持久化：它更像「当前这篇怎么编辑/怎么看」而不是一条偏好，且遇到闸门过不去的文档
 *  会被拽回源码模式，记住它没有意义。 */
export type EditorMode = 'rich' | 'source' | 'reading'
export type SaveState = 'saved' | 'saving' | 'error'

/** 确认弹层上要写的那三句话。原来这两处是 `window.confirm`，一句话塞满所有信息：
 *  系统对话框不受设计系统管，长句子换行、按钮文案都对不上玻璃层。
 *  拆成三个字段是因为**标题问「做什么」、正文说「后果」**这两件事本来就不该挤在一行里。 */
export interface ConfirmRequest {
  title: string
  body: string
  confirmLabel: string
  /** 默认「取消」。 destructive 的那一种不另设第三颗按钮 */
  cancelLabel?: string
}

/** 热力图窗口：最近 26 周，约半年 */
const HEAT_WEEKS = 26
/** 自动保存防抖。500ms 是打字停顿与「丢字风险」的折中 */
const SAVE_DEBOUNCE_MS = 500
const RECENT_LIMIT = 30
/** 「最近记录」每次多取这么多条。列表照 30 条一屏算，滚到底就再取一页 */
const RECENT_PAGE = 30
/** 标签下的条目列表也用同一套「滚到底再取一页」，页宽一致省一套规则 */
const TAG_PAGE = 30
/** 属性视图的第三级也是这个页宽（§3.3） */
const PROP_PAGE = 30
/** 快速切换一次拉这么多条候选。它要的只是"最近写过的那些"，
 *  几千条的库上再往上加没有意义——那种体量该用搜索（第 3 期） */
const SWITCH_LIMIT = 200

export interface AppState {
  ready: boolean
  bootError: string | null
  toast: string | null

  settings: Settings
  prefersDark: boolean

  mode: ViewMode
  currentId: number | null
  entry: Entry | null
  title: string
  content: string
  /** 本地有未落库的改动 */
  dirty: boolean
  saveState: SaveState
  savedAt: string | null
  saveError: string | null
  /** 每次编辑自增，用来判断一次保存期间是否又发生了新编辑 */
  rev: number

  recent: EntrySummary[]
  topics: Topic[]
  activeTopicId: number | null
  articles: EntrySummary[]
  /** 主题管理那张 sheet（§3.5）。列表本身就是 `topics`，所以这里只记开关 */
  topicSheetOpen: boolean
  /** 正在改名的那一个主题。改名要先把代价算给人看（§8-D4），所以它是弹层的状态 */
  topicRename: { id: number; from: string } | null
  heat: DayCount[]

  /** 标签树（侧栏第三格）。整棵一次取全，几百个标签的量级不必分页 */
  tags: TagNode[]
  /** 树上选中的那一个，null = 还没选。下面的条目列表就是它 */
  activeTagId: number | null
  /** 选中标签（含子孙）下的条目 */
  tagRows: EntrySummary[]
  /** 取到第几条了。滚到底 +30，与 recentLimit 同一个套路 */
  tagLimit: number
  /** 用户手动折叠/展开过的标签：`name → 是否展开`。
   *  没在这个表里的按默认规则走（根节点展开、其余折起），所以重画树不会把用户的手势抹掉 */
  tagFold: Record<string, boolean>
  /** 正在改名的标签名，null = 弹层关着 */
  tagRename: string | null
  /** 「焦点给标签树」的触发器（§6 的 `Ctrl+Shift+T`）。命令那一侧只改得动状态，
   *  DOM 焦点得由看着那棵树的组件去给，所以拿递增计数当信号 */
  tagTreeFocus: number

  /** 属性名 → 类型的全局绑定。右栏面板要按类型挑控件，而读它这一次顺带把
   *  `props` 里没登记过的名字补登记了（§4.3 的懒登记） */
  propKeys: PropKeyInfo[]
  /** 正在确认「改类型」的那一个（会过一遍全库的值，所以动手前要先问），null = 关着 */
  propConvert: { name: string; to: PropType } | null

  /** 属性视图（§3.3）的下钻位置，见 PropCrumb */
  propCrumb: PropCrumb[]
  /** 第二级：当前属性的值分组（含「未填」那一组） */
  propGroups: PropValueGroup[]
  /** 第三级：当前那一组的条目 */
  propRows: EntrySummary[]
  /** 取到第几条了。滚到底 +30，与 tagLimit 同一个套路 */
  propLimit: number

  /** 当前这篇的知识网络：谁指向我，以及 N 跳内的邻居 */
  backlinks: Backlink[]
  graph: LocalGraph | null
  /** 当前这篇指向谁。编辑器给正文里的 [[双链]] 分型着色靠它（§9.1） */
  outgoing: OutgoingLink[]

  editorMode: EditorMode
  /** 上一次切模式的说明：规范化了什么，或为什么没切过去 */
  gateNote: string | null
  /** gateNote 是不是「没切过去」 */
  gateBlocked: boolean

  focus: boolean
  sheetOpen: boolean

  /** 命令面板 / 快速切换（同一个组件两种数据源），null = 关着 */
  palette: PaletteMode | null
  /** 快速切换的候选池，打开时才拉 */
  switchRows: EntrySummary[]

  /** 搜索面板（期-03 §4.1）。这里只存「开没开」与定位请求：查询串、防抖、
   *  结果与轮询都是面板自己的事，与 Palette 把 query/cursor 放在组件里同一个口径。
   *  往 store 搬一套只会多出第二份真相 */
  searchOpen: boolean
  /** 三档排序（期-06b-2 §三）。放在 store 而不是面板里：面板一关就卸载，
   *  而"我习惯看哪一档"这件事不该每次进来重挑。刻意不落 Setting——
   *  §三 说的是"面板上一个可点的段控件"，做成设置项就变成两层界面才能改的东西 */
  searchOrder: SearchOrder
  /** 搜索结果的「定位到命中处」请求。`entryId` 用来拒绝上一篇文章的迟到请求，
   *  `at` 与 headingJump 同样是请求号：连点同一行也要能再滚一次 */
  searchJump: SearchJump | null

  /** 升格弹层（日记 → 文章） */
  promoteOpen: boolean
  /** 回收站：列表常驻内存，标题栏入口靠它的条数决定显不显示 */
  binOpen: boolean
  binRows: EntrySummary[]

  /** 收藏（§3.4）：整张表常驻内存，理由与回收站那格一样——标题栏那一格要按条数显隐。
   *  个人量级下这就是几十行，没有分页可言 */
  bookmarkOpen: boolean
  bookmarks: Bookmark[]

  /** 全屏图谱覆盖层（期-06a）。拓扑**不进 store**：开层现查（实测全库 22ms），
   *  进来就要管「保存一条就脏」的失效，不划算（设计稿决策 D10）。
   *  `graphMode` 是例外：它是用户挑的看法，不是数据 */
  graphOpen: boolean
  graphMode: 'force' | 'time'

  /** 当前这篇的历史版本（列表不带正文） */
  versions: RevisionSummary[]
  /** 正在预览的那一版，含正文 */
  versionOf: Revision | null

  /** 某天升格出来的文章。日记页那条「已升格」横幅靠它 */
  promotedOnDate: EntrySummary[]

  /** 跨年同日的卡（期-06b-2 §二）。只在**打开日记那一刻**算一次：
   *  一边写一边重算会把用户刚敲进去的标签当成新提示反复弹，那就不是静默卡了 */
  crossYear: CrossYearHit[]

  /** 存查询与模板两份列表（期-07 §四、§五）。两张表都是几十行的量级，一次取全，
   *  不做分页也不做缓存失效判断——管理面板开着时改一条就整个重取 */
  savedQueries: SavedQuery[]
  templates: Template[]
  /** 「查询与模板」管理面板 */
  libraryOpen: boolean
  /** 「流通」面板：导出整库 / 从导出物导入 / 备份（期-08 §九） */
  transferOpen: boolean
  transferTab: 'export' | 'import' | 'backup'
  /** 流通面板正在写盘/写库。Esc 要不要放过这一档，判据在 `App.tsx` 那条链上——
   *  主进程不会因为面板关了就在半路停手，关了只会让人以为「取消了」而看不见写到哪了 */
  transferBusy: boolean

  /** 大纲点击 → 编辑器滚动。存的是自增的请求号，编辑器听着它滚一次 */
  headingJump: { index: number; at: number } | null
  /** 编辑器回报的「当前所在的标题序号」，右栏用它高亮 */
  activeHeading: number | null

  /** 「最近记录」当前取多少条。滚动到底 +30 */
  recentLimit: number
  /** 确认弹层（替代原生 `window.confirm`），null = 关着 */
  confirm: ConfirmRequest | null
  init(): Promise<void>
  setMode(mode: ViewMode): Promise<void>
  openDate(date: string): Promise<void>
  openEntry(id: number): Promise<void>
  openNode(key: string): Promise<void>
  newArticle(): Promise<void>
  removeCurrent(): Promise<void>
  setTitle(title: string): void
  setContent(content: string): void
  flush(): Promise<void>
  selectTopic(id: number): Promise<void>
  createTopic(name: string): Promise<void>
  setTopicSheetOpen(open: boolean): void
  setTopicRename(target: { id: number; from: string } | null): void
  /** 改名前的干跑：正文里还写着 `[[旧名]]` 的有几篇、几处 */
  topicImpact(from: string): Promise<RenameImpact>
  /** 改名。`rewriteLinks` 是 §8-D4 那个勾选框，不勾则旧引用降级成悬空 */
  renameTopic(id: number, to: string, rewriteLinks: boolean): Promise<void>
  /** 图标 / 颜色 / 归档。名字不在这里改，见 `TopicPatch` */
  patchTopic(id: number, patch: TopicPatch): Promise<void>
  /** 删除主题。`detach` = 先把文章清空归属再删（内容一篇不动） */
  removeTopic(id: number, detach: boolean): Promise<void>
  /** ↑ / ↓：在同一层里与邻居换位置 */
  moveTopic(id: number, dir: -1 | 1): Promise<void>
  selectTag(id: number | null): Promise<void>
  /** 从正文里点 `#标签` 过来（§6）：编辑器只知道那一串字面写法，按归一后的名字在树上找 */
  selectTagName(name: string): Promise<void>
  /** 焦点给标签树那一格（§6 的 `Ctrl+Shift+T`） */
  focusTagTree(): void
  foldTag(name: string, open: boolean): void
  setTagRename(from: string | null): void
  /** 改名前先问代价：弹层那句「会改动 N 处 / M 篇」。与 renameTag 分开是因为**动手前**必须先看到它 */
  tagImpact(from: string): Promise<RenameImpact>
  renameTag(to: string): Promise<void>
  /** 读登记表（并触发主进程的补登记）。属性面板挂载、换文档、加/改属性之后各读一次 */
  refreshPropKeys(): Promise<void>
  /** 改当前这一篇的某个属性值。`value === null` 与空值一样是**删键**，不是塞 `null`（§3.2）。
   *  这是一次独立的落库，不走正文那条 500ms 防抖 */
  setProp(name: string, value: PropValue | null): Promise<void>
  /** 登记一个新属性名（同名已存在时主进程会改类型，所以改类型要走下面那条确认） */
  putPropKey(name: string, type: PropType): Promise<void>
  setPropConvert(target: { name: string; to: PropType } | null): void
  /** 改类型之前的 dry-run：几个能转换、几个会被丢、前三个样本 */
  propConvertReport(name: string, to: PropType): Promise<PropConversion>
  /** 确认后动手：改绑定 + 按新类型过一遍全库，然后重读当前这篇的 props */
  applyPropType(name: string, to: PropType): Promise<void>
  /** 属性视图的下钻（§3.3 的文件浏览器形态）：整条路径一次给，面包屑与列表都照它画 */
  setPropCrumb(crumb: PropCrumb[]): Promise<void>
  /** 右栏面板那一行的小按钮：跳到侧栏「属性」格并落在这个属性上（§10 第 8 项）。
   *  与 §3.3 共用同一份 propCrumb，不另起一套「当前按哪个属性看」 */
  openPropSide(name: string): Promise<void>
  patchSettings(patch: Partial<Settings>): Promise<void>
  switchEditorMode(mode: EditorMode): Promise<void>
  toggleFocus(): void
  setSheetOpen(open: boolean): void
  notify(msg: string): void
  /** 问一句「真的要做吗」，等到用户答完才 resolve。见 `ConfirmRequest` */
  askConfirm(req: ConfirmRequest): Promise<boolean>
  /** 弹层上的两个按钮 / Escape 都回到这里，`ok` 就是答案 */
  answerConfirm(ok: boolean): void

  openPalette(mode: PaletteMode): Promise<void>
  closePalette(): void
  /** `Ctrl+F`（期-03 §4.3）。与命令面板互斥地关掉对方：两个都是居中 sheet，同开会叠两层模糊 */
  openSearch(): void
  setSearchOrder(order: SearchOrder): void
  closeSearch(): void
  /** 点开一行搜索结果：先换文档再报定位请求。§4.4 要求「定位失败不影响打开」，
   *  所以这一步不接受任何来自编辑器的回执 */
  openSearchHit(entryId: number, pos: number | null, needle: string | null): Promise<void>
  setPromoteOpen(open: boolean): void
  promoteCurrent(input: PromoteInput): Promise<void>
  setBinOpen(open: boolean): void
  restoreDeleted(id: number): Promise<void>
  purgeEntry(id: number): Promise<void>
  setBookmarkOpen(open: boolean): void
  setGraphOpen(open: boolean): void
  setGraphMode(mode: 'force' | 'time'): void
  /** 跨年同日那张卡上的「连」：在正文末尾补一行 `[[那年那条]]`，走正常保存与重解析
   *  （期-06b-2 §二）。**不直接写 Link 表**——那条表是正文的派生物，绕开正文写进去的边，
   *  下一次保存就会被 `reparseEntry` 整删整插抹掉。 */
  connectCrossYear(hit: CrossYearHit): Promise<void>

  /* ── 查询块与模板（期-07） ── */

  /** 重取存查询与模板两份列表。库里两张新表都是几十行的量级，一次取全 */
  refreshLibrary(): Promise<void>
  /** 把正文里那截围栏存成一条查询。返回而不是抛错：这一步是控件里的一个按钮，
   *  名字撞了要就地回一句话，不是弹一个栈追踪 */
  saveQuery(name: string, body: string): Promise<{ ok: boolean; msg: string }>
  removeSaved(id: number): Promise<void>
  /** 插进正文：rich / reading 档走编辑器命令（落在光标处），源码档只能追加到末尾。
   *  `savedId` 只用来顺手把 `used_at` 推上去 */
  insertQuery(body: string, savedId?: number): Promise<void>
  createTemplate(input: { name: string; scope: 'diary' | 'article'; body: string; isDefault?: boolean }): Promise<void>
  updateTemplate(
    id: number,
    patch: { name?: string; body?: string; isDefault?: boolean }
  ): Promise<void>
  removeTemplate(id: number): Promise<void>
  /** 套用一条模板：先展开变量，再落到光标处（正文本来就空时就是整篇的开头） */
  applyTemplate(id: number): Promise<void>
  setLibraryOpen(open: boolean): void
  /** 「流通」面板的开关（期-08 §九）。面板自己负责取导出预览，这里只翻状态 */
  setTransferOpen(open: boolean): void
  /** 流通面板停在哪一档。命令面板里「导出」「导入」是两条命令，各自要把人带到自己那一档 */
  setTransferTab(tab: 'export' | 'import' | 'backup'): void
  setTransferBusy(busy: boolean): void
  /** 收藏 / 取消收藏某一样东西（当前这篇、sheet 里的某一行都走这一条）。
   *  `title` 只在新增那一次落库，是收藏那一刻的名字快照（§4.1） */
  toggleBookmark(kind: BookmarkKind, ref: number, title: string): Promise<void>
  /** 点 sheet 里的一行跳过去。回收站里的那条与指向空号的那条不跳，各给一句为什么 */
  openBookmark(bm: Bookmark): Promise<void>
  refreshVersions(): Promise<void>
  /** 手动存一版（Ctrl+S）：先落盘再记录，不受 5 分钟门槛约束 */
  snapshotManual(): Promise<void>
  previewVersion(id: number): Promise<void>
  closeVersion(): void
  restoreVersion(id: number): Promise<void>
  jumpToHeading(index: number): void
  setActiveHeading(index: number | null): void
  loadMoreRecent(): Promise<void>
  loadMoreTag(): Promise<void>
  loadMoreProp(): Promise<void>
}

let saveTimer: number | null = null
let toastTimer: number | null = null
/** 弹层欠用户的那一句回答。放在模块作用域而不是 state 里：它是一个待办的 resolve，
 *  不是要画出来的东西，进 state 只会让每次刷新都带上一个不可序列化的函数 */
let confirmResolve: ((ok: boolean) => void) | null = null
/** 「最近记录」分页在飞。滚动事件连着来，不拦的话几次调用会算出同一个 next、取回同一页 */
let loadingMore = false
/** 标签下的条目列表同理，各用各的闸门：两个列表能同时在滚 */
let loadingMoreTag = false
let loadingMoreProp = false

/** 上次算网络时的 (文档 + 标题 + 正文) 快照。
 *  打字时每 500ms 落一次盘，但正文没动就不该重画图——那是纯粹的闪烁。 */
let networkKey = ''

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // IPC 失败时 Electron 会加一层 "Error invoking remote method 'x':" 前缀，去掉它再给人看
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}

/** 在标签树上找一个节点。`id` 用来确认「选中的那个还在不在树上」，
 *  `name` 用来把选中态跟着改名搬过去——改名后旧标签 0 命中，会从树上掉下去。
 *  导出给侧栏用：它要按 id 反查选中那一行的名字当列表标题。 */
export function findTag(nodes: TagNode[], pred: (n: TagNode) => boolean): TagNode | null {
  for (const n of nodes) {
    if (pred(n)) return n
    const hit = findTag(n.children, pred)
    if (hit) return hit
  }
  return null
}

/** 主题的显示顺序：一层归档——父主题排它自己那一格，它的子主题紧跟其后。
 *  侧栏与管理 sheet 共用这一份排序，否则「↑ ↓ 换的是哪两个」两边说法不一。
 *  （入参 `topics` 已经按 `sort_order, name` 排好了，所以这里只做插入，不再排。） */
export function orderedTopics(topics: Topic[]): Topic[] {
  const out: Topic[] = []
  for (const t of topics) {
    if (t.parentId !== null) continue
    out.push(t, ...topics.filter((c) => c.parentId === t.id))
  }
  return out
}

/** 主题那一格的圆点颜色。`Topic.color` 存的是色板 token 名（`'tag-3'`），
 *  认不出来的值回落到 accent——那一列是 text，别让一个来历不明的值把整行点成透明。 */
export function topicColorVar(color: string | null): string {
  return color && /^tag-[1-8]$/.test(color) ? `var(--${color})` : 'var(--accent)'
}

export const useStore = create<AppState>()((set, get) => {
  /** 装载一篇记录为「当前编辑对象」。切文档前必须先 flush，见 setMode / openEntry */
  function applyEntry(entry: Entry): void {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }

    // 开一篇新文档也要过闸门：从这一篇的双链点进另一篇时，不会经过 switchEditorMode，
    // 要是那篇有文件树认不出的东西（比如一整块原始 HTML），所见即所得/阅读都会把它吃掉，
    // 用户下一次敲键保存就真的没了。宁可把他按在源码模式里。
    const mode = get().editorMode
    const gate = mode === 'rich' || mode === 'reading' ? roundTrip(entry.content) : null
    const blocked = gate !== null && !gate.lossless

    set({
      currentId: entry.id,
      entry,
      title: entry.title ?? '',
      content: entry.content,
      dirty: false,
      saveState: 'saved',
      savedAt: entry.updatedAt,
      saveError: null,
      rev: 0,
      editorMode: blocked ? 'source' : get().editorMode,
      gateNote: blocked ? `这一篇留在源码模式：非源码视图会丢 ${gate.lost.join('、')}` : null,
      gateBlocked: blocked,
    })
    // 换文档 = 网络整体换掉，快照作废（否则回看一篇内容相同的旧文档会拿上一次的结果糊弄）
    networkKey = ''
    void refreshNetwork()
    // 历史版本与「已升格」横幅也只看当前这一篇，一起重取
    void refreshVersions()
    void refreshPromotedOn()
    // 跨年同日：只在打开**日记**时算一次（§二）。不跟着每次保存重算——
    // 那件事正在被用户写着，一边写一边改他右栏那张卡是打扰，不是提示。
    void refreshCrossYear(entry)
    // 新建的那一篇自动套默认模板（期-07 §五「套用的时机」第一条）
    void autoApplyDefault(entry)
    // 这一篇的 props 里可能有从没登记过的名字（导入进来的），读一次登记表就补上了（§4.3）。
    // 人正停在属性那一格时，计数与当前这级的列表也要跟着换
    if (get().mode === 'prop') void refreshPropSide()
    else void get().refreshPropKeys()
  }

  /** 反链、图谱、出链一起取。三者都只看当前这一篇，一次 IPC 往返拿全。 */
  async function refreshNetwork(): Promise<void> {
    const { currentId, title, content } = get()
    if (currentId === null) {
      set({ backlinks: [], graph: null, outgoing: [] })
      return
    }
    const key = `${currentId}\u0000${title}\u0000${content}`
    if (key === networkKey) return

    try {
      const [backlinks, graph, outgoing] = await Promise.all([
        window.kestrel.links.backlinks(currentId),
        window.kestrel.links.graph(currentId, 2),
        window.kestrel.links.outgoing(currentId),
      ])
      // 查的过程中可能已经切走了，这份结果属于上一篇，扔掉
      if (get().currentId !== currentId) return
      networkKey = key
      set({ backlinks, graph, outgoing })
    } catch {
      // 网络只是右栏的附加信息，查不出来不该打断写作
      set({ backlinks: [], graph: null, outgoing: [] })
    }
  }

  /** 目标被认领之后强制重取（新建主题、改名、删掉目标）：落点变了，
   *  但 networkKey 只看正文，正文没动它就检测不到 */
  function refreshNetworkForced(): void {
    networkKey = ''
    void refreshNetwork()
  }

  /** 到点把改动落库。保存的是「发起这一刻的快照」，
   *  期间又打了字的话 rev 会变，那时不清 dirty，由下一次定时器接着存。 */
  async function flush(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const { currentId, dirty, title, content, rev } = get()
    if (currentId === null || !dirty) return

    set({ saveState: 'saving' })
    try {
      const updated = await window.kestrel.entries.update(currentId, {
        title: title.trim() === '' ? null : title,
        content,
      })
      const stillClean = get().rev === rev
      set({
        entry: updated,
        dirty: !stillClean,
        saveState: 'saved',
        savedAt: updated.updatedAt,
        saveError: null,
      })
      void refreshRecent()
      // 侧栏的文章卡片用的是摘要，改完标题不刷它就会一直停在「未命名文章」
      const { entry, activeTopicId } = get()
      if (entry?.kind === 'article' && activeTopicId !== null) void refreshArticles(activeTopicId)
      // 正文变了 = 出链变了：新写的 [[双链]] 立刻要出现在右栏里
      void refreshNetwork()
      // 这一版可能刚被记进历史（5 分钟门槛过了，或用户按了 Ctrl+S）
      void refreshVersions()
      // 刚敲下的 `#tag` 要立刻在树上出现（或让某个标签从 0 变 1 而冒出来）
      if (get().mode === 'tag') void refreshTagSide()
      // 属性那一格同理：正文里改不了属性，但这一版可能刚把某篇的分组挪走
      if (get().mode === 'prop') void refreshPropSide()
    } catch (err) {
      set({ saveState: 'error', saveError: errorMessage(err) })
    }
  }

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => void get().flush(), SAVE_DEBOUNCE_MS)
  }

  async function refreshRecent(): Promise<void> {
    set({ recent: await window.kestrel.entries.recent(get().recentLimit) })
  }

  async function refreshBin(): Promise<void> {
    set({ binRows: await window.kestrel.entries.listDeleted() })
  }

  /** 收藏整张表。列表只有几十行的量级，所以每次都取全，不做分页也不做增量 */
  async function refreshBookmarks(): Promise<void> {
    set({ bookmarks: await window.kestrel.bookmarks.list() })
  }

  /** 当前这篇的历史版本。查不出来不该打断写作，所以吞掉错误退化成空列表 */
  async function refreshVersions(): Promise<void> {
    const { currentId } = get()
    if (currentId === null) {
      set({ versions: [] })
      return
    }
    try {
      const rows = await window.kestrel.revisions.list(currentId)
      if (get().currentId !== currentId) return
      set({ versions: rows })
    } catch {
      set({ versions: [] })
    }
  }

  /** 日记页的「这一天已升格为《X》」横幅。文章页没有这条横幅 */
  async function refreshPromotedOn(): Promise<void> {
    const { entry } = get()
    if (!entry || entry.kind !== 'diary') {
      set({ promotedOnDate: [] })
      return
    }
    const date = entry.entryDate
    try {
      const rows = await window.kestrel.entries.listPromotedOn(date)
      if (get().entry?.entryDate !== date) return
      set({ promotedOnDate: rows })
    } catch {
      set({ promotedOnDate: [] })
    }
  }

  /** 跨年同日（期-06b-2 §二）：打开日记时算一次，只在共享标签或共享主题时出卡。
   *
   *  两次 `listByDate` 换掉一条新 IPC：判据要看两边的正文（标签就从正文里 `parseTags` 出来，
   *  与 `EntryTag` 同源），而正文本来就没有第二条更便宜的路能拿到。
   *  去年那天的条目若恰好就是这一篇（补记撞上同月同日）不提，自己提议连自己不是提示。 */
  async function refreshCrossYear(entry: Entry): Promise<void> {
    if (entry.kind !== 'diary') {
      set({ crossYear: [] })
      return
    }
    const back = [1, 2]
      .map((y) => ({ years: y, date: shiftYears(entry.entryDate, -y) }))
      .filter((x): x is { years: number; date: string } => x.date !== null)
    try {
      const lists = await Promise.all(back.map((x) => window.kestrel.entries.listByDate(x.date)))
      // 查的过程中已经切走了，这一份属于上一篇
      if (get().currentId !== entry.id) return
      const topics = get().topics
      const past: PastCandidate[] = lists
        .flatMap((rows, i) =>
          rows.map((e) => ({
            entryId: e.id,
            years: back[i].years,
            date: e.entryDate,
            kind: e.kind,
            title: e.title,
            topicId: e.topicId,
            topicName: topics.find((t) => t.id === e.topicId)?.name ?? null,
            content: e.content,
          }))
        )
        .filter((p) => p.entryId !== entry.id)
      set({
        crossYear: crossYearHits({ content: entry.content, topicId: entry.topicId }, past),
      })
    } catch {
      // 与反链同一口径：右栏的附加信息查不出来不该打断写作
      set({ crossYear: [] })
    }
  }

  /** 本会话已经判过「要不要自动套」的那几篇 id。判过就不判第二次，哪怕判的结果是没套 */
  const autoTplDone = new Set<number>()

  /** 新建那一篇自动套上 `scope` 对应的那条默认模板（期-07 §五）。
   *
   *  三条判据缺一不可：正文为空（套上去不覆盖任何东西）、`createdAt === updatedAt`
   *  （从没存过，也就是这一刻刚建出来）、这一篇本会话没套过（用户把模板内容删掉、
   *  留下一片空白再重开，那是他主动要的空白，不该又被塞回去）。 */
  async function autoApplyDefault(entry: Entry): Promise<void> {
    if (entry.content.trim() !== '' || entry.createdAt !== entry.updatedAt) return
    if (autoTplDone.has(entry.id)) return
    autoTplDone.add(entry.id)
    // 这一条判据用不得缓存：默认模板可能就是刚刚才建的那一条，而常驻那份是开应用时取的。
    // 「这一刻刚建出来的一篇」是罕见事件，为它多一趟 IPC 不亏
    await get().refreshLibrary()
    if (get().currentId !== entry.id) return
    const def = get().templates.find((t) => t.scope === entry.kind && t.isDefault)
    if (!def) return
    await get().applyTemplate(def.id)
  }

  async function refreshHeat(): Promise<void> {
    const to = todayKey()
    const from = addDays(to, -HEAT_WEEKS * 7 + 1)
    set({ heat: await window.kestrel.entries.countByDay(from, to) })
  }

  async function refreshArticles(topicId: number | null): Promise<void> {
    if (topicId === null) {
      set({ articles: [] })
      return
    }
    set({ articles: await window.kestrel.entries.listByTopic(topicId) })
  }

  /** 标签树。0 命中的标签主进程已经过滤掉了（§4.2 的孤儿规则），这里不补 */
  async function refreshTags(): Promise<void> {
    const rows = await window.kestrel.tags.tree()
    const { activeTagId } = get()
    // 选中的那个从树上掉了（改名，或最后一篇带它的记录进了回收站）就把下面的列表一起收掉：
    // 留着一张对不上任何一行的条目列表，比留空更难解释
    if (activeTagId !== null && !findTag(rows, (n) => n.id === activeTagId)) {
      set({ tags: rows, activeTagId: null, tagRows: [], tagLimit: TAG_PAGE })
      return
    }
    set({ tags: rows })
  }

  /** 选中标签下的条目（含子孙：`#a/b/c` 会给 a、a/b、a/b/c 各插一行，所以点父就能筛全子树）。
   *  带 id 守卫：连着点两行时，先回来的那一份不能盖掉后点的那一份 */
  async function refreshTagEntries(tagId: number | null): Promise<void> {
    if (tagId === null) {
      set({ tagRows: [] })
      return
    }
    const rows = await window.kestrel.tags.entries(tagId, get().tagLimit, 0)
    if (get().activeTagId !== tagId) return
    set({ tagRows: rows })
  }

  /** 改到正文或回收站之后把标签那一格整体刷新：树上的计数与选中的那条列表都得跟上 */
  async function refreshTagSide(): Promise<void> {
    await refreshTags()
    await refreshTagEntries(get().activeTagId)
  }

  async function refreshTopics(): Promise<void> {
    set({ topics: await window.kestrel.topics.list() })
  }

  /* ─ 属性视图（§3.3）。三级都从同一份 propCrumb 现算，所以刷新只要「照当前那一级重取」 */

  /** 第二级：一个属性的值分组。0 命中的属性不在这儿——第一级列的是登记过的名字，
   *  分组为空是正常状态（比如刚把最后一个值删掉），列表自己有空态 */
  async function refreshPropGroups(name: string | null): Promise<void> {
    if (name === null) {
      set({ propGroups: [] })
      return
    }
    const bucket = await window.kestrel.props.values(name)
    // 改名或删除把当前属性换掉了：先回来的那一份不能盖上新选中的
    if (get().propCrumb[0]?.name !== name) return
    set({ propGroups: bucket.groups })
  }

  /** 第三级：该组的条目。`crumb.length < 2` 时清空，别留着上一组的列表 */
  async function refreshPropEntries(crumb: PropCrumb[]): Promise<void> {
    if (crumb.length < 2) {
      set({ propRows: [] })
      return
    }
    const { name, value } = crumb[1]
    const rows = await window.kestrel.props.entries(name, value, get().propLimit, 0)
    const now = get().propCrumb
    if (now.length < 2 || now[1].name !== name || now[1].value !== value) return
    set({ propRows: rows })
  }

  /** 属性那一格整体刷新：第一级要的是登记表的计数，二、三级跟着当前路径重取 */
  async function refreshPropSide(crumb = get().propCrumb): Promise<void> {
    await get().refreshPropKeys()
    if (crumb.length === 0) {
      set({ propGroups: [], propRows: [] })
      return
    }
    await refreshPropGroups(crumb[0].name)
    await refreshPropEntries(crumb)
  }

  return {
    ready: false,
    bootError: null,
    toast: null,

    settings: DEFAULT_SETTINGS,
    prefersDark: false,

    mode: 'diary',
    currentId: null,
    entry: null,
    title: '',
    content: '',
    dirty: false,
    saveState: 'saved',
    savedAt: null,
    saveError: null,
    rev: 0,

    recent: [],
    topics: [],
    activeTopicId: null,
    articles: [],
    topicSheetOpen: false,
    topicRename: null,
    heat: [],
    tags: [],
    activeTagId: null,
    tagRows: [],
    tagLimit: TAG_PAGE,
    tagFold: {},
    tagRename: null,
    tagTreeFocus: 0,
    propKeys: [],
    propConvert: null,
    propCrumb: [],
    propGroups: [],
    propRows: [],
    propLimit: PROP_PAGE,
    backlinks: [],
    graph: null,
    outgoing: [],

    editorMode: 'rich',
    gateNote: null,
    gateBlocked: false,

    focus: false,
    sheetOpen: false,

    palette: null,
    switchRows: [],
    searchOpen: false,
    searchOrder: 'blend',
    searchJump: null,
    promoteOpen: false,
    binOpen: false,
    binRows: [],
    bookmarkOpen: false,
    graphOpen: false,
    graphMode: 'force',
    bookmarks: [],
    versions: [],
    versionOf: null,
    promotedOnDate: [],
    crossYear: [],
    savedQueries: [],
    templates: [],
    libraryOpen: false,
    transferOpen: false,
    transferTab: 'export',
    transferBusy: false,
    headingJump: null,
    activeHeading: null,
    recentLimit: RECENT_LIMIT,
    confirm: null,

    async init() {
      try {
        const settings = await window.kestrel.settings.all()
        set({ settings, prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches })

        window
          .matchMedia('(prefers-color-scheme: dark)')
          .addEventListener('change', (e) => set({ prefersDark: e.matches }))

        // 先确保今天的日记存在，再刷列表：否则刚建出来的当天日记不会出现在「最近记录」里
        const today = await window.kestrel.entries.ensureDiary(todayKey())
        applyEntry(today)

        await Promise.all([
          refreshRecent(),
          refreshHeat(),
          refreshTopics(),
          refreshBin(),
          refreshBookmarks(),
          get().refreshPropKeys(),
        ])
        set({ ready: true })
      } catch (err) {
        set({ bootError: errorMessage(err), ready: true })
      }
    },

    async setMode(mode) {
      if (mode === get().mode) return
      await get().flush()
      set({ mode })
      if (mode === 'diary') {
        await get().openDate(todayKey())
        return
      }
      // 标签 / 属性视图只换侧栏，不换中间那篇：它们是「回头看全库」的入口，不是「去写另一篇」
      if (mode === 'tag') {
        await refreshTagSide()
        return
      }
      if (mode === 'prop') {
        await refreshPropSide()
        return
      }
      const topicId = get().activeTopicId ?? get().topics[0]?.id ?? null
      set({ activeTopicId: topicId })
      await refreshArticles(topicId)
      if (topicId === null) {
        // 还没有任何主题：中间区留空，提示去侧栏建一个
        set({ entry: null, currentId: null, title: '', content: '', backlinks: [], graph: null })
      }
    },

    async openDate(date) {
      await get().flush()
      const entry = await window.kestrel.entries.ensureDiary(date)
      applyEntry(entry)
      set({ mode: 'diary' })
      void refreshHeat()
    },

    async openEntry(id) {
      if (get().currentId === id) return
      await get().flush()
      const entry = await window.kestrel.entries.get(id)
      if (!entry) {
        get().notify('这条记录已经不在了')
        await refreshRecent()
        return
      }
      applyEntry(entry)
      // 标签 / 属性视图的列表是一次查询结果：点一条就跳回「今天」，等于把用户刚点开的筛选扔了。
      // 「今天 / 主题」两格之间照旧跟着 kind 走
      if (get().mode !== 'tag' && get().mode !== 'prop') {
        set({ mode: entry.kind === 'article' ? 'topic' : 'diary' })
      }
    },

    /** 点图谱节点或反链行跳过去。键形如 `e:12` / `t:3`（见 main/db/links.ts） */
    async openNode(key) {
      const [prefix, rawId] = key.split(':')
      const id = Number(rawId)
      if (!Number.isFinite(id)) return

      if (prefix === 't') {
        // 主题不是文档，只能切到主题视图并选中它
        const topic = get().topics.find((t) => t.id === id)
        if (!topic) return
        await get().selectTopic(id)
        set({ mode: 'topic' })
        get().notify(`主题「${topic.name}」`)
        return
      }

      await get().openEntry(id)
      if (get().currentId !== id) return
      const jumped = get().entry
      get().notify(jumped?.title ? `跳到「${jumped.title}」` : '跳到那天的日记')
    },

    async newArticle() {
      const topicId = get().activeTopicId
      if (topicId === null) {
        get().notify('先在侧栏建一个主题')
        return
      }
      await get().flush()
      try {
        const entry = await window.kestrel.entries.create({
          kind: 'article',
          entryDate: todayKey(),
          title: '未命名文章',
          topicId,
        })
        applyEntry(entry)
        await Promise.all([refreshArticles(topicId), refreshTopics(), refreshRecent()])
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    async removeCurrent() {
      const { currentId } = get()
      if (currentId === null) return
      const row = get().entry
      const ok = await get().askConfirm({
        title: row ? `删掉「${entryLabel(row)}」？` : '删掉这条记录？',
        body: '它会进回收站，随时可以恢复；只有「彻底删除」才是真删。',
        confirmLabel: '删除',
      })
      if (!ok) return

      try {
        const isDiary = get().entry?.kind === 'diary'
        await window.kestrel.entries.remove(currentId)
        await Promise.all([refreshRecent(), refreshHeat(), refreshBin(), refreshTopics()])
        if (get().mode === 'topic') await refreshArticles(get().activeTopicId)
        // 少一篇 = 它身上那些标签各少一次计数，全为 0 的那一行还要从树上消失
        if (get().mode === 'tag') await refreshTagSide()
        // 属性那一格：少一篇，某个值分组的计数就要掉，整组空了那一行还要消失
        if (get().mode === 'prop') await refreshPropSide()
        get().notify('已移入回收站')
        if (isDiary) {
          const today = await window.kestrel.entries.ensureDiary(todayKey())
          applyEntry(today)
        } else {
          set({ entry: null, currentId: null, title: '', content: '', backlinks: [], graph: null, outgoing: [] })
        }
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    setTitle(title) {
      set((s) => ({ title, dirty: true, rev: s.rev + 1 }))
      scheduleSave()
    },

    setContent(content) {
      set((s) => ({ content, dirty: true, rev: s.rev + 1 }))
      scheduleSave()
    },

    flush,

    async selectTopic(id) {
      await get().flush()
      set({ activeTopicId: id })
      await refreshArticles(id)
    },

    async createTopic(name) {
      try {
        const topic = await window.kestrel.topics.create(name)
        await refreshTopics()
        set({ activeTopicId: topic.id })
        await refreshArticles(topic.id)
        set({ mode: 'topic' })
        // 正文里早就写着的 [[这个主题名]] 刚刚被认领，虚线要当场变药丸底
        refreshNetworkForced()
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    /* ─ 主题管理（§3.5） ─ */

    setTopicSheetOpen(open) {
      set({ topicSheetOpen: open })
      // 打开时重取一次：归属与计数可能已经被别的写路径改过，sheet 要照着库画
      if (open) void refreshTopics()
    },

    setTopicRename(target) {
      set({ topicRename: target })
    },

    async topicImpact(from) {
      return await window.kestrel.topics.impact(from)
    },

    async renameTopic(id, to, rewriteLinks) {
      const from = get().topicRename?.from ?? null
      set({ topicRename: null })
      if (from === null) return
      try {
        // 与标签改名同一条判据：当前这篇很可能正写着 `[[旧名]]`。先落盘，
        // 否则防抖里那份旧正文随后写回去，改名等于白做
        await get().flush()
        if (get().dirty) {
          get().notify('这一篇还没存上，先别改名')
          return
        }
        const impact = await window.kestrel.topics.rename(id, to, rewriteLinks)
        await refreshTopics()
        if (get().mode === 'topic') await refreshArticles(get().activeTopicId)
        refreshNetworkForced()
        // 正文被这次改名重写过的话，本地那份已经过期：不重读的话下一次敲键会把旧写法整篇盖回库里
        const { currentId } = get()
        if (currentId !== null) {
          const fresh = await window.kestrel.entries.get(currentId)
          if (fresh) applyEntry(fresh)
        }
        // 三种代价各说各的：搬走了多少处 / 留下多少处悬空 / 顺手认领了几条早就悬空写着的 [[新名]]。
        // 最后那条不能省：改名回到旧名字时 hits 是 0，只报 hits 会成「0 处跟着搬过去」这种废话
        const 搬 =
          rewriteLinks && impact.hits > 0
            ? `，正文里那 ${impact.hits} 处跟着搬过去`
            : !rewriteLinks && impact.hits > 0
              ? `，正文里那 ${impact.hits} 处 [[${from}]] 现在悬空了`
              : ''
        const 认领 = impact.claimed > 0 ? `，顺带把 ${impact.claimed} 条悬空的 [[${to}]] 接上了` : ''
        get().notify(`已改名为「${to}」${搬}${认领}`)
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    async patchTopic(id, patch) {
      try {
        await window.kestrel.topics.update(id, patch)
        await refreshTopics()
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    async removeTopic(id, detach) {
      const name = get().topics.find((t) => t.id === id)?.name ?? '主题'
      try {
        await window.kestrel.topics.remove(id, detach)
        await refreshTopics()
        if (get().activeTopicId === id) {
          set({ activeTopicId: null })
          await refreshArticles(null)
        } else if (get().mode === 'topic') {
          // 删的可能是别的主题，但当前这一列的文章归属也可能被这次改动带偏
          await refreshArticles(get().activeTopicId)
        }
        // 主题那一格之外还要清两处：收藏行主进程已经删了，本地那份得跟上；
        // 指向它的 [[双链]] 变成了悬空，图谱与反栏都要重画
        await refreshBookmarks()
        refreshNetworkForced()
        get().notify(detach ? `已删除「${name}」，那些文章都留着，只是没了归属` : `已删除「${name}」`)
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    async moveTopic(id, dir) {
      const ordered = orderedTopics(get().topics)
      const at = ordered.findIndex((t) => t.id === id)
      if (at < 0) return
      // 只跟同一层的邻居换：跨层的换位在界面上看不出结果——子主题永远紧跟它的父主题
      let to = at + dir
      while (to >= 0 && to < ordered.length && ordered[to].parentId !== ordered[at].parentId) to += dir
      if (to < 0 || to >= ordered.length) return
      const next = [...ordered]
      next[at] = ordered[to]
      next[to] = ordered[at]
      try {
        await window.kestrel.topics.reorder(next.map((t) => t.id))
        await refreshTopics()
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    /* ─ 标签视图（侧栏第三格） ─ */

    async selectTag(id) {
      // 换筛子之前先把这一篇落库：正文里可能正写着上一个标签，树上的计数看的是库不是本地那份
      await get().flush()
      set({ activeTagId: id, tagLimit: TAG_PAGE })
      await refreshTagEntries(id)
    },

    /** 正文里点 `#标签` 过来的那条路（§6）。编辑器手上只有那一串字面写法，
     *  所以先落库（刚敲的标签要在树上出现才筛得到）、保证侧栏在标签格，再按归一后的名字找。
     *  找不到不静悄悄：那句提示就是「这一处写了个标签，但库里目前没有它」的唯一交代。 */
    async selectTagName(raw) {
      const key = normalizeTagKey(raw.replace(/^#/, ''))
      await get().flush()
      if (get().dirty) {
        get().notify('这一篇还没存上，先筛不了')
        return
      }
      if (get().mode !== 'tag') await get().setMode('tag')
      else await refreshTagSide()
      const hit = key ? findTag(get().tags, (n) => n.name === key) : null
      if (!hit) {
        get().notify(`还没有带 #${key || raw} 的记录`)
        return
      }
      set({ activeTagId: hit.id, tagLimit: TAG_PAGE })
      await refreshTagEntries(hit.id)
      get().notify(`侧栏已筛出带 #${hit.name} 的记录`)
    },

    focusTagTree() {
      set((s) => ({ tagTreeFocus: s.tagTreeFocus + 1 }))
      // 树只在标签格画，键位按下去时那一格可能还没打开
      if (get().mode !== 'tag') void get().setMode('tag')
    },

    foldTag(name, open) {
      // 只记用户动过的手势。没动过的按默认走（根节点展开、其余折起），
      // 所以重新拉树不会把用户展开的那一层收回去
      set((s) => ({ tagFold: { ...s.tagFold, [name]: open } }))
    },

    setTagRename(from) {
      set({ tagRename: from })
    },

    async tagImpact(from) {
      return await window.kestrel.tags.impact(from)
    },

    async renameTag(to) {
      const from = get().tagRename
      set({ tagRename: null })
      if (from === null) return
      const key = normalizeTagKey(to)
      if (!key || key === from) return
      // 主进程的 renameTag 也会撞上同一条判据（它按 token 匹配正文），
      // 但话在这里说得清：改完不是一个标签了，而是少一个标签
      if (!isTagName(to)) {
        get().notify(`#${to} 不是一个合法的标签名：写进正文会被解析成别的`)
        return
      }
      try {
        // 当前这篇很可能就写着这个标签。先落盘，否则改完库、防抖里那份旧正文再写回去，改名等于白做
        await get().flush()
        if (get().dirty) {
          get().notify('这一篇还没存上，先别改名')
          return
        }
        const impact = await window.kestrel.tags.rename(from, to)
        await refreshTags()
        // 选中态跟着搬过去：`from` 现在 0 命中，已经从树上掉了
        const node = findTag(get().tags, (n) => n.name === key)
        set({ activeTagId: node?.id ?? null, tagLimit: TAG_PAGE })
        await refreshTagEntries(get().activeTagId)
        // 正文被这次改名重写过的话，本地那一份已经过期。重读一次，
        // 否则下一次敲键会把旧写法整篇盖回库里
        const { currentId } = get()
        if (currentId !== null) {
          const fresh = await window.kestrel.entries.get(currentId)
          if (fresh) applyEntry(fresh)
        }
        get().notify(`#${from} → #${to} · 改了 ${impact.entries} 篇 ${impact.hits} 处`)
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    /* ─ 属性（期-02-设计 §3.2 / §4.3 / §4.4） ─ */

    async refreshPropKeys() {
      try {
        set({ propKeys: await window.kestrel.props.keys() })
      } catch {
        // 登记表读不出来就让面板按文本渲染。属性是边写边看的东西，不该拦住写作
      }
    },

    async setProp(name, value) {
      const entry = get().entry
      if (!entry) return
      // 整块替换：`patch.props` 是新的那一份，不是往旧的上面补（主进程那边同理，
      // 所以这里必须以当前已知的全量为准，漏一个键就是删一个键）
      const next: Record<string, unknown> = { ...entry.props }
      // 空值是删键，不是塞 `''` / `null`：那会让「未填」和「填了个空的」在
      // 属性视图里成两组，第 8 期导出 frontmatter 时更是平白多出 `mood: ""`
      if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) delete next[name]
      else next[name] = value

      try {
        const updated = await window.kestrel.entries.update(entry.id, { props: next })
        const now = get()
        // 只并 props：库里回来的那份 title/content 可能是 500ms 防抖之前的旧正文，
        //  whole 覆盖会把用户正在敲的那一篇换掉
        set({
          entry: now.entry ? { ...now.entry, props: updated.props, updatedAt: updated.updatedAt } : now.entry,
          saveState: 'saved',
          saveError: null,
        })
        // 值分组数（第一级那个「有几个不同值」）跟着变了，新名字也在这一次登记上。
        // 侧栏那格正按这个属性分组时不能只刷计数：第二级的组、第三级这一组的条目列表
        // 都随着这次改动变了，只刷 keys 会让列表停在旧的那一份上
        if (get().mode === 'prop') void refreshPropSide()
        else void get().refreshPropKeys()
      } catch (err) {
        // 主进程按 PropKey.type 严格拦（§4.4），message 直接落状态栏那条 .err
        set({ saveState: 'error', saveError: errorMessage(err) })
      }
    },

    async putPropKey(name, type) {
      try {
        await window.kestrel.props.keyPut(name, type)
        await get().refreshPropKeys()
      } catch (err) {
        set({ saveState: 'error', saveError: errorMessage(err) })
      }
    },

    setPropConvert(target) {
      set({ propConvert: target })
    },

    async propConvertReport(name, to) {
      return await window.kestrel.props.keyConvert(name, to)
    },

    async applyPropType(name, to) {
      set({ propConvert: null })
      // 先落盘：改类型过的是库里那一行，正文还在防抖窗口里就先把它交出去
      await get().flush()
      try {
        await window.kestrel.props.keyPut(name, to)
        await get().refreshPropKeys()
        // 全库的值按新类型重写过了，当前这篇要重读一次才能显示出新形态
        // （只并 props，理由同 setProp）
        const { currentId } = get()
        if (currentId !== null) {
          const fresh = await window.kestrel.entries.get(currentId)
          if (fresh && get().entry) set({ entry: { ...get().entry as Entry, props: fresh.props } })
        }
        get().notify(`${name} 已改为${PROP_TYPE_LABEL[to]}`)
        // 全库的值按新类型重排过了：属性那一格还留着旧分组的话，点进去是空的
        if (get().mode === 'prop') await refreshPropSide()
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    /* ─ 属性视图的下钻（§3.3） ─ */

    async setPropCrumb(crumb) {
      const keyChanged = get().propCrumb[0]?.name !== crumb[0]?.name
      // 换路径就退回一页宽：上一级滚到 90 条了，带着那个 limit 下去会让新列表一上来取 90 条
      set({ propCrumb: crumb, propLimit: PROP_PAGE, propRows: [] })
      // 同一条属性从第二级下到第三级不重取分组——那是同一次全库扫，白扫一遍
      if (keyChanged) await refreshPropGroups(crumb[0]?.name ?? null)
      await refreshPropEntries(crumb)
    },

    async openPropSide(name) {
      // 面板那枚小按钮不是「另开一个视图」，是把侧栏跳到第二级，所以共用同一份 crumb
      await get().setMode('prop')
      await get().setPropCrumb([{ name, value: null }])
    },

    async patchSettings(patch) {
      const previous = get().settings
      // 先改本地：换主题、拖滑杆要立刻看到效果，不能等一次 IPC 往返
      set({ settings: { ...previous, ...patch } })
      try {
        const saved = await window.kestrel.settings.patch(patch)
        set({ settings: saved })
      } catch (err) {
        set({ settings: previous })
        get().notify(errorMessage(err))
      }
    },

    toggleFocus() {
      set((s) => ({ focus: !s.focus }))
    },

    /** 切编辑器模式。切到非源码那一档要过闸门，切回源码永远放行。
     *  进入 reading 与进入 rich 走同一条判据（§4.1）：都不写回、但读视图看不到被 schema
     *  吃掉的标签；宁可让用户停在源码里看到真相，也别在 reading 里少东西他还以为文档就那样。 */
    async switchEditorMode(mode) {
      const s = get()
      if (mode === s.editorMode) return

      if (mode === 'source') {
        set({ editorMode: 'source', gateNote: null, gateBlocked: false })
        return
      }

      const { out, lossless, notes, lost } = roundTrip(s.content)
      if (!lossless) {
        // 留在源码模式。这不是「失败了」，是这一篇本来就不该用非源码视图看/编辑
        set({ editorMode: 'source', gateBlocked: true, gateNote: `留在源码模式：${mode === 'reading' ? '阅读' : '所见即所得'}会丢 ${lost.join('、')}` })
        get().notify('这篇还进不了非源码视图')
        return
      }

      set({
        editorMode: mode,
        gateBlocked: false,
        gateNote: notes.length ? `已切到${mode === 'reading' ? '阅读' : '所见即所得'} · ${notes.join('、')}` : null,
      })
      // 规范化过的写法就地写回：所见即所得里看到的就是将来会存进去的。
      // 会标脏并触发一次自动保存，是有意的——否则文件里留着一份和界面不同的写法，
      // 用户敲下一个键时才悄悄换掉，那才叫难解释。
      // 阅读模式不做这一步：这一档不该改落库内容（用户可能只是想「看」一遍）。
      if (mode === 'rich' && out !== s.content) s.setContent(out)
    },

    setSheetOpen(open) {
      set({ sheetOpen: open })
    },

    notify(msg) {
      if (toastTimer) clearTimeout(toastTimer)
      set({ toast: msg })
      toastTimer = window.setTimeout(() => set({ toast: null }), 1900)
    },

    askConfirm(req) {
      // 一次只问一句。已经在问的时候再叠一层，用户会看见两张卡叠在一起、
      // 而其中一张的答案永远送不到
      if (confirmResolve !== null) return Promise.resolve(false)
      set({ confirm: req })
      return new Promise<boolean>((resolve) => {
        confirmResolve = resolve
      })
    },

    answerConfirm(ok) {
      const resolve = confirmResolve
      confirmResolve = null
      set({ confirm: null })
      resolve?.(ok)
    },

    /* ─ 命令面板 / 快速切换 ─ */

    async openPalette(mode) {
      // 先开面板再拉数据：候选池是几百条，等它回来才显示浮层会有一拍空白
      // 搜索面板一起关掉：两个都是居中 sheet，叠着会出两层模糊、两套键盘导航
      set({ palette: mode, searchOpen: false })
      if (mode !== 'switch') return
      const rows = await window.kestrel.entries.recent(SWITCH_LIMIT)
      // 拉的过程中关掉了、或切去了命令模式，这份候选就作废
      if (get().palette !== 'switch') return
      set({ switchRows: rows })
    },

    closePalette() {
      set({ palette: null })
    },

    /* ─ 搜索面板（期-03 §4.1） ─ */

    openSearch() {
      // 两个都是居中 sheet，同开会叠两层模糊、两套键盘导航，所以互斥。
      // 反过来不关搜索：Palette.tsx 那条「跑命令前先 close()」已经把它关了
      set({ searchOpen: true, palette: null })
    },

    setSearchOrder(order) {
      set({ searchOrder: order })
    },

    closeSearch() {
      set({ searchOpen: false })
    },

    async openSearchHit(entryId, pos, needle) {
      set({ searchOpen: false })
      await get().openEntry(entryId)
      // 请求号在最后才发：编辑器认 entryId，切文档没落地时这条请求自然落空
      set({ searchJump: { entryId, pos, needle, at: Date.now() } })
    },

    /* ─ 升格 ─ */

    setPromoteOpen(open) {
      set({ promoteOpen: open })
    },

    async promoteCurrent(input) {
      const { currentId } = get()
      if (currentId === null) return
      try {
        // 正文可能还在 500ms 防抖窗口里没落盘，而升格读的是库里那一行
        await get().flush()
        const promoted = await window.kestrel.entries.promote(currentId, input)
        set({ promoteOpen: false })
        applyEntry(promoted)
        // 用户刚给了它归属，应该立刻看到它在主题下的样子
        await get().selectTopic(promoted.topicId ?? input.topicId)
        set({ mode: 'topic' })
        await Promise.all([refreshRecent(), refreshBin(), refreshTopics()])
        get().notify(`已升格为《${promoted.title}》`)
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    /* ─ 回收站 ─ */

    setBinOpen(open) {
      set({ binOpen: open })
      if (open) void refreshBin()
    },

    /* ─ 全屏图谱（期-06a） ─ */

    // 只有开关与"哪一档"，没有数据：拓扑开层时现查（设计稿 D10）
    setGraphOpen(open) {
      set({ graphOpen: open })
    },
    setGraphMode(mode) {
      set({ graphMode: mode })
    },

    /* ─ 跨年同日（期-06b-2 §二） ─ */

    async connectCrossYear(hit) {
      const s = get()
      // 链接文字用"给人看的那个名字"：文章是标题，日记是日期。
      // 这两条恰好也是 `parseLinks` 各自的认法（日期走 `resolveDateRef`，标题走规范化键），
      // 所以追加进去的那一行下一次重解析必被认领——写别的就会留一条悬空边
      const label = hit.title ?? hit.date
      const key = normalizeLinkKey(label)
      // 幂等判在正文而不是判界面：两次点击之间 `outgoing` 还没刷新，光靠卡消不消失拦不住第二笔
      if (parseLinks(s.content, s.entry?.entryDate ?? '').some((l) => l.key === key)) {
        s.notify(`这篇里已经连着「${label}」了`)
        return
      }
      const body = s.content.replace(/\s+$/, '')
      s.setContent(body ? `${body}\n\n[[${label}]]` : `[[${label}]]`)
      // 立刻落库：这条动作是用户点出来的，不是敲出来的，不该等 500ms 的自动保存
      await s.flush()
      s.notify(`已在正文末尾连上「${label}」`)
    },

    /* ─ 查询块与模板（期-07） ─ */

    async refreshLibrary() {
      try {
        const [savedQueries, templates] = await Promise.all([
          window.kestrel.saved.list(),
          window.kestrel.templates.list(),
        ])
        set({ savedQueries, templates })
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    setLibraryOpen(open) {
      set({ libraryOpen: open })
      if (open) void get().refreshLibrary()
    },

    setTransferOpen(open) {
      // 关掉就回到「导出」那一档：导入是一年用不上几次的事，
      // 面板留着上一次的档位，下次手一抖 Ctrl+K 回车就站在危险的那一边。
      // busy 也跟着抹掉：面板都没了还挂着它，下一条 Esc 不知道该关谁
      set({
        transferOpen: open,
        transferTab: open ? get().transferTab : 'export',
        transferBusy: open ? get().transferBusy : false,
      })
    },

    setTransferTab(tab) {
      set({ transferTab: tab })
    },

    setTransferBusy(busy) {
      set({ transferBusy: busy })
    },

    async saveQuery(name, body) {
      try {
        const sq = await window.kestrel.saved.create(name, body)
        await get().refreshLibrary()
        return { ok: true, msg: `已存为「${sq.name}」` }
      } catch (err) {
        // 名字撞了、这条查询本身跑不通——都是要就地回一句话的失败，不是栈追踪
        return { ok: false, msg: errorMessage(err) }
      }
    },

    async removeSaved(id) {
      try {
        await window.kestrel.saved.remove(id)
        await get().refreshLibrary()
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    async insertQuery(body, savedId) {
      const s = get()
      if (s.editorMode === 'reading') {
        s.notify('阅读模式下不插入，先切回编辑')
        return
      }
      const text = String(body ?? '').replace(/\s+$/, '')
      if (!text) return
      const editor = s.editorMode === 'rich' ? getRichEditor() : null
      if (editor?.isEditable) {
        // 走 PM 事务而不是改 Markdown 原文：后者会把整篇重新解析一遍，光标掉回文首。
        // 插完之后 onUpdate 自己会序列化回 store，这里不必再 setContent
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'codeBlock',
            attrs: { language: 'query' },
            content: [{ type: 'text', text }],
          })
          .run()
      } else {
        const base = s.content.replace(/\s+$/, '')
        const fence = '```query\n' + text + '\n```'
        s.setContent(base ? `${base}\n\n${fence}\n` : `${fence}\n`)
        void s.flush()
      }
      if (savedId !== undefined) {
        // used_at 只服务「最近用的排前面」那一条排序，掉了不该影响插入本身
        void window.kestrel.saved
          .used(savedId)
          .then(() => get().refreshLibrary())
          .catch(() => {})
      }
      s.notify('已插入查询块')
    },

    async createTemplate(input) {
      try {
        const tpl = await window.kestrel.templates.create(input)
        await get().refreshLibrary()
        get().notify(`已新建模板「${tpl.name}」`)
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    async updateTemplate(id, patch) {
      try {
        await window.kestrel.templates.update(id, patch)
        await get().refreshLibrary()
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    async removeTemplate(id) {
      try {
        await window.kestrel.templates.remove(id)
        await get().refreshLibrary()
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    async applyTemplate(id) {
      const s = get()
      const tpl = s.templates.find((t) => t.id === id)
      if (!tpl) {
        s.notify('这条模板已经不在了')
        return
      }
      if (s.editorMode === 'reading') {
        s.notify('阅读模式下不套用，先切回编辑')
        return
      }
      const entry = s.entry
      if (!entry) {
        s.notify('先打开一篇再套模板')
        return
      }
      // 以**这一篇的那天**为准，不是墙上今天：补记 3 月 5 日时要拿到 3 月 5 日
      const [y, m, d] = entry.entryDate.split('-').map(Number)
      const lastEntry = await window.kestrel.entries
        .prevDiary(entry.entryDate)
        .then((p) => (p ? { title: p.title, entryDate: p.entryDate } : null))
        .catch(() => null)
      const exp = expandTemplate(tpl.body, {
        date: new Date(y, m - 1, d, 12, 0, 0),
        lastEntry,
        topic: s.topics.find((t) => t.id === entry.topicId)?.name,
      })
      const text = exp.text.replace(/\s+$/, '')
      if (!text) {
        s.notify('这条模板展开后是空的')
        return
      }
      // 模板正文是任意 Markdown，`insertContent` 只认 HTML / PM JSON（没有 contentType
      // 这一档），所以走 store 那条已经验证过的路：写进 content，由 RichEditor 的
      // `contentType: 'markdown'` 回灌解析。代价是光标回文首——套用模板本来就是要从头写
      const base = s.content.replace(/\s+$/, '')
      s.setContent(base ? `${base}\n\n${text}\n` : `${text}\n`)
      void s.flush()
      const notes: string[] = []
      if (exp.unknownVars.length) notes.push(`没认出的变量：${exp.unknownVars.map((v) => `{{${v}}}`).join('、')}`)
      if (exp.missing.length) notes.push(`缺值：${exp.missing.join('、')}`)
      if (exp.unknownMarkers.length) notes.push(`没认出的日期标记：${exp.unknownMarkers.join('、')}`)
      // 原样留在正文里的那些 `{{…}}` 必须说出来：用户看不见就等于被吞掉了
      s.notify(notes.length ? `已套用「${tpl.name}」—— ${notes.join('；')}` : `已套用「${tpl.name}」`)
    },

    /* ─ 收藏（§3.4） ─ */

    setBookmarkOpen(open) {
      set({ bookmarkOpen: open })
      // 打开时重取一次：收藏行的 state（在不在回收站、指向的东西还在不在）是读的时候现查的，
      // 常驻那份可能已经因为删篇/恢复/改主题而过期
      if (open) void refreshBookmarks()
    },

    async toggleBookmark(kind, ref, title) {
      try {
        const on = await window.kestrel.bookmarks.toggle(kind, ref, title)
        await refreshBookmarks()
        get().notify(`${on ? '已收藏' : '已取消收藏'} · ${title}`)
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    async openBookmark(bm) {
      // 收藏指向的三种东西不是一个东西：entry 是文档，topic 与 tag 只是视图的筛选条件，
      // 所以跳转动作分三条路，共用不了一个 openEntry
      if (bm.state !== 'ok') {
        get().notify(
          bm.state === 'deleted'
            ? '这条收藏的记录在回收站里，先恢复才能打开'
            : '这条收藏指向的东西已经不在了，取消收藏就把它清掉'
        )
        return
      }
      set({ bookmarkOpen: false })
      if (bm.kind === 'entry') {
        await get().openEntry(bm.ref)
        return
      }
      if (bm.kind === 'topic') {
        set({ mode: 'topic' })
        await get().selectTopic(bm.ref)
        get().notify(`主题「${bm.title}」`)
        return
      }
      await get().setMode('tag')
      await get().selectTag(bm.ref)
      get().notify(`#${bm.title}`)
    },

    async restoreDeleted(id) {
      try {
        const restored = await window.kestrel.entries.restore(id)
        // 主题行上的篇数是 topics.list() 带回来的计数，和文章列表是两次查询：
        // 只刷列表的话，恢复完徽章还停在删除前那一刻
        await Promise.all([refreshBin(), refreshRecent(), refreshHeat(), refreshTopics()])
        if (get().mode === 'topic') await refreshArticles(get().activeTopicId)
        // 少一篇 = 它身上那些标签各少一次计数，全为 0 的那一行还要从树上消失
        if (get().mode === 'tag') await refreshTagSide()
        // 属性那一格：少一篇，某个值分组的计数就要掉，整组空了那一行还要消失
        if (get().mode === 'prop') await refreshPropSide()
        // 恢复的可能是当前视图该看到的那一篇，但**不主动打开**：
        // 用户可能是在回收站里连挑几条恢复，每恢复一条就跳走会打断这件事
        get().notify(`已恢复 · ${entryLabel(restored)}`)
      } catch (err) {
        // 撞上「这天已有一篇日记」时留一条可读的提示，那条记录仍留在回收站
        get().notify(errorMessage(err))
      }
    },

    async purgeEntry(id) {
      try {
        await window.kestrel.entries.purge(id)
        await Promise.all([refreshBin(), refreshRecent(), refreshHeat(), refreshTopics()])
        if (get().mode === 'topic') await refreshArticles(get().activeTopicId)
        // 少一篇 = 它身上那些标签各少一次计数，全为 0 的那一行还要从树上消失
        if (get().mode === 'tag') await refreshTagSide()
        // 属性那一格：少一篇，某个值分组的计数就要掉，整组空了那一行还要消失
        if (get().mode === 'prop') await refreshPropSide()
        get().notify('已彻底删除')
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    /* ─ 历史版本 ─ */

    refreshVersions,

    async snapshotManual() {
      const { currentId } = get()
      if (currentId === null) return
      // 先落盘：这一版要记的是用户刚写完的东西，不是 500ms 前那一版
      await get().flush()
      try {
        await window.kestrel.revisions.snapshot(currentId)
        await refreshVersions()
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    async previewVersion(id) {
      try {
        set({ versionOf: await window.kestrel.revisions.get(id) })
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    closeVersion() {
      set({ versionOf: null })
    },

    async restoreVersion(id) {
      try {
        const entry = await window.kestrel.revisions.restore(id)
        set({ versionOf: null })
        applyEntry(entry)
        await Promise.all([refreshRecent(), refreshVersions()])
        get().notify('已恢复到那一版')
      } catch (err) {
        get().notify(errorMessage(err))
      }
    },

    /* ─ 大纲 / 最近记录 ─ */

    jumpToHeading(index) {
      // 每次都是新对象：连点同一个标题也要能再滚一次
      set({ headingJump: { index, at: Date.now() } })
    },

    setActiveHeading(index) {
      if (get().activeHeading !== index) set({ activeHeading: index })
    },

    async loadMoreRecent() {
      if (loadingMore) return
      loadingMore = true
      try {
        const next = get().recentLimit + RECENT_PAGE
        set({ recentLimit: next })
        set({ recent: await window.kestrel.entries.recent(next) })
      } finally {
        loadingMore = false
      }
    },

    async loadMoreTag() {
      if (loadingMoreTag) return
      loadingMoreTag = true
      try {
        set({ tagLimit: get().tagLimit + TAG_PAGE })
        await refreshTagEntries(get().activeTagId)
      } finally {
        loadingMoreTag = false
      }
    },

    async loadMoreProp() {
      if (loadingMoreProp) return
      loadingMoreProp = true
      try {
        set({ propLimit: get().propLimit + PROP_PAGE })
        await refreshPropEntries(get().propCrumb)
      } finally {
        loadingMoreProp = false
      }
    },
  }
})

/** 一条记录给人看的名字。日记没有标题，就用日期——与 `main/db/links.ts` 的
 *  `labelOf` 同一个规矩，两处不能各叫各的。 */
export function entryLabel(e: Pick<Entry, 'kind' | 'title' | 'entryDate'>): string {
  if (e.title) return e.title
  return e.kind === 'diary' ? formatDateZh(e.entryDate) : '未命名文章'
}

/** 热力图的档位：按字数分档而不是按分位数。
 *  分位数会让「这个月写得少」时最少的几天看起来也很深，反而看不出变化。 */
export function heatLevel(charCount: number): number {
  if (charCount <= 0) return 0
  if (charCount < 200) return 1
  if (charCount < 600) return 2
  if (charCount < 1500) return 3
  return 4
}

export { dateKey, HEAT_WEEKS }