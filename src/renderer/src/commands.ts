import { useStore, entryLabel, type AppState } from '@/store'
import { getRichEditor } from '@/editor/richView'
import { todayKey } from '../../shared/date'

/** 命令分组。命令面板按这个顺序分组显示，顺序即优先级。 */
export type CommandGroup = '跳转' | '新建' | '视图' | '工作区' | '编辑器' | '数据'

/** 一条命令。**这是快捷键与命令面板的唯一真相源**：
 *  `App.tsx` 的 keydown 照着它匹配，命令面板照着它列表。
 *  两处各写一份的话，改一次键位就得记得改两处，迟早对不上。 */
export interface Command {
  id: string
  title: string
  group: CommandGroup
  /** 展示用 + 匹配用。写法是 `Ctrl+Shift+M`；macOS 上 `Ctrl` 表示 Cmd（见 keyOf） */
  keys?: string[]
  /** 不满足就既不给快捷键、也不让面板里执行。用来挡「没有当前文档」这类情况 */
  enabled?: (s: AppState) => boolean
  run: (s: AppState) => void | Promise<void>
}

/** 保留键位——**只有注释，不做成 `enabled: () => false` 的命令**。
 *  禁用命令会在面板里显示成一条永远点不动的项，比不显示更让人困惑。
 *  写在这里是为了「这个键位已经被预定」这件事有据可查，不会被别的功能顺走。 */
// Ctrl+Shift+F 不给站内搜索——它已属于专注模式（期-03 设计 §4.3），
// 所以搜索用 Ctrl+F 而不是 Obsidian 的 Ctrl+Shift+F

/** 主键取 `e.code` 而不是 `e.key`：Shift 按下时 `e.key` 对字母变大写、对数字变符号
 *  （Shift+1 是 `!`），拿它拼键位会漏掉所有带 Shift 的组合。 */
function mainKey(e: KeyboardEvent): string | null {
  const c = e.code
  if (/^Key[A-Z]$/.test(c)) return c.slice(3)
  if (/^Digit[0-9]$/.test(c)) return c.slice(5)
  if (/^F[0-9]{1,2}$/.test(c)) return c

  const named: Record<string, string> = {
    Comma: ',',
    Period: '.',
    Slash: '/',
    Minus: '-',
    Equal: '=',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Escape: 'Escape',
    Enter: 'Enter',
    Space: 'Space',
    // 期-09a 的标签循环用 Ctrl+Tab、挪位用左右方向键：这三个键以前没人占，所以没登记过
    Tab: 'Tab',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  }
  return named[c] ?? null
}

/** 把键盘事件归一成注册表里的键位写法。Ctrl 与 Cmd 视为同一个修饰键——
 *  在 macOS 上按 Cmd+Shift+M 得到的也是 `Ctrl+Shift+M`，所以表里只需要写一套。 */
export function keyOf(e: KeyboardEvent): string | null {
  const main = mainKey(e)
  if (!main) return null

  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  return [...parts, main].join('+')
}

const isMac = navigator.userAgent.includes('Mac')

/** 键位的显示写法。macOS 上换成 `⌘⇧M` 的样子——`Ctrl` 写在 mac 上会让人以为要按 Control 键。 */
export function keyLabel(key: string): string {
  if (!isMac) return key
  return key
    .replace(/Ctrl\+/g, '⌘')
    .replace(/Shift\+/g, '⇧')
    .replace(/Alt\+/g, '⌥')
    .replace(/⌘⇧/, '⇧⌘')
}

/** **数组顺序 = 命令面板里的分组顺序**（面板按首次出现的次序排分组），
 *  所以这里按「最常用的在上」排，而不是按功能类别整齐排。 */
