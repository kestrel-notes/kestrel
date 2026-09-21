/** 主进程与渲染进程共享的类型与通道名。
 *  只有类型和常量，不含副作用——两边都会 import。 */

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
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'cloud',
  accent: null,
  blur: 22,
  sat: 1.7,
  glass: true,
  followSystem: false,
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
    /** 这篇指向谁：正文里每一条链接落到了哪，编辑器照着分型着色 */
    outgoing(entryId: number): Promise<OutgoingLink[]>
  }
  settings: {
    all(): Promise<Settings>
    patch(patch: Partial<Settings>): Promise<Settings>
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
}

export const IPC = {
  entryListByDate: 'entry:listByDate',
  entryGet: 'entry:get',
  entryEnsureDiary: 'entry:ensureDiary',
  entryCreate: 'entry:create',
  entryUpdate: 'entry:update',
  entryRemove: 'entry:remove',
  entryRecent: 'entry:recent',
  entryCountByDay: 'entry:countByDay',
  entryListByTopic: 'entry:listByTopic',
  entryPromote: 'entry:promote',
  entryListDeleted: 'entry:listDeleted',
  entryRestore: 'entry:restore',
  entryPurge: 'entry:purge',
  entryListPromotedOn: 'entry:listPromotedOn',
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
  linkBacklinks: 'link:backlinks',
  linkGraph: 'link:graph',
  linkOutgoing: 'link:outgoing',
  settingsAll: 'settings:all',
  settingsPatch: 'settings:patch',
  winMinimize: 'win:minimize',
  winToggleMaximize: 'win:toggleMaximize',
  winClose: 'win:close',
  winMaximizeChanged: 'win:maximizeChanged',
  /** 关窗前的落盘握手：主进程问一次，渲染层 flush 完回一声 */
  winFlushRequest: 'win:flushRequest',
  winFlushed: 'win:flushed',
} as const