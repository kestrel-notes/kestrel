/** 主进程与渲染进程共享的类型与通道名。
 *  只有类型和常量，不含副作用——两边都会 import。 */

import type { Workspace } from './workspace'

export type { Workspace }

export type EntryKind = 'diary' | 'article'
export type EntryStatus = 'draft' | 'published'
export type ThemeName = 'cloud' | 'paper' | 'midnight' | 'terminal'

export type LinkSourceType = 'entry' | 'topic'
/** date 是「那天的日记」这个坐标；日记还没写时 target_id 为空，写了自动连上 */
export type LinkTargetType = 'entry' | 'topic' | 'date'
export type LinkKind = 'wiki' | 'embed' | 'block' | 'promotion' | 'mention'

/** 一条记录。日记与文章是同一张表上的两种视图，`kind` 是属性不是类型。 */
export interface Entry {
  id: number
  kind: EntryKind
  title: string | null
  content: string
  /** 发生日期，'YYYY-MM-DD'。日记必填；文章默认创建日 */
  entryDate: string
  createdAt: string
  updatedAt: string
  /** 用户可扩展属性（mood / weather / 自定义）。心情与天气都从这里来，不单独占列 */
  props: Record<string, unknown>
  topicId: number | null
  status: EntryStatus
  deletedAt: string | null
  /** 由日记升格成文章的时刻；不是升格来的为 null。
   *  光看 (kind, entry_date) 分不出「从这天日记升格来的文章」与「这天新建的文章」，
   *  所以这件事必须自己占一列——它是日记页那条「这一天已升格为《X》」横幅的唯一依据。 */
  promotedAt: string | null
}

/** 一次保存的快照。正文只留最近 50 条，见 main/db/revision.ts */
export type RevisionReason = 'auto' | 'manual' | 'restore'

export interface Revision {
  id: number
  entryId: number
  title: string | null
  content: string
  props: Record<string, unknown>
  reason: RevisionReason
  createdAt: string
}

/** 历史版本列表用的轻量行：**不带 content**，正文只在真正预览时才取
 *  （一篇几千字的文档，列 50 条就是几百 KB，纯属白传） */
export interface RevisionSummary {
  id: number
  title: string | null
  charCount: number
  reason: RevisionReason
  createdAt: string
}

export interface Topic {
  id: number
  name: string
  slug: string
  icon: string | null
  color: string | null
  parentId: number | null
  sortOrder: number
  description: string | null
  /** 这个主题下有多少篇文章（回收站里的不算）。读的时候现查出来的一列，不是库里的列：
   *  管理 sheet 那一行要说「下面还挂着 N 篇」，删除的拦阻判据问的也是它（§3.5）。 */
  articleCount: number
}

/** 主题的编辑（期-02-设计 §3.5）。**没有 `name`**：改名要把全库正文里的 `[[旧名]]` 一起搬，
 *  是 `topics.rename` 那条通道，混进 patch 里就等于给「只改了一半」留了路。
 *  `color` 存的是色板 token 名（`'tag-1' … 'tag-8'`），渲染成 `var(--tag-N)`。 */
export interface TopicPatch {
  icon?: string | null
  color?: string | null
  parentId?: number | null
  sortOrder?: number
}

/** 侧栏「最近记录」流用的轻量行，避免为了列表把全文捞出来 */
export interface EntrySummary {
  id: number
  kind: EntryKind
  status: EntryStatus
  title: string | null
  entryDate: string
  updatedAt: string
  excerpt: string
  charCount: number
  /** 回收站要用它算「还剩几天」。普通列表里是 null */
  deletedAt: string | null
  /** 升格来的文章：列表上标一枚「升格」徽标，也用来定位来源日记 */
  promotedAt: string | null
}

export interface DayCount {
  /** 'YYYY-MM-DD' */
  date: string
  count: number
  charCount: number
}

export interface Settings {
  theme: ThemeName
  /** 覆盖主题自带的强调色；null = 用主题默认 */
  accent: string | null
  blur: number
  sat: number
  glass: boolean
  /** 跟随系统浅色/深色（在浅色主题与暗色主题之间切换） */
  followSystem: boolean
  /** 上一次导出用的目录。导出是重复动作（每周导一次给别的工具看），
   *  每次都从系统对话框重挑一遍太烦；这一项也让「导出到哪去了」有个地方能查 */
  exportLastDir: string | null
  /** 上一次导入用的目录。与导出那一档分开记：往返测试里「导出去的地方」和
   *  「从哪儿导回来」常常是同一个目录，但混成一个键会让「上次导到哪」这句话有歧义 */
  importLastDir: string | null
  /** 每天开应用时自动落一份快照（期-08 §四）。关掉之后「立即备份一份」那颗按钮还在 */
  backupEnabled: boolean
  /** 滚动保留几份快照。3–30，超出就贴边（判据见 `shared/backupFormat.ts` 的 `keepClamp`） */
  backupKeep: number
  /** 关掉的 CSS 片段文件名（期-09b §二）。存「关掉的」而不是「开着的」，理由写在
   *  `docs/期-09b-设计稿.md` §七 决策 40：丢进目录就生效是承诺，而缺这一格时的默认值 `[]`
   *  恰好等于「全开」，老库不必迁移。 */
  snippetsOff: string[]
  /** 启动时套一次的编辑器档位。`editorMode` 本身仍是运行态（每次换文档都可能被闸门按回 source），
   *  这一格只管「开应用落在哪一档」 */
  editorModeDefault: 'rich' | 'source' | 'reading'
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'cloud',
  accent: null,
  blur: 22,
  sat: 1.7,
  glass: true,
  followSystem: false,
  exportLastDir: null,
  importLastDir: null,
  backupEnabled: true,
  backupKeep: 7,
  snippetsOff: [],
  editorModeDefault: 'rich',
}

