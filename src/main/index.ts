import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { closeDatabase, openDatabase } from './db'
import * as entries from './db/entries'
import { seedIfFirstRun } from './db/seed'
import * as topics from './db/topics'
import * as tags from './db/tags'
import * as text from './db/text'
import * as links from './db/links'
import * as props from './db/props'
import * as bookmarks from './db/bookmarks'
import * as revisions from './db/revision'
import * as settings from './db/settings'
import {
  IPC,
  type BookmarkKind,
  type CreateEntryInput,
  type EntryPatch,
  type PromoteInput,
  type PropType,
  type Settings,
  type TopicPatch,
} from '../shared/types'

/** 无边框窗口：标题栏由前端自绘（设计系统里标题栏是玻璃层的一部分，
 *  系统标题栏没法做成那样）。代价是窗口按钮得自己提供，见 IPC.win*。 */
const frameless = true
const isMac = process.platform === 'darwin'

/** 图标是 resources/ 下由 scripts/make-icon.mjs 从 icon.svg 生成的两份：
 *  Windows 任务栏/快捷方式吃 .ico，其它平台吃 .png。
 *  开发态资源在工程根目录，打包后由 electron-builder 放到 resourcesPath。 */
function iconPath(): string {
  const dir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(dir, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
}

/** 改名（keeNote → Kestrel）会连带换掉 userData 目录，老库留在 %APPDATA%/keeNote 里。
 *  不搬的话用户下次启动看到的是一片空白，会以为日记丢了。
 *  只在「新位置没有库、老位置有」时拷一份，**不动老库**——留着当退路。
 *  连 WAL 一起拷：正文的最新一份可能还在 WAL 里没回写主库。
 *
 *  这里是全工程**唯一一处故意留着旧名**的地方：它指的是旧目录的字面路径，
 *  换成 Kestrel 就找不到老库了。等确定不再需要这个兜底（比如发布满一年）再删。 */
function databasePath(): string {
  const dbPath = join(app.getPath('userData'), 'kestrel.db')
  const legacy = join(app.getPath('appData'), 'keeNote', 'keenote.db')
  if (existsSync(dbPath) || !existsSync(legacy)) return dbPath

  mkdirSync(app.getPath('userData'), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(legacy + suffix)) copyFileSync(legacy + suffix, dbPath + suffix)
  }
  console.log(`[db] 已从旧目录搬来一份库：${legacy} → ${dbPath}（老库原样留着）`)
  return dbPath
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    frame: !frameless,
    title: 'Kestrel',
    icon: iconPath(),
    // 底色跟云雾白主题的 --bg-base 一致：加载期间看到的不是白闪，而是应用底色
    backgroundColor: '#eef1f6',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程只通过 preload 暴露的领域方法碰数据，没有裸 SQL 通道
      sandbox: false,
    },
  })

  // 首帧准备好再显示，避免先出白框再填内容
  win.once('ready-to-show', () => win.show())

  const emitMaximize = () => win.webContents.send(IPC.winMaximizeChanged, win.isMaximized())
  win.on('maximize', emitMaximize)
  win.on('unmaximize', emitMaximize)

  // 外链一律交给系统浏览器；应用内不开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  /** 关窗前先问渲染层一句"还有没落盘的吗"，等它答。
   *
   *  §4.6 那条"待验证"实测**复现了**：按 × 前 500ms 内敲的字整个丢掉。原因不是库先被关掉，
   *  而是**写根本没发出去**——自动保存是 500ms 防抖，而窗口一销毁渲染进程就没了，
   *  `blur → flush()` 那次 IPC 永远来不及发。所以兜底必须做在主进程这一侧。
   *
   *  拦在 `close` 而不是 `before-quit`：`before-quit` 触发时窗口往往已经销毁，
   *  webContents 都不在了，问也无从问起。 */
  let flushAsked = false
  win.on('close', (event) => {
    if (flushAsked || win.webContents.isDestroyed()) return
    event.preventDefault()
    flushAsked = true

    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ipcMain.removeListener(IPC.winFlushed, onFlushed)
      win.close()
    }
    const onFlushed = (e: Electron.IpcMainEvent): void => {
      if (e.sender === win.webContents) finish()
    }
    // 渲染层卡住（或有 bug）不能让人连窗口都关不掉
    const timer = setTimeout(finish, 1000)
    ipcMain.on(IPC.winFlushed, onFlushed)
    win.webContents.send(IPC.winFlushRequest)
  })

  return win
}

