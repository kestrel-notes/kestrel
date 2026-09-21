import { useStore, entryLabel, type AppState } from '@/store'
import { todayKey } from '../../shared/date'

/** 命令分组。命令面板按这个顺序分组显示，顺序即优先级。 */
export type CommandGroup = '跳转' | '新建' | '视图' | '编辑器' | '数据'

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
// Ctrl+F    站内搜索        —— 第 3 期
// Ctrl+Shift+F 被「专注模式」占用（已发布），所以搜索用 Ctrl+F 而不是 Obsidian 的 Ctrl+Shift+F

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
  {
    id: 'view.settings',
    title: '设置 · 外观',
    group: '视图',
    keys: ['Ctrl+,'],
    run: (s) => s.setSheetOpen(true),
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
    id: 'editor.toggleMode',
    title: '源码 ⇄ 所见即所得',
    group: '编辑器',
    keys: ['Ctrl+Shift+M'],
    enabled: (s) => s.currentId !== null,
    run: (s) => void s.switchEditorMode(s.editorMode === 'rich' ? 'source' : 'rich'),
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
    id: 'view.bookmarks',
    title: '收藏列表',
    group: '视图',
    // 空的时候也要能进来：两条浮层自己都有空态可看，而把命令藏掉会让
    // 「Ctrl+K 搜回收站」这类引导话术落空（首次启动种下的示例正文就是这么写的）
    run: (s) => s.setBookmarkOpen(true),
  },
  {
    id: 'topic.manage',
    title: '主题管理 · 改名 / 图标 / 颜色 / 归档 / 删除',
    group: '视图',
    run: (s) => s.setTopicSheetOpen(true),
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