/** 关于那一格要的几件事（期-09b §四）。版本与路径都在主进程那一侧，渲染进程猜不出来，
 *  而「我的日记存在哪儿」这一格恰恰是人最容易问、也最不该由界面编的一句话。 */
export interface AppInfo {
  version: string
  /** `pragma user_version` */
  schema: number
  dbFile: string
  snippetsDir: string
  backupsDir: string
}

/** 一份 CSS 片段（期-09b §二）。清单是**只读**的：文件就是数据，库里不留第二份。
 *  `css` 为 null 表示这一份没读进来（超限或读坏了），`note` 给一句为什么——
 *  不显示出来的话，人只会以为「我明明放了文件怎么没反应」。 */
export interface Snippet {
  /** 文件名，就是它的身份（也是生效顺序的排序键：按名字升序） */
  name: string
  bytes: number
  mtime: number
  on: boolean
  css: string | null
  note?: '太大' | '读不了' | '本次停用'
}

/* ── 流通（期-08）：导出 / 导入 / 备份 ────────────────────────────
 *
 *  三个形状都放在这儿而不是 main 里，是因为界面要能把「会写多少篇、会不会改名」
 *  在点确认**之前**就画出来——而那份判据只有一份（`main/db/export.ts` 算它）。 */

export interface ExportPlan {
  /** 用户选中的目录（绝对路径，界面原样显示） */
  dir: string
  entries: number
  diary: number
  articles: number
  /** 会被写出去的文件数（正文 + 附件 + library.json + MANIFEST.json） */
  files: number
  /** 正文总字节（不含包头与附件）——给人一个「这大概要多大」的量 */
  bytes: number
  /** 大小写不敏感撞车后被改了名的那几篇 */
  renamed: { entryId: number; path: string; note: string }[]
  /** 属性名撞上 `kestrel-*`：这一条**中止**导出并报错，不自动加前缀（口径 ①） */
  reserved: { entryId: number; name: string }[]
  assets: { referenced: number; onDisk: number; missing: number }
  /** 正文里的外链图片数量：只报一句，一个字不动 */
  external: number
}

export interface ExportResult {
  dir: string
  written: number
  bytes: number
  renamed: number
  assets: number
  ms: number
  /** 用户按了「中止」。这时目录里只有前 `written` 篇，且**没有** library/MANIFEST——
   *  那两份是「这一导完整」的凭据，半截目录配一份全量清单比不写更坏 */
  aborted: boolean
}

/** 导出正在进行中的进度。界面**轮询**它，不为这一个数字开一条事件通道——
 *  导出本身是异步分批发起的（`export.ts` 每 200 篇让出一次事件循环），所以轮询拿得到。 */
export interface ExportProgress {
  running: boolean
  done: number
  total: number
}

/** 导入计划（期-08 §三）。三个数就是这一档的全部意义：
 *  人在点确认之前要看得见「新建多少、覆盖多少、多少原样不动」。 */
export interface ImportPlan {
  dir: string
  /** 扫到的 md 文件数（含认不出来的） */
  files: number
  /** 认得出 `kestrel-id` 的篇数 */
  ours: number
  /** 认不出来的篇数——它们一个字都不会被读进库 */
  foreign: number
  /** 前几个认不出来的文件名，给人核对是不是选错了目录 */
  foreignNames: string[]
  creates: number
  updates: number
  skips: number
  errors: string[]
  errorCount: number
  assets: { referenced: number; present: number; missing: number }
  newTopics: string[]
  newPropKeys: string[]
  library: { topics: number; savedQueries: number; templates: number }
}

export interface ImportResult {
  dir: string
  created: number
  updated: number
  skipped: number
  assets: number
  topics: number
  propKeys: number
  errors: string[]
  ms: number
  aborted: boolean
}

export interface ImportProgress {
  running: boolean
  done: number
  total: number
}

/* ── 备份与恢复（期-08 §四） ── */

/** 一份快照。`entries` 是把那一份只读打开数出来的：数不出来（文件坏了、不是自家的库）
 *  就是 null，界面宁可写「数不出来」也不要显示一个 0 骗人。 */
export interface BackupInfo {
  name: string
  /** daily=一天一份那一种，manual=同一天里手动多按的那一份，
   *  before=换库之前对当前库的自保（它不参与滚动保留） */
  kind: 'daily' | 'manual' | 'before'
  /** 文件名里那个本地时刻 */
  at: string
  size: number
  entries: number | null
}

export interface BackupStatus {
  dir: string
  enabled: boolean
  keep: number
  /** 今天（本地）那一天，判据是「这一天的那一份在不在」 */
  today: string
  hasToday: boolean
  /** 新→旧 */
  snapshots: BackupInfo[]
  /** 30 天那一刀现在会砍掉多少。摆在这里是为了让「保留期」不再只是一行显示（#76） */
  pending: { revisions: number; entries: number }
}

export interface BackupRun {
  /** false = 今天已经有那一份了（或自动备份被关了），不是失败 */
  made: boolean
  name: string | null
  /** 滚动保留删掉的文件名（只可能是自家那两种快照） */
  pruned: string[]
  ms: number
}

export interface RestoreResult {
  /** 换进来的那一份 */
  from: string
  /** 换出去之前，当前库被存成了哪一份 */
  saved: string
  entries: number | null
}

/** 一次保存的入参：只带真正会变的字段 */
export interface EntryPatch {
  title?: string | null
  content?: string
  entryDate?: string
  props?: Record<string, unknown>
  topicId?: number | null
  status?: EntryStatus
}

export interface CreateEntryInput {
  kind: EntryKind
  entryDate: string
  title?: string | null
  content?: string
  topicId?: number | null
}

