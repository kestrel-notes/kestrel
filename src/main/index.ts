import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { closeDatabase, databaseFile, getDatabase, openDatabase } from './db'
import { importAsset, mountAssetProtocol, registerAssetScheme } from './attachments'
import * as entries from './db/entries'
import * as fts from './db/fts'
import { seedIfFirstRun } from './db/seed'
import * as search from './db/search'
import * as topics from './db/topics'
import * as tags from './db/tags'
import * as text from './db/text'
import * as links from './db/links'
import * as props from './db/props'
import * as bookmarks from './db/bookmarks'
import * as revisions from './db/revision'
import * as settings from './db/settings'
import * as savedQueries from './db/savedQueries'
import * as templates from './db/templates'
import * as queryBlock from './db/queryBlock'
import * as exporter from './db/export'
import * as importer from './db/import'
import * as backup from './db/backup'
import * as workspace from './db/workspace'
import * as snippets from './db/snippets'
import { parseQueryBlock } from '../shared/queryLang'
import {
  IPC,
  type AppInfo,
  type BookmarkKind,
  type CreateEntryInput,
  type EntryPatch,
  type PromoteInput,
  type PropType,
  type SearchOrder,
  type Settings,
  type TopicPatch,
} from '../shared/types'
import type { Workspace } from '../shared/workspace'

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
      // preload 侧拿不到 `app.isPackaged`（那是主进程的东西），而 `__dev` 这层壳在打包版
      // 要**整个不存在**（期-03-设计 §10 第 12 项），所以把唯一的可信判断传过去。
      // 真正的闸门仍在主进程：打包版连 `dev:sql` 这个 handler 都不注册。
      additionalArguments: [`--kestrel-packaged=${app.isPackaged}`],
    },
  })

  // 首帧准备好再显示，避免先出白框再填内容
  win.once('ready-to-show', () => {
    win.show()
    // 全文索引的回填排在窗口出现之后：它跑到第一批之前是同步的（最坏几百毫秒），
    // 排在前面等于让大库升级后的首帧多白屏一截。回填本身可续，见 db/fts.ts 头注。
    void fts.ensureIndex().catch((err) => console.error('[fts] 索引回填失败:', err))
    // 每日备份与 30 天裁剪排在首屏之后（期-03 那条 ≤3000ms 红线是硬的，这两件都不许挤进去）。
    // 裁剪跑在备份之后是同一条链里的顺序，见 db/backup.ts 头注。
    backup.scheduleMaintenance()
  })

  const emitMaximize = () => win.webContents.send(IPC.winMaximizeChanged, win.isMaximized())
  win.on('maximize', emitMaximize)
  win.on('unmaximize', emitMaximize)

  /* 片段那声铃（期-09b §五 ②）。两个来源收进同一条路：目录 watch 去抖之后吱一声，
   *  窗口重新聚焦时也吱一声——后者管的是「人在资源管理器里改完，切回来就该变」，
   *  而 watch 万一没挂上（只读盘、权限）它还能自己活。 */
  const 吱一声 = (): void => {
    if (!win.webContents.isDestroyed()) win.webContents.send(IPC.snippetChanged)
  }
  win.on('focus', 吱一声)
  snippets.pauseForFlag()
  snippets.startWatch(吱一声)

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
  handle(IPC.entryLabels, (ids: number[]) => entries.labels(ids))
  handle(IPC.entryCountByDay, (from: string, to: string) => entries.countByDay(from, to))
  handle(IPC.entryListByTopic, (topicId: number) => entries.listByTopic(topicId))
  handle(IPC.entryPromote, (id: number, input: PromoteInput) => entries.promote(id, input))
  handle(IPC.entryListDeleted, () => entries.listDeleted())
  handle(IPC.entryRestore, (id: number) => entries.restore(id))
  handle(IPC.entryPurge, (id: number) => entries.purge(id))
  handle(IPC.entryListPromotedOn, (date: string) => entries.listPromotedOn(date))
  handle(IPC.entryChronicle, (topicId: number) => entries.chronicle(topicId))
  handle(IPC.entryPrevDiary, (date: string) => entries.prevDiary(date))

  handle(IPC.revisionList, (entryId: number) => revisions.list(entryId))
  handle(IPC.revisionGet, (id: number) => revisions.get(id))
  handle(IPC.revisionRestore, (id: number) => entries.restoreRevision(id))
  handle(IPC.revisionSnapshot, (entryId: number) => entries.snapshotRevision(entryId))

  handle(IPC.attachmentImport, (name: string, data: Uint8Array) => importAsset(name, data))

  /* 流通（期-08）。目录由主进程弹系统对话框选——渲染层拿不到 fs，也不该拿到；
   *  渲染层看到的只是一个字符串路径。 */
  handle(IPC.transferPick, async (_mode?: 'export' | 'import') => {
    const 导 = _mode !== 'import'
    const r = await dialog.showOpenDialog({
      title: 导 ? '选一个目录放导出物' : '选一个 Kestrel 导出的目录',
      buttonLabel: 导 ? '就放这里' : '就导这个',
      properties: 导 ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  handle(IPC.exportPlan, (dir: string) => exporter.plan(dir))
  handle(IPC.exportRun, async (dir: string) => exporter.run(dir))
  handle(IPC.exportProgress, () => exporter.getProgress())
  handle(IPC.exportCancel, () => exporter.requestCancel())
  handle(IPC.importPlan, (dir: string) => importer.plan(dir))
  handle(IPC.importRun, async (dir: string) => importer.run(dir))
  handle(IPC.importProgress, () => importer.getProgress())
  handle(IPC.importCancel, () => importer.requestCancel())

  // 备份这一档只认文件名：路径由主进程自己拼（`backupRoot()`），渲染进程给不出也别想给出一条
  handle(IPC.backupStatus, () => backup.status())
  handle(IPC.backupNow, () => backup.snapshotNow())
  handle(IPC.backupRestore, (name: string) => backup.restore(name))
  handle(IPC.backupPrune, () => backup.pruneHistory())

  /** 工作区（期-09a）。`save` 这一头不再校验一遍：写进去的坏东西在 `load()` 那里会被
   *  当成「没有工作区」，那一刀本来就按不可信输入写（`shared/workspace.ts`）。
   *  两头都校验只会让「为什么标签没了」多一个查不动的地方。 */
  handle(IPC.workspaceLoad, () => workspace.load())
  handle(IPC.workspaceSave, (ws: Workspace) => {
    workspace.save(ws)
    return true
  })

  /* CSS 片段（期-09b）。只有「问清单」和「开目录」两条，没有「写文件」那一条：
   *  片段是人在文件管理器里放的，应用不把自己变成第二个编辑面。 */
  handle(IPC.snippetList, () => snippets.list())
  // 关于那一格：版本号 / schema / 库在哪 / 两个目录在哪。全是主进程现值，渲染进程猜不出来
  handle(IPC.appInfo, (): AppInfo => {
    const 版 = getDatabase()
      .prepare('pragma user_version')
      .get() as unknown as { user_version: number }
    return {
      version: app.getVersion(),
      schema: 版.user_version,
      dbFile: databaseFile(),
      snippetsDir: snippets.snippetRoot(),
      backupsDir: backup.backupRoot(),
    }
  })
  // 闭集名字：一个接受任意字符串去 `shell.openPath` 的通道，等于把「打开任何目录」交给渲染层
  handle(IPC.shellOpenDir, async (which: 'snippets' | 'backups') => {
    const 表 = { snippets: snippets.snippetRoot(), backups: backup.backupRoot() } as const
    if (!(which in 表)) return false
    return (await shell.openPath(表[which])) === ''
  })

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
  handle(IPC.linkGraphAll, () => links.graphAll())
  handle(IPC.linkOutgoing, (entryId: number) => links.outgoing(entryId))

  handle(IPC.settingsAll, () => settings.all())
  handle(IPC.settingsPatch, (patch: Partial<Settings>) => settings.patch(patch))

  handle(IPC.searchRun, (query: string, limit?: number, order?: SearchOrder) => {
    const t = Date.now()
    const res = search.run(query, limit, order)
    /** 开发版留一行「这次走了哪条路、几毫秒、发了几趟」。§10 第 7、8 两项的账都从这行数：
     *  第 8 项要证明连打十个字没有排队，光看渲染层看不出发了几趟 IPC。
     *  6b-2 起把档名也带上——三档排出来的前十重合是验收判据，日志得能自证发了哪一档。 */
    if (!app.isPackaged) {
      console.log(
        `[search] ${Date.now() - t}ms · ${res.path}/${res.order} · ${res.rows.length}/${res.total} · ${query}`
      )
    }
    return res
  })
  handle(IPC.ftsStatus, () => fts.status())

  /** 查询块（期-07）。渲染层递过来的是**语句原文**：解析与翻译都在这一侧，
   *  所以 SQL 文本从来不过 IPC 那道边界。
   *  语法错不是异常，是一个正常的返回值（`{error}`），所以这里不 catch——
   *  `parseQueryBlock` 自己永不抛错。 */
  handle(IPC.queryRun, (body: string) => {
    const parsed = parseQueryBlock(body)
    if ('error' in parsed) return { error: parsed.error }
    const res = queryBlock.runQuery(parsed.plan)
    if (!app.isPackaged)
      console.log(`[query] ${res.ms}ms · ${res.view} ${res.rows.length} 行 · ${body.replace(/\s+/g, ' ')}`)
    return { result: res }
  })

  handle(IPC.savedList, () => savedQueries.list())
  handle(IPC.savedCreate, (name: string, body: string) => savedQueries.create(name, body))
  handle(IPC.savedUpdate, (id: number, patch: { name?: string; body?: string }) =>
    savedQueries.update(id, patch)
  )
  handle(IPC.savedRemove, (id: number) => savedQueries.remove(id))
  handle(IPC.savedUsed, (id: number) => savedQueries.markUsed(id))

  handle(IPC.tplList, () => templates.list())
  handle(IPC.tplCreate, (input: { name: string; scope: string; body: string; isDefault?: boolean }) =>
    templates.create(input)
  )
  handle(IPC.tplUpdate, (id: number, patch: { name?: string; body?: string; isDefault?: boolean }) =>
    templates.update(id, patch)
  )
  handle(IPC.tplRemove, (id: number) => templates.remove(id))

  /** 裸 SQL。只在开发版存在——不是"锁起来"而是这条通道根本不注册，
   *  理由见 `IPC.devSql` 的注释与期-03-设计 §8-D6。
   *
   *  返回值就是行数组（§5.4 定的形状）。计时走 console，探针自己在 CDP 那一侧量。 */
  if (!app.isPackaged) {
    handle(IPC.devSql, (sql: string) => {
      const t = Date.now()
      const stmt = getDatabase().prepare(sql)
      /** 判读写不能拿 `stmt.reader`：Electron 里那颗 node:sqlite 根本没这个属性
       *  （实测 undefined，系统 node 的那颗才有），于是 SELECT 会走到 `run()` 那半边——
       *  而 `run()` 在 SELECT 上**不抛错**，只把上一次写的 `{changes, lastInsertRowid}` 交回来，
       *  探针读到的全是看着像结果的假行。`columns()` 是纯元数据：写作空数组、读作列出列名，
       *  且两边都不会把语句执行一遍。 */
      const isReader = (stmt.columns() as unknown[]).length > 0
      const out = isReader
        ? (stmt.all() as unknown[])
        : [stmt.run() as unknown as Record<string, unknown>]
      console.log(`[dev.sql] ${Date.now() - t}ms · ${out.length} 行 · ${sql.slice(0, 80)}`)
      return out
    })
  }

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

// 特权协议声明必须在 app 就绪之前（Electron 硬要求），所以放模块顶层、whenReady 之外
registerAssetScheme()

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
    // 协议 handler 装配排在就绪之后（声明在就绪之前，两半各守一半 Electron 的时序要求）
    mountAssetProtocol()
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
  app.on('before-quit', () => {
    snippets.stopWatch()
    closeDatabase()
  })
}