export const COMMANDS: Command[] = [
  {
    id: 'view.diary',
    title: '切到「今天」',
    group: '视图',
    keys: ['Ctrl+1'],
    run: (s) => void s.setMode('diary'),
  },
  {
    id: 'view.topic',
    title: '切到「主题」',
    group: '视图',
    keys: ['Ctrl+2'],
    run: (s) => void s.setMode('topic'),
  },
  {
    id: 'view.tag',
    title: '切到「标签」',
    group: '视图',
    keys: ['Ctrl+3'],
    run: (s) => void s.setMode('tag'),
  },
  {
    id: 'view.prop',
    title: '切到「属性」',
    group: '视图',
    keys: ['Ctrl+4'],
    run: (s) => void s.setMode('prop'),
  },
  {
    id: 'view.focus',
    title: '专注模式',
    group: '视图',
    keys: ['Ctrl+Shift+F'],
    run: (s) => s.toggleFocus(),
  },
  /* ── 工作区（期-09a §三）。分组紧跟着「视图」：标签页就是看东西的那一层 ── */
  {
    id: 'workspace.newTab',
    title: '在新标签里打开…',
    group: '工作区',
    keys: ['Ctrl+T'],
    // 与 Ctrl+O 同一个面板，只是选中之后的落点换成新标签
    run: (s) => void s.openPalette('switch', true),
  },
  {
    id: 'workspace.closeTab',
    title: '关掉当前标签',
    group: '工作区',
    keys: ['Ctrl+W'],
    /** 最后一个不关、固定的也不关（决策 33）。这里刻意**不**兜到「关窗口」——
     *  那一刀底下是关窗前那条 flush 链，误按一次会让人以为软件把他窗口弄没了 */
    enabled: (s) => s.tabs.length > 1,
    run: (s) => void s.closeTab(s.activeTab),
  },
  {
    id: 'workspace.nextTab',
    title: '切到下一个标签',
    group: '工作区',
    keys: ['Ctrl+Tab'],
    enabled: (s) => s.tabs.length > 1,
    run: (s) => void s.cycleTab(1),
  },
  {
    id: 'workspace.prevTab',
    title: '切到上一个标签',
    group: '工作区',
    keys: ['Ctrl+Shift+Tab'],
    enabled: (s) => s.tabs.length > 1,
    run: (s) => void s.cycleTab(-1),
  },
  {
    id: 'workspace.moveLeft',
    title: '当前标签往左挪',
    group: '工作区',
    keys: ['Ctrl+Shift+Left'],
    enabled: (s) => s.tabs.length > 1,
    run: (s) => s.moveTab(s.activeTab, -1),
  },
  {
    id: 'workspace.moveRight',
    title: '当前标签往右挪',
    group: '工作区',
    keys: ['Ctrl+Shift+Right'],
    enabled: (s) => s.tabs.length > 1,
    run: (s) => s.moveTab(s.activeTab, 1),
  },
  {
    id: 'workspace.togglePin',
    title: '固定 / 取消固定当前标签',
    group: '工作区',
    run: (s) => s.togglePin(s.activeTab),
  },
  {
    id: 'view.settings',
    title: '设置',
    group: '视图',
    keys: ['Ctrl+,'],
    run: (s) => s.setSheetOpen(true, 'look'),
  },
  {
    id: 'view.settingsSnippets',
    title: '设置 · CSS 片段',
    group: '视图',
    run: (s) => s.setSheetOpen(true, 'snippets'),
  },
  {
    id: 'view.snippetsPause',
    title: '暂停全部片段（本次会话）',
    group: '视图',
    // 再按一次就恢复。这一颗存在的全部理由：片段能把界面改到设置页本身都摸不到（期-09b §七 决策 44）
    run: (s) => {
      const next = !s.snippetsPaused
      s.setSnippetsPaused(next)
      s.notify(next ? '本次会话不再挂任何片段（界面已回到主题本身）' : '片段已挂回来')
    },
  },
  {
    id: 'data.snippetsReload',
    title: '重读 CSS 片段',
    group: '数据',
    run: (s) => {
      void s.reloadSnippets().then(() =>
        s.notify(
          `片段目录里 ${s.snippets.length} 份，挂着 ${s.snippets.filter((x) => x.on && x.css !== null).length} 份`
        )
      )
    },
  },
  {
    id: 'view.palette',
    title: '命令面板',
    group: '视图',
    keys: ['Ctrl+K', 'Ctrl+P'],
    run: (s) => void s.openPalette('command'),
  },
  {
    id: 'view.switch',
    title: '快速切换 · 跳到某条记录或主题',
    group: '跳转',
    keys: ['Ctrl+O'],
    run: (s) => void s.openPalette('switch'),
  },
  {
    id: 'view.search',
    title: '站内搜索',
    group: '跳转',
    keys: ['Ctrl+F'],
    run: (s) => s.openSearch(),
  },
  {
    id: 'view.graph',
    title: '打开全局图谱',
    group: '视图',
    // Ctrl+G 已核：注册表里没占用（期-06a §5.4）。与输入法撞了就退回只走命令面板（§七 反转条件）
    keys: ['Ctrl+G'],
    run: (s) => {
      s.setGraphMode('force')
      s.setGraphOpen(true)
    },
  },
  {
    id: 'view.graphTime',
    title: '打开全局图谱 · 时间轴',
    group: '视图',
    // Ctrl+Shift+G 已核：注册表里没占用（期-06b §5.4）
    keys: ['Ctrl+Shift+G'],
    run: (s) => {
      s.setGraphMode('time')
      s.setGraphOpen(true)
    },
  },
  {
    id: 'view.slides',
    title: '演示这一篇（幻灯片）',
    group: '视图',
    // 不配默认键位：这一条进的是覆盖层，而 `Space`/方向键那一批在层里本地处理，
    // 登记进全局命令表就会吃掉编辑器与列表的同名键（设计稿决策 57）
    enabled: (s) => s.entry !== null,
    run: (s) => s.openSlides(),
  },
  {
    id: 'go.random',
    title: '随机打开一篇',
    group: '跳转',
    run: (s) => void s.randomEntry(),
  },
  {
    id: 'tag.focus',
    title: '焦点给标签树',
    group: '跳转',
    keys: ['Ctrl+Shift+T'],
    run: (s) => s.focusTagTree(),
  },
  {
    id: 'entry.new',
    title: '新建',
    group: '新建',
    keys: ['Ctrl+N'],
    enabled: (s) => s.mode === 'diary' || s.activeTopicId !== null,
    run: (s) => (s.mode === 'diary' ? void s.openDate(todayKey()) : void s.newArticle()),
  },
  {
    id: 'editor.cycleMode',
    title: '循环切换编辑器模式（阅读 → 所见即所得 → 源码）',
    group: '编辑器',
    keys: ['Ctrl+Shift+M'],
    enabled: (s) => s.currentId !== null,
    run: (s) => {
      const next = s.editorMode === 'reading' ? 'rich' : s.editorMode === 'rich' ? 'source' : 'reading'
      void s.switchEditorMode(next)
    },
  },
  {
    id: 'editor.mode.reading',
    title: '切到阅读视图',
    group: '编辑器',
    enabled: (s) => s.currentId !== null && s.editorMode !== 'reading',
    run: (s) => void s.switchEditorMode('reading'),
  },
  {
    id: 'editor.mode.rich',
    title: '切到所见即所得',
    group: '编辑器',
    enabled: (s) => s.currentId !== null && s.editorMode !== 'rich',
    run: (s) => void s.switchEditorMode('rich'),
  },
  {
    id: 'editor.mode.source',
    title: '切到源码模式',
    group: '编辑器',
    enabled: (s) => s.currentId !== null && s.editorMode !== 'source',
    run: (s) => void s.switchEditorMode('source'),
  },
  // ── 表格增删行列（§4.6）：TableKit 已装、rich 模式本就能渲染，这里接命令。
  //    入口先只走命令面板（键盘优先）；右键菜单与边缘 +/- 按钮是后续的事。
  //    enabled 读 getRichEditor() 那个单例：命令面板每次渲染、每次按键匹配都会重算，
  //    光标进没进表格当场就有答案，不必往 store 里再塞一份「在不在表格里」。
  {
    id: 'table.insert',
    title: '插入表格（3×3）',
    group: '编辑器',
    enabled: (s) => s.editorMode === 'rich' && !!getRichEditor() && !getRichEditor()?.isActive('table'),
    run: () => {
      getRichEditor()?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    },
  },
  {
    id: 'table.addRowAfter',
    title: '表格 · 在下方插入行',
    group: '编辑器',
    enabled: (s) => s.editorMode === 'rich' && !!getRichEditor()?.isActive('table'),
    run: () => {
      getRichEditor()?.chain().focus().addRowAfter().run()
    },
  },
  {
    id: 'table.deleteRow',
    title: '表格 · 删除当前行',
    group: '编辑器',
    enabled: (s) => s.editorMode === 'rich' && !!getRichEditor()?.isActive('table'),
    run: () => {
      getRichEditor()?.chain().focus().deleteRow().run()
    },
  },
  {
    id: 'table.addColumnAfter',
    title: '表格 · 在右侧插入列',
    group: '编辑器',
    enabled: (s) => s.editorMode === 'rich' && !!getRichEditor()?.isActive('table'),
    run: () => {
      getRichEditor()?.chain().focus().addColumnAfter().run()
    },
  },
  {
    id: 'table.deleteColumn',
    title: '表格 · 删除当前列',
    group: '编辑器',
    enabled: (s) => s.editorMode === 'rich' && !!getRichEditor()?.isActive('table'),
    run: () => {
      getRichEditor()?.chain().focus().deleteColumn().run()
    },
  },
  {
    id: 'table.delete',
    title: '表格 · 删除整张表',
    group: '编辑器',
    enabled: (s) => s.editorMode === 'rich' && !!getRichEditor()?.isActive('table'),
    run: () => {
      getRichEditor()?.chain().focus().deleteTable().run()
    },
  },
  {
    id: 'entry.save',
    title: '手动保存',
    group: '数据',
    keys: ['Ctrl+S'],
    enabled: (s) => s.currentId !== null,
    run: async (s) => {
      await s.snapshotManual()
      // flush 走的是千级毫秒级的 IPC，await 之后 s 已经是旧快照，要读活的
      const after = useStore.getState()
      after.notify(after.dirty ? '还有改动没落盘' : '已保存 · 记一版')
    },
  },
  {
    id: 'entry.promote',
    title: '升格为文章',
    group: '数据',
    enabled: (s) => s.entry?.kind === 'diary',
    run: (s) => s.setPromoteOpen(true),
  },
  {
    id: 'entry.bookmark',
    title: '收藏 / 取消收藏当前记录',
    group: '数据',
    keys: ['Ctrl+D'],
    enabled: (s) => s.currentId !== null,
    // 名字用 label 而不是 title：日记的 title 常是空的，收藏了个「（没有名字）」没意义
    run: (s) => {
      const e = s.entry
      if (e) void s.toggleBookmark('entry', e.id, entryLabel(e))
    },
  },
  {
    id: 'query.block',
    title: '插入查询块',
    group: '编辑器',
    // 斜杠命令 `/查询` 插的是**空**围栏（那边光标就在块里，空着正好开始写）；
    // 这条给源码档用——那边没有斜杠菜单，而且空围栏在源码档什么也不显示
    enabled: (s) => s.currentId !== null,
    run: (s) => void s.insertQuery('table title, entry_date\nlimit 20'),
  },
  {
    id: 'view.bookmarks',
    title: '收藏列表',
    group: '视图',
    // 空的时候也要能进来：两条浮层自己都有空态可看，而把命令藏掉会让
    // 「Ctrl+K 搜回收站」这类引导话术落空（首次启动种下的示例正文就是这么写的）
    run: (s) => s.setBookmarkOpen(true),
  },
  {
    id: 'view.library',
    title: '查询与模板 · 存查询 / 模板管理',
    group: '视图',
    run: (s) => s.setLibraryOpen(true),
  },
  {
    id: 'topic.manage',
    title: '主题管理 · 改名 / 图标 / 颜色 / 归档 / 删除',
    group: '视图',
    run: (s) => s.setTopicSheetOpen(true),
  },
  {
    id: 'view.aliases',
    title: '别名 · 全库写法绑定与解绑',
    group: '视图',
    // 不给键位：入口挂在命令面板里就够了（期-05c §9.2 第 5 件）。这一扇窗的处理频率
    // 与「主题管理」同一档，占一个组合键是给写作添负担
    run: (s) => s.setAliasOpen(true),
  },
  {
    id: 'entry.bin',
    title: '回收站',
    group: '数据',
    // 同「收藏列表」：空着也进得来，浮层自己有「回收站是空的」那一句话。
    // 藏起来的话，示例正文里「Ctrl+K 搜回收站」那条引导就指到了不存在的地方
    run: (s) => s.setBinOpen(true),
  },
  {
    id: 'export.markdown',
    title: '导出为 Markdown · 整库 front-matter 目录树',
    group: '数据',
    // 不配快捷键：这是一年用不了几次的事，占一个键位不如让人搜得到
    run: (s) => {
      s.setTransferTab('export')
      s.setTransferOpen(true)
    },
  },
  {
    id: 'import.markdown',
    title: '从 Markdown 导回 · 只认 Kestrel 自己导出的目录',
    group: '数据',
    // 两条命令分开，是为了让人搜「导入」时不必先进面板再找档——那一档会写库，
    // 中途多一次误点就多一次风险
    run: (s) => {
      s.setTransferTab('import')
      s.setTransferOpen(true)
    },
  },
  {
    id: 'backup.pane',
    title: '备份与恢复 · 一天一份，最近的几份换得回去',
    group: '数据',
    // 只开面板，不在这儿就把那一份落下去：按一次回车就写盘的东西不该做成命令的默认行为
    run: (s) => {
      s.setTransferTab('backup')
      s.setTransferOpen(true)
    },
  },
  {
    id: 'sync.pane',
    title: '文件夹同步 · 推到一个夹，或从那个夹换回来',
    group: '数据',
    // 设计稿 §三 本来列了三条（推 / 拉 / 换一个夹），这里收成一条只开面板：
    // 推与拉都是写盘与换库，"按一次回车就动手"不该是命令的默认行为——与 backup.pane 同一条理由。
    // 面板里那三颗按钮都在，判据不许的那颗是灰的
    run: (s) => {
      s.setTransferTab('sync')
      s.setTransferOpen(true)
    },
  },
  {
    id: 'share.pane',
    title: '分享这一篇 · 写成一个离线能看的 .html',
    group: '数据',
    // 与 backup.pane / sync.pane 同一条理由：按下去会往盘外写一个文件，
    // 命令本身只把面板打开，真动手的是面板里那颗按钮。
    // 也没有键位：一年用不了几次，而它做的事情是"把这篇日记复制一份带出门"。
    enabled: (s) => s.currentId !== null,
    run: (s) => {
      s.setTransferTab('share')
      s.setTransferOpen(true)
    },
  },
  {
    id: 'repeats.global',
    title: '思想重复度 · 全库那些"反复提到却没连"的目标',
    group: '视图',
    // 只把右栏那一块切到全库那一档（期-11b §四）：不另开窗口、不主动弹，
    // 也不给键位——它是一台"偶尔翻一翻"的机器，天天摊着就会被学会忽略
    run: (s) => {
      s.showRepeats(true)
    },
  },
  {
    id: 'entry.remove',
    title: '删除当前记录',
    group: '数据',
    enabled: (s) => s.currentId !== null,
    run: (s) => void s.removeCurrent(),
  },
]

/** 按 `Ctrl+K` 这样的键位找命令。同一键位只应注册一次，重复注册时取先来的——
 *  与其在运行期抛错，不如让顺序决定，规则简单到不用查。 */
export function findByKey(key: string): Command | undefined {
  return COMMANDS.find((c) => c.keys?.includes(key))
}