/** 升格：日记 → 文章。**不改正文、不复制内容**，只换归属。
 *  title 是必填的——文章侧栏靠标题认人，空标题在主题列表里是一张白卡片。 */
export interface PromoteInput {
  title: string
  topicId: number
}

/** 一条反向链接：谁指向我。context 是来源正文里命中那一行的片段。 */
export interface Backlink {
  linkId: number
  kind: LinkKind
  /** 来源记录的节点键（`e:12` / `t:3`），点一下跳回来源 */
  sourceKey: string
  sourceId: number
  sourceType: LinkSourceType
  /** 来源是 entry 时的具体类型，面板按它分组（日记 / 文章） */
  sourceKind: EntryKind | null
  /** 面板上写给人看的名字：文章标题 / 日记日期 / 主题名 */
  sourceLabel: string
  sourceDate: string | null
  alias: string | null
  context: string
}

export interface GraphNode {
  /** `e:12`（记录）/ `t:3`（主题）。两张表的 id 各自从 1 开始，必须带前缀区分 */
  key: string
  type: EntryKind | 'topic'
  label: string
  /** 与中心的跳数，中心是 0 */
  depth: number
}

export interface GraphEdge {
  source: string
  target: string
  kind: LinkKind | 'topic'
}

export interface DanglingLink {
  raw: string
  alias: string | null
}

/** 当前这篇的每一条出链，以及它落到了哪。
 *
 *  编辑器靠它给正文里的 `[[…]]` 分型着色（实线日记 / 双线文章 / 药丸底主题 /
 *  虚线悬空，见 docs/视觉设计系统.md §9.1）。所以 key 是**规范化查找键**
 *  （见 shared/links.ts），对着正文解析出来的 ParsedLink.key 即可命中；
 *  拿用户看到的字面去查是查不到的，`[[Kestrel 设计]]` 的键是 `kestrel设计`。 */
export interface OutgoingLink {
  key: string
  kind: LinkKind
  /** 目标节点键（`e:12` / `t:3`）。悬空为 null，点了不跳转 */
  nodeKey: string | null
  /** 目标是什么。日记的两种目标类型（entry / date）在这里都归成 'diary'。
   *  悬空为 null——注意这和「还没保存」是两回事，见 store 里的说明 */
  targetType: EntryKind | 'topic' | null
}

/** 局部图谱：当前记录 N 跳内的邻居。静态布局，只查一次，不做每帧重排 */
export interface LocalGraph {
  center: GraphNode
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 写了但目标还不存在的链接，画成虚线短枝 */
  dangling: DanglingLink[]
}

/** 全局图谱（期-06a）的节点：**没有 `depth`**。
 *
 *  全库图不存在"距中心几跳"这回事，复用 `GraphNode` 只会逼我们填一个假 0。
 *  `inDeg` 是入度（被多少条链接指向），它决定节点半径——`3 + 6·min(1,√inDeg/3)`。
 *  **刻意不带正文**：`content` 一上 IPC，3000 条就是几十 MB（实测拓扑本身 0.63 MB）。 */
export interface GraphNodeLite {
  key: string
  type: EntryKind
  label: string
  /** 归属主题。null = 没归主题，着色回落到 `--text-3` */
  topicKey: string | null
  inDeg: number
  /** `Entry.entry_date`。6b 的时间轴认这一列，不认 `created_at`：
   *  时间轴要回答的是"什么时候开始关心这件事"，而 created_at 回答的是"什么时候敲的字"
   *  （某篇 2024 的补记可能今年才写）。实测两列在合成库里 100% 分歧、真库里 0% 分歧，
   *  所以哪一列都必须写死，不能靠"反正一样"混过去。 */
  date: string
}

/** 全库拓扑。坐标不在这里——布局只在渲染层算，不过 IPC（决策 D4）。 */
export interface GlobalGraph {
  nodes: GraphNodeLite[]
  edges: GraphEdge[]
  /** 主题清单，聚合与着色都认它 */
  topics: { key: string; label: string; count: number }[]
  /** 悬空链接条数。不画成节点，只在状态条报数（决策 D9） */
  danglingCount: number
}

/** 主题编年史的一行（期-06b-2 §一）。
 *
 *  一行 = 一个条目。**升格来的那行自带两个时间点**（原料日 `entryDate` 与成文时刻 `promotedAt`），
 *  不拆成两行：升格是原地改 `kind`（`main/db/entries.ts` 的 `promote`），库里只有一行。
 *  排序键 `sortAt` 在主进程算：`promoted_at ?? created_at`。用 `created_at` 排会把
 *  「三年前记下、上个月才成文」的文章错放回三年前——实测编年史库里那批 p50 差 110 天。 */
export interface ChronicleRow {
  id: number
  kind: EntryKind
  title: string | null
  /** 原料那天（`Entry.entry_date`，升格不动它） */
  entryDate: string
  /** 行建起来那天。日记就是那天敲的字 */
  createdAt: string
  promotedAt: string | null
  /** `promoted_at ?? created_at`，时间线按它排 */
  sortAt: string
}

/** 跨年同日关联的一行（期-06b-2 §二）。
 *
 *  判据不是「去年那天有东西」——三年库里 42% 的日子都满足，那等于天天弹（§0.3）。
 *  要求共享标签或共享主题，满足才出一行。命中靠什么共享的，`why` 里写着，卡上原样显示：
 *  这条卡是在提议连一条线，用户有权知道它凭什么觉得自己相关。
 *  `tag` 只用来显示，不用来查库：标签集是渲染进程从两边正文里 `parseTags` 出来的，
 *  与 `EntryTag` 那套派生行同一个来源，所以不必为这一行卡再多开一条 IPC。 */