/** 每个 handler 都包一层：出错时把干净的 message 抛回渲染进程，同时主进程留日志 */
function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...(args as never[]))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[ipc] ${channel} 失败:`, message)
      throw new Error(message)
    }
  })
}

function registerIpc(): void {
  handle(IPC.entryListByDate, (date: string) => entries.listByDate(date))
  handle(IPC.entryGet, (id: number) => entries.get(id))
  handle(IPC.entryEnsureDiary, (date: string) => entries.ensureDiary(date))
  handle(IPC.entryCreate, (input: CreateEntryInput) => entries.create(input))
  handle(IPC.entryUpdate, (id: number, patch: EntryPatch) => entries.update(id, patch))
  handle(IPC.entryRemove, (id: number) => entries.remove(id))
  handle(IPC.entryRecent, (limit: number) => entries.recent(limit))
  handle(IPC.entryCountByDay, (from: string, to: string) => entries.countByDay(from, to))
  handle(IPC.entryListByTopic, (topicId: number) => entries.listByTopic(topicId))
  handle(IPC.entryPromote, (id: number, input: PromoteInput) => entries.promote(id, input))
  handle(IPC.entryListDeleted, () => entries.listDeleted())
  handle(IPC.entryRestore, (id: number) => entries.restore(id))
  handle(IPC.entryPurge, (id: number) => entries.purge(id))
  handle(IPC.entryListPromotedOn, (date: string) => entries.listPromotedOn(date))

  handle(IPC.revisionList, (entryId: number) => revisions.list(entryId))
  handle(IPC.revisionGet, (id: number) => revisions.get(id))
  handle(IPC.revisionRestore, (id: number) => entries.restoreRevision(id))
  handle(IPC.revisionSnapshot, (entryId: number) => entries.snapshotRevision(entryId))

  handle(IPC.topicList, () => topics.list())
  handle(IPC.topicCreate, (name: string) => topics.create(name))
  handle(IPC.topicUpdate, (id: number, patch: TopicPatch) => topics.update(id, patch))
  handle(IPC.topicRename, (id: number, to: string, rewriteLinks: boolean) =>
    topics.rename(id, to, rewriteLinks)
  )
  handle(IPC.topicImpact, (from: string) => text.countTopicRename(from))
  handle(IPC.topicRemove, (id: number, detach: boolean) => topics.remove(id, detach))
  handle(IPC.topicReorder, (orderedIds: number[]) => topics.reorder(orderedIds))

  handle(IPC.tagTree, () => tags.tree())
  handle(IPC.tagEntries, (tagId: number, limit: number, offset: number) =>
    entries.listByTag(tagId, limit, offset)
  )
  handle(IPC.tagImpact, (from: string) => text.countTagRename(from))
  handle(IPC.tagRename, (from: string, to: string) => text.renameTag(from, to))

  handle(IPC.propKeys, () => props.keys())
  handle(IPC.propValues, (name: string) => props.values(name))
  handle(IPC.propEntries, (name: string, value: string | null, limit: number, offset: number) =>
    entries.listByPropValue(name, value, limit, offset)
  )
  handle(IPC.propKeyPut, (name: string, type: PropType) => props.keyPut(name, type))
  handle(IPC.propKeyConvert, (name: string, to: PropType) => props.convertReport(name, to))
  handle(IPC.propKeyRename, (from: string, to: string) => props.keyRename(from, to))

  handle(IPC.bookmarkList, () => bookmarks.list())
  handle(IPC.bookmarkToggle, (kind: BookmarkKind, ref: number, title: string) =>
    bookmarks.toggle(kind, ref, title)
  )

  handle(IPC.linkBacklinks, (entryId: number) => links.backlinks(entryId))
  handle(IPC.linkGraph, (entryId: number, depth: number) => links.graph(entryId, depth))
  handle(IPC.linkOutgoing, (entryId: number) => links.outgoing(entryId))

  handle(IPC.settingsAll, () => settings.all())
  handle(IPC.settingsPatch, (patch: Partial<Settings>) => settings.patch(patch))

  ipcMain.on(IPC.winMinimize, (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.on(IPC.winToggleMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(IPC.winClose, (event) => BrowserWindow.fromWebContents(event.sender)?.close())
}

app.setName('Kestrel')

// 单实例：两个进程同时开着同一个 SQLite 库，写冲突虽然能被 WAL 挡住，
// 但用户会看到两份不同步的界面，不如直接把焦点还给已有的那个
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    // 启动时把这两条路径打出来：图标没生效、库开错了位置，是打包后最常见也最难查的两件事
    console.log(`[app] Kestrel · 图标 ${iconPath()} · 库 ${databasePath()}`)
    openDatabase(databasePath())
    // 空库（真正的第一次）才会种下示例笔记，判据见 db/seed.ts
    seedIfFirstRun()
    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // macOS 习惯是关掉窗口不等于退出应用
    if (!isMac) app.quit()
  })

  // 退出前把连接关掉，让 WAL 正常回写主库文件
  app.on('before-quit', () => closeDatabase())
}