export interface CrossYearHit {
  /** 那年今天那一条 */
  entryId: number
  /** 隔了几年。1 = 去年今天，2 = 前年今天 */
  years: number
  /** 那天那一条的日期（'YYYY-MM-DD'） */
  date: string
  kind: EntryKind
  title: string | null
  topicName: string | null
  /** 共享的东西：标签名（含父级路径）或主题。多个只报第一个，卡上一行放不下 */
  why: { kind: 'tag' | 'topic'; name: string }
}

/** 查询块的一行结果（期-07 §三）。
 *
 *  **没有 `content`**：§0.2 量过同一条件 100 行，不带正文 3KB、带正文 35KB，
 *  而表格里那一列本来就没地方读。属性整块带回来（几十十字节），
 *  `table props.字数` 这种列由渲染层从里面挑。 */
export interface QueryRow {
  id: number
  kind: EntryKind
  title: string | null
  entryDate: string
  createdAt: string
  updatedAt: string
  promotedAt: string | null
  topicName: string | null
  props: Record<string, unknown>
}

/** 一次查询的结果。`truncated` 靠多取一条判出来的，不是再来一次 count */
export interface QueryResult {
  view: 'table' | 'list' | 'cards' | 'calendar' | 'timeline'
  /** 渲染层要显示的列，`props.字数` 这种写法原样带着 */
  cols: string[]
  rows: QueryRow[]
  truncated: boolean
  /** 主进程里的执行时间，不含 IPC：让"这次查得慢"看得见 */
  ms: number
  /** 不是错但该说一句的事，例如全文索引还在建所以退回了 LIKE */
  notes: string[]
}

/** 存下来的一条查询（期-07 §四）。用法是**把语句插进正文**，不是插引用（决策 D10） */
export interface SavedQuery {
  id: number
  name: string
  body: string
  view: 'table' | 'list' | 'cards' | 'calendar' | 'timeline'
  createdAt: string
  usedAt: string | null
}

/** 模板（期-07 §五）。`body` 里是带 `{{date:…}}` 这类标记的原文，
 *  展开只发生在"套用"那一刻，之后那就是普通正文（决策 D11） */
export interface Template {
  id: number
  name: string
  scope: 'diary' | 'article'
  body: string
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

/** 侧栏标签树的一个节点。`name` 是归一后的完整路径（`工作/项目a`），
 *  `display` 只是这一级自己的写法——树上一层显示一段，不必把整串摊给用户看。
 *
 *  `count` 由 `EntryTag` 直接数出来：`#a/b/c` 会同时给 a、a/b、a/b/c 各插一行
 *  （见 main/db/tags.ts），所以父节点的计数天然就是「自身 + 子孙」的合计。 */
export interface TagNode {
  id: number
  name: string
  display: string
  /** 调色板下标 0..7，对应 --tag-1 … --tag-8（期-02-设计 §5） */
  color: number
  count: number
  children: TagNode[]
}

/** 一次跨库改名会动到什么程度。确认弹层那句「会改动 N 处 / M 篇」就是它，
 *  必须在动手之前算出来（期-02-设计 §2.3）。 */
export interface RenameImpact {
  /** 会被改动的条目数 */
  entries: number
  /** 一共多少处（一篇里写三遍就是三处） */
  hits: number
}

/** 主题改名的回执：干跑那两个数字之外，多一个「顺手认领了几条悬空」。
 *  `[[还没建出来的主题]]` 早写在正文里，把名字改回它的那一刻就该连上（§10 第 12 项），
 *  那一瞬间 `hits` 是 0——只报 hits 的话这句反馈会变成「0 处跟着搬过去」，等于没说 */
export interface TopicRenameResult extends RenameImpact {
  claimed: number
}

/* ── 属性层（期-02-设计 §2.1、§3.2、§3.3）──
   值的真相在 Entry.props 这一列，类型绑定在 PropKey 表，行为在 shared/props.ts。 */

/** 六种类型，照搬 Obsidian 的属性类型里能落 SQLite 的那几个。
 *  **没有 `tag`**：那样属性值会与正文里的 `#tag` 成标签的两个来源（§2.2）。 */
export type PropType = 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime'

/** 登记过的属性名。`valueCount` 是侧栏第一级那个「有几个不同值」，数的是**第二级的分组数**
 *  （数字按桶计、列表按成员计），所以它不等于「填过的条目数」。 */
export interface PropKeyInfo {
  name: string
  type: PropType
  /** 面板与侧栏的稳定顺序：新登记的排到最后 */
  ordinal: number
  valueCount: number
}

/** 第二级的一个分组。`value === null` 是「（未填）」那一组（§3.3：不然按 mood 分组
 *  看不到没写 mood 的那批，会让人以为筛选漏了）。 */
export interface PropValueGroup {
  value: string | null
  count: number
}

/** `prop:values` 的返回。类型随行给出而不是让渲染层把 name 对应的类型再传回来一遍：
 *  渲染层那份随时可能过期（别的窗口刚改过类型），拿着旧类型去分组会分错。 */
export interface PropValueBuckets {
  type: PropType
  groups: PropValueGroup[]
}

/** 改类型前先扫一遍现值：能转换的多少篇、要丢的多少篇 + 前三个样本（§3.2 末段）。 */
export interface PropConversion {
  convertible: number
  dropped: number
  samples: string[]
}

/* ── 收藏（期-02-设计 §3.4）── */

/** 收藏指向哪一类。`ref` 是多态的行号，所以表上没有外键（§4.1 那段注释）。 */
export type BookmarkKind = 'entry' | 'topic' | 'tag'

/** 一行收藏 + 它现在指向什么状态。
 *
 *  `title` 存的是**收藏那一刻**的名字，条目回头改名也认得出当初收的是什么（§4.1）。
 *  `state` 是读的时候现查出来的三态，不是库里的一列：
 *  - `ok`：正常，点得动
 *  - `deleted`：那条记录在回收站里（§3.4：标灰 + 徽章，而不是从列表里消失）
 *  - `gone`：行整个没了。彻底删除条目时 `purge()` 会连收藏一起清，所以这一态实际只可能
 *    来自标签合并或主题删除——留着它比假装「不可能发生」便宜：那一行还在库里，
 *    列表就得能把它画出来并允许取消收藏，否则用户只剩 SQL 可走。 */
export interface Bookmark {
  id: number
  kind: BookmarkKind
  ref: number
  title: string
  createdAt: string
  state: 'ok' | 'deleted' | 'gone'
}

/** 全文索引引擎的进度。`state` 与 `main/db/fts.ts` 的 `FtsState` 同一套值。
 *  搜索面板那句「索引建立中（已完成 N%）」就是它（期-03-设计 §4.5）。 */
export interface FtsStatus {
  state: 'pending' | 'building' | 'ready'
  done: number
  total: number
}

/** 这次查询走的是哪条路，面板底部与探针都靠它自证：
 *  `match` = 有 ≥3 字的词走了 FTS5 短语查询；`like` = 全靠 1~2 字词的同表 `LIKE`；
 *  `scan` = 索引还没追平，整条查询打到原表 `Entry`（期-03-设计 §5.2）。 */
export type SearchPath = 'match' | 'like' | 'scan'

/** 三档排序（期-06b-2 §三）。三档说的是"怎么排"，与 `SearchPath` 的"怎么找"正交：
 *  - `relevance` 不带任何时间项。MATCH 档就是 bm25，LIKE 档用那条便宜的相关度
 *  - `recent` 按 `entry_date` 倒序
 *  - `blend` = `1/log2(2+名次) × 0.5^(age/730)`，半衰期是扫出来的（§0.5），不是拍的 */
export type SearchOrder = 'relevance' | 'recent' | 'blend'

/** 一行搜索结果。上下文与命中区间在主进程算好后交过来（期-03-设计 §5.3）：
 *  高亮是 `--accent` 下划线 + 底色，不是 `<mark>`，所以 IPC 上跑的是**区间**而不是 HTML
 *  ——把 `<b>` 拼好再送过来，等于把渲染层的样式决定搬进了数据库。 */
export interface SearchResultRow {
  id: number
  kind: EntryKind
  title: string | null
  entryDate: string
  updatedAt: string
  /** 元信息那行的主题名；没有归属时为 null */
  topicName: string | null
  /** 首个命中附近一段（前后各约 24 字，换行压成空格）。只命中标题时为 null */
  excerpt: string | null
  /** `excerpt` 内的命中区间，左闭右开、码元下标 */
  hits: Array<[number, number]>
  /** 命中在 `content` 里的绝对码元下标，§4.4 定位用。只命中标题时为 null */
  pos: number | null
}

export interface SearchResult {
  rows: SearchResultRow[]
  /** 候选集大小，**封顶在 2000**（§5.3）。所以它是「至少这么多」的意思 */
  total: number
  /** 撞了候选上限：面板该说「命中 2000+」而不是「命中 2000」 */
  capped: boolean
  path: SearchPath
  /** 这批行是按哪档排的，原样回显。面板底部那句、以及验收里"三档确实换了序"的判据都读它，
   *  不读面板自己的 state——那样至少能发现"发了 blend 拿回 relevance"这一类接错线的错 */
  order: SearchOrder
  status: FtsStatus
}

/** 渲染进程可用的 API，由 preload 注入；主进程侧一一对应注册。
 *  刻意不暴露「执行任意 SQL」的通道——只暴露具体的领域操作。 */
export interface KestrelApi {
  entries: {
    listByDate(date: string): Promise<Entry[]>
    get(id: number): Promise<Entry | null>
    /** 取某天的日记，没有则按需创建——「打开就是今天」这条路径靠它 */
    ensureDiary(date: string): Promise<Entry>
    create(input: CreateEntryInput): Promise<Entry>
    /** 部分更新；链接层重解析将来挂在这里 */
    update(id: number, patch: EntryPatch): Promise<Entry>
    /** 只回 id / title / kind / entryDate（期-09a 的标签条）。库里没有的那几个 id 直接不出现 */
    labels(
      ids: number[]
    ): Promise<{ id: number; title: string | null; kind: EntryKind; entryDate: string }[]>
    /** 软删除，进回收站 */
    remove(id: number): Promise<void>
    recent(limit: number): Promise<EntrySummary[]>
    countByDay(from: string, to: string): Promise<DayCount[]>
    listByTopic(topicId: number): Promise<EntrySummary[]>
    /** 升格：日记 → 文章。改属性不复制内容，并把来源日记的日期记在 promotedAt 上 */
    promote(id: number, input: PromoteInput): Promise<Entry>
    /** 回收站：已软删的记录，按删除时间倒序 */
    listDeleted(): Promise<EntrySummary[]>
    /** 从回收站取回。这天已经有日记时会失败而不是覆盖 */
    restore(id: number): Promise<Entry>
    /** 彻底删除。会连带清掉它的历史版本与所有链接（Link 没有外键，得手工清） */
    purge(id: number): Promise<void>
    /** 某天升格出来的文章。日记页那条「已升格」横幅靠它 */
    listPromotedOn(date: string): Promise<EntrySummary[]>
    /** 某个主题的编年史（期-06b-2 §一）：原料与成品按时间串成一条线 */
    chronicle(topicId: number): Promise<ChronicleRow[]>
    /** 严格早于 `date` 的那一篇日记（期-07 §五：`{{last_entry}}` 要的就是它）。
     *  一篇都没有返回 null，界面上说「这是第一篇」 */
    prevDiary(date: string): Promise<EntrySummary | null>
    /** 随机一篇活着的（期-09c）：`except` 传上一次随机到的 id，连按就不会给出同一篇。
     *  库里一篇都没有（或只有 `except` 那一篇）返回 null */
    randomId(except?: number): Promise<number | null>
  }
  topics: {
    list(): Promise<Topic[]>
    create(name: string): Promise<Topic>
    /** 图标 / 颜色 / 归档 / 排序。名字不在这里改，见 `TopicPatch` */
    update(id: number, patch: TopicPatch): Promise<Topic>
    /** 改名。`rewriteLinks` 是 §8-D4 那个勾选框：带着全库正文里的 `[[旧名]]` 一起走 */
    rename(id: number, to: string, rewriteLinks: boolean): Promise<TopicRenameResult>
    /** 改名前先问代价，与 `tags.impact` 同形 */
    impact(from: string): Promise<RenameImpact>
    /** 删除。主题下有文章时拦住，`detach` 是弹层给的那条出路（清空归属，内容一篇不动） */
    remove(id: number, detach: boolean): Promise<void>
    /** 按数组下标写回 `sort_order` */
    reorder(orderedIds: number[]): Promise<void>
  }
  /** 标签只有一个来源：正文里的 `#tag`（期-02-设计 §2.2）。所以这里没有「新建标签」
   *  这个动作，能做的只有看、筛、改名。 */
  tags: {
    /** 整棵树，一次取全。个人量级下几百个标签，不必分页 */
    tree(): Promise<TagNode[]>
    /** 这个标签（含子孙）下有哪些条目，按日期倒序分页 */
    entries(tagId: number, limit: number, offset: number): Promise<EntrySummary[]>
    /** 改名前先问代价：会动几篇 / 几处 */
    impact(from: string): Promise<RenameImpact>
    /** 跨全库改正文里的 `#tag`（子孙一起搬）。改前每篇留一版，这就是它的撤销 */
    rename(from: string, to: string): Promise<RenameImpact>
  }
  /** 属性：值在 `Entry.props`，类型绑定在 `PropKey`（期-02-设计 §2.1）。
   *  名字与类型的绑定是全局的，所以这里没有「这一篇的 mood 是什么类型」这种问法。 */  props: {
    /** 第一级：登记过的属性名，按 ordinal。顺带把 props 里见过的名字补登记（§4.3） */
    keys(): Promise<PropKeyInfo[]>
    /** 第二级：某个属性的值分组（含「未填」那一组）。类型随行给出，不让渲染层回传 */
    values(name: string): Promise<PropValueBuckets>
    /** 第三级：某组的条目。`value === null` 就是「未填」 */
    entries(
      name: string,
      value: string | null,
      limit: number,
      offset: number
    ): Promise<EntrySummary[]>
    /** 添加属性 / 改类型（改类型会按新类型过一遍全库的值，丢的动手前留一版历史） */
    keyPut(name: string, type: PropType): Promise<void>
    /** 改类型之前的 dry-run：N 篇能转换、M 篇会被丢、前三个样本 */
    keyConvert(name: string, to: PropType): Promise<PropConversion>
    /** 只改绑定与 `props` 的键名，**不动正文**（§4.5） */
    keyRename(from: string, to: string): Promise<void>
  }
  /** 收藏：一条 `Bookmark` 行，指向 entry / topic / tag 三类之一（§3.4）。
   *  收藏不复制内容，指的就是那一行本体，所以被收藏的东西改名/进回收站都会反映到这里。 */
  bookmarks: {
    /** 全部收藏，按收藏时间倒序（新收藏在前）。没有分页：个人量级下这就是几十行 */
    list(): Promise<Bookmark[]>
    /** 收藏 / 取消收藏，返回**操作之后**的状态（true = 现在收藏着）。
     *  `title` 只在新增那一次落库，是收藏那一刻的名字快照 */
    toggle(kind: BookmarkKind, ref: number, title: string): Promise<boolean>
  }
  links: {
    /** 谁指向这篇。自指（日记里写 [[今天]]）不算 */
    backlinks(entryId: number): Promise<Backlink[]>
    /** 当前记录 N 跳内的邻居，右栏那个同心环图 */
    graph(entryId: number, depth: number): Promise<LocalGraph>
    /** 全库拓扑，期-06a 那个全屏图谱。**只回拓扑不回坐标**，布局在渲染层求解 */
    graphAll(): Promise<GlobalGraph>
    /** 这篇指向谁：正文里每一条链接落到了哪，编辑器照着分型着色 */
    outgoing(entryId: number): Promise<OutgoingLink[]>
  }
  /** 全文搜索（期-03）。查询串的语法只有一份实现：`shared/query.ts`。
   *  空串**不该发过来**（面板自己拦，见 §10 第 8 项），主进程再兜一道。 */
  search: {
    run(query: string, limit?: number, order?: SearchOrder): Promise<SearchResult>
  }
  /** 索引引擎的进度。只有轮询没有推送：回调跨不过 IPC（§5.2） */
  fts: {
    status(): Promise<FtsStatus>
  }
  /** 查询块（期-07）。渲染层只递语句原文、只收行：
   *  解析与 SQL 都在主进程，界面上也没有地方能拼出一句 SQL 来 */
  query: {
    run(body: string): Promise<{ result: QueryResult } | { error: { line: number; col: number; msg: string } }>
  }
  saved: {
    list(): Promise<SavedQuery[]>
    create(name: string, body: string): Promise<SavedQuery>
    update(id: number, patch: { name?: string; body?: string }): Promise<SavedQuery>
    remove(id: number): Promise<void>
    /** 只是把 `used_at` 推到今天，让「最近用的排在前面」这条排序有意义 */
    used(id: number): Promise<void>
  }
  templates: {
    list(): Promise<Template[]>
    create(t: { name: string; scope: Template['scope']; body: string; isDefault?: boolean }): Promise<Template>
    update(
      id: number,
      patch: { name?: string; body?: string; isDefault?: boolean }
    ): Promise<Template>
    remove(id: number): Promise<void>
  }
  /** 流通（期-08）。导出/导入都在主进程做——渲染层拿不到 fs，也不该拿到。
   *  目录由系统对话框选，渲染层只拿到一个字符串路径。 */
  transfer: {
    /** 打开「选文件夹」对话框；取消返回 null。`import` 那一档不给「新建目录」的按钮 */
    pickDirectory(mode?: 'export' | 'import'): Promise<string | null>
    exportPlan(dir: string): Promise<ExportPlan>
    exportRun(dir: string): Promise<ExportResult>
    /** 进度是**拉**不是推：大库（实测 6001 篇那份）导出要看得见它在动，
     *  但不必为这一个数字开一条事件通道 */
    exportProgress(): Promise<ExportProgress>
    /** 中止正在跑的导出（`export.ts` 的 requestCancel）。只对**正在跑**的那一次有效 */
    exportCancel(): Promise<void>
    importPlan(dir: string): Promise<ImportPlan>
    importRun(dir: string): Promise<ImportResult>
    importProgress(): Promise<ImportProgress>
    importCancel(): Promise<void>
  }
  settings: {
    all(): Promise<Settings>
    patch(patch: Partial<Settings>): Promise<Settings>
  }
  /** 备份与恢复（期-08 §四）。目录固定在 `<userData>/backups`，渲染进程给不出也不该给出路径：
   *  所有方法只认文件名，主进程那一侧再拼回目录（拼错了也跑不出去）。 */
  backup: {
    status(): Promise<BackupStatus>
    /** 立即落一份（`VACUUM INTO`），并按保留名额滚掉最旧的 */
    now(): Promise<BackupRun>
    /** 换到某一份快照。之前会把当前库存成 `kestrel-before-restore-*`，之后界面要重读一遍 */
    restore(name: string): Promise<RestoreResult>
    /** 手动跑一次 30 天那一刀（自动那一跑在开屏之后，这里只是给人对着账） */
    prune(): Promise<{ revisions: number; entries: number }>
  }
  /** 工作区（期-09a）：开着哪几篇、哪个在当前、各自滚到哪儿。
   *  `load` 认不出来就返回 null（当没有，界面退回今天）；走这条而不是 `settings.*` 的理由写在
   *  `shared/workspace.ts` 头上。 */
  workspace: {
    load(): Promise<Workspace | null>
    save(ws: Workspace): Promise<boolean>
  }
  /** CSS 片段（期-09b）。只有「问」和「听」两条，没有「写」——写由人在文件管理器里做，
   *  应用不把用户手写的 .css 变成第二套编辑面。 */
  snippets: {
    list(): Promise<Snippet[]>
    /** 目录变了的一声铃。回调不带文件名（M4：一次保存 4 个事件，名字不可信） */
    onChanged(cb: () => void): () => void
  }
  /** 打开 Kestrel 自己的目录（设置页那几颗「打开这个文件夹」）。名字是闭集，路径在主进程拼 */
  shell: {
    openDir(which: 'snippets' | 'backups'): Promise<boolean>
    info(): Promise<AppInfo>
  }
  revisions: {
    list(entryId: number): Promise<RevisionSummary[]>
    /** 取正文。列表刻意不带 content，预览时才取这一份 */
    get(id: number): Promise<Revision | null>
    /** 恢复到这一版。**会先把当前状态存一份**（reason='restore'），否则恢复不可逆 */
    restore(id: number): Promise<Entry>
    /** 手动存一版（Ctrl+S 走它），总是写 */
    snapshot(entryId: number): Promise<void>
  }
  /** 附件（期-04 §5）。渲染进程碰不到裸 fs，落盘只在主进程这一侧做：
   *  收字节 → sha1 → 扩展名白名单 → 写进 `<userData>/attachments/<sha1>.<ext>`，
   *  回内容寻址后的文件名。同图重复导入靠 sha1 命中去重。 */
  attachments: {
    /** 导入一份附件，返回 `<sha1>.<ext>`。`name` 只用来取扩展名，正文里不留原始文件名 */
    import(name: string, data: Uint8Array): Promise<string>
  }
  /** 自绘标题栏后系统按钮没了，必须自己提供，否则窗口关不掉 */
  win: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    /** 最大化状态变化（含双击标题栏、系统快捷键触发的情形） */
    onMaximizeChange(cb: (maximized: boolean) => void): () => void
    /** 主进程即将关窗：把防抖里最后一次编辑落盘，落完调 flushDone 放行。
     *  没有这一问的话，按 × 前 500ms 内敲的字会整个丢掉（实测，见期-01 设计 §4.6） */
    onFlushRequest(cb: () => void): () => void
    flushDone(): void
  }
  /** 开发版的裸 SQL 通道。**打包版这个键根本不存在**（preload 按主进程传来的条件挂，
   *  主进程那边也不注册 handler），所以 §10 第 12 项测的是 `in window.kestrel` 而不是「调了报错」。 */
  __dev?: {
    sql(query: string): Promise<unknown[]>
  }
}

export const IPC = {
  entryListByDate: 'entry:listByDate',
  entryGet: 'entry:get',
  entryEnsureDiary: 'entry:ensureDiary',
  entryCreate: 'entry:create',
  entryUpdate: 'entry:update',
  entryRemove: 'entry:remove',
  entryRecent: 'entry:recent',
  /** 只取「这一篇叫什么」（期-09a §四）。标签条给每一格配名字用，
   *  刻意不拿 `entry:get` 挨个取——那一趟连正文一起搬过 IPC */
  entryLabels: 'entry:labels',
  entryCountByDay: 'entry:countByDay',
  entryListByTopic: 'entry:listByTopic',
  entryPromote: 'entry:promote',
  entryListDeleted: 'entry:listDeleted',
  entryRestore: 'entry:restore',
  entryPurge: 'entry:purge',
  entryListPromotedOn: 'entry:listPromotedOn',
  /** 主题编年史（期-06b-2 §一）：一个主题下的条目按 `promoted_at ?? created_at` 排成的时间线 */
  entryChronicle: 'entry:chronicle',
  /** 随机一篇活着的（期-09c §二）：`except` 是上一次随机到的 id，撞上就重摇一次 */
  entryRandomId: 'entry:randomId',
  topicList: 'topic:list',
  topicCreate: 'topic:create',
  topicUpdate: 'topic:update',
  topicRename: 'topic:rename',
  topicImpact: 'topic:impact',
  topicRemove: 'topic:remove',
  topicReorder: 'topic:reorder',
  tagTree: 'tag:tree',
  tagEntries: 'tag:entries',
  tagImpact: 'tag:impact',
  tagRename: 'tag:rename',
  propKeys: 'prop:keys',
  propValues: 'prop:values',
  propEntries: 'prop:entries',
  propKeyPut: 'prop:keyPut',
  propKeyConvert: 'prop:keyConvert',
  propKeyRename: 'prop:keyRename',
  bookmarkList: 'bookmark:list',
  bookmarkToggle: 'bookmark:toggle',
  revisionList: 'revision:list',
  revisionGet: 'revision:get',
  revisionRestore: 'revision:restore',
  revisionSnapshot: 'revision:snapshot',
  /** 附件导入：字节进来、内容寻址后的文件名出去（期-04 §5.2）。只收字节，路径与
   *  落盘全在主进程那一侧，渲染进程给不出目标路径。 */
  attachmentImport: 'attachment:import',
  linkBacklinks: 'link:backlinks',
  linkGraph: 'link:graph',
  linkGraphAll: 'link:graphAll',
  linkOutgoing: 'link:outgoing',
  settingsAll: 'settings:all',
  settingsPatch: 'settings:patch',
  searchRun: 'search:run',
  ftsStatus: 'fts:status',
  /** 查询块跑一次（期-07 §二）。传**语句原文**，解析与翻译都在主进程：
   *  渲染进程拿不到 SQL 文本，也就塞不进 SQL 文本 */
  queryRun: 'query:run',
  savedList: 'saved:list',
  savedCreate: 'saved:create',
  savedUpdate: 'saved:update',
  savedRemove: 'saved:remove',
  savedUsed: 'saved:used',
  tplList: 'tpl:list',
  tplCreate: 'tpl:create',
  tplUpdate: 'tpl:update',
  tplRemove: 'tpl:remove',
  /** 上一篇日记（`{{last_entry}}` 要的那一条）。按 entry_date 严格早于给定日期 */
  entryPrevDiary: 'entry:prevDiary',
  /** 裸 SQL 通道。**只在非打包版注册**（期-03-设计 §8-D6）：本期所有 FTS 的 DDL 与
   *  探针只能在 Electron 主进程那份 SQLite 上跑（§2.1：系统 node 的 3.47 没有 FTS5），
   *  要有自动验收就得能跑建表和 pragma。打包版这个 handler 不是"锁起来"，是不存在。 */
  /** 流通（期-08）：目录由主进程弹系统对话框选，渲染层只拿路径字符串 */
  transferPick: 'transfer:pick',
  exportPlan: 'export:plan',
  exportRun: 'export:run',
  exportProgress: 'export:progress',
  exportCancel: 'export:cancel',
  importPlan: 'import:plan',
  importRun: 'import:run',
  importProgress: 'import:progress',
  importCancel: 'import:cancel',
  backupStatus: 'backup:status',
  backupNow: 'backup:now',
  backupRestore: 'backup:restore',
  backupPrune: 'backup:prune',
  /** 工作区（期-09a）：开着哪几篇、哪个在当前、各自滚到哪儿。独立于 settings:* 的两条，理由见 shared/workspace.ts 头上 */
  workspaceLoad: 'workspace:load',
  workspaceSave: 'workspace:save',
  /** CSS 片段（期-09b）：清单只读，主进程那侧拼路径，渲染进程给不出也不该给出路径 */
  snippetList: 'snippet:list',
  /** 关于那一格：版本 / schema / 库在哪 / 两个目录在哪 */
  appInfo: 'app:info',
  /** 主进程 watching 到目录变了 ⇒ 推一声。渲染层收到就去 `snippet:list` 重问一遍，
   *  不信这一声里带的文件名（M4 实测：一次保存给 4 个事件，名字与类型都不可信） */
  snippetChanged: 'snippet:changed',
  /** 打开 Kestrel 自己的目录。只认闭集名字（§七 决策 48）：一个接受任意字符串去
   *  `shell.openPath` 的通道，等于把「让资源管理器打开任何目录」交给渲染层 */
  shellOpenDir: 'shell:openDir',
  devSql: 'dev:sql',
  winMinimize: 'win:minimize',
  winToggleMaximize: 'win:toggleMaximize',
  winClose: 'win:close',
  winMaximizeChanged: 'win:maximizeChanged',
  /** 关窗前的落盘握手：主进程问一次，渲染层 flush 完回一声 */
  winFlushRequest: 'win:flushRequest',
  winFlushed: 'win:flushed',
} as const