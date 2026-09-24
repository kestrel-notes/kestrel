import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type KestrelApi } from '../shared/types'

/** 打包版这层壳**整个不存在**（期-03-设计 §10 第 12 项）。
 *  主进程那边的 `dev:sql` handler 在打包版不注册，所以这里就算暴露了也只是把
 *  「No handler registered」换成一次 reject——那不如不给界面一个能点的东西。
 *  信号由主进程用 additionalArguments 传进来：preload 这一侧读不到 app.isPackaged。 */
const packaged = process.argv.some((a) => a.startsWith('--kestrel-packaged=true'))

/** 渲染进程能碰到的全部能力的边界。
 *  暴露的是**领域方法**（取某天的日记、存这篇内容），不是通用通道：
 *  一条 `query(sql)` 会让 contextIsolation 白设。唯一的例外是 `__dev`：
 *  它按上面的条件挂，打包版整个不存在。 */
const api: KestrelApi = {
  entries: {
    listByDate: (date) => ipcRenderer.invoke(IPC.entryListByDate, date),
    get: (id) => ipcRenderer.invoke(IPC.entryGet, id),
    ensureDiary: (date) => ipcRenderer.invoke(IPC.entryEnsureDiary, date),
    create: (input) => ipcRenderer.invoke(IPC.entryCreate, input),
    update: (id, patch) => ipcRenderer.invoke(IPC.entryUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(IPC.entryRemove, id),
    recent: (limit) => ipcRenderer.invoke(IPC.entryRecent, limit),
    labels: (ids) => ipcRenderer.invoke(IPC.entryLabels, ids),
    countByDay: (from, to) => ipcRenderer.invoke(IPC.entryCountByDay, from, to),
    listByTopic: (topicId) => ipcRenderer.invoke(IPC.entryListByTopic, topicId),
    promote: (id, input) => ipcRenderer.invoke(IPC.entryPromote, id, input),
    listDeleted: () => ipcRenderer.invoke(IPC.entryListDeleted),
    restore: (id) => ipcRenderer.invoke(IPC.entryRestore, id),
    purge: (id) => ipcRenderer.invoke(IPC.entryPurge, id),
    listPromotedOn: (date) => ipcRenderer.invoke(IPC.entryListPromotedOn, date),
    chronicle: (topicId) => ipcRenderer.invoke(IPC.entryChronicle, topicId),
    prevDiary: (date) => ipcRenderer.invoke(IPC.entryPrevDiary, date),
    randomId: (except) => ipcRenderer.invoke(IPC.entryRandomId, except),
  },
  topics: {
    list: () => ipcRenderer.invoke(IPC.topicList),
    create: (name) => ipcRenderer.invoke(IPC.topicCreate, name),
    update: (id, patch) => ipcRenderer.invoke(IPC.topicUpdate, id, patch),
    rename: (id, to, rewriteLinks) => ipcRenderer.invoke(IPC.topicRename, id, to, rewriteLinks),
    impact: (from) => ipcRenderer.invoke(IPC.topicImpact, from),
    remove: (id, detach) => ipcRenderer.invoke(IPC.topicRemove, id, detach),
    reorder: (orderedIds) => ipcRenderer.invoke(IPC.topicReorder, orderedIds),
  },
  tags: {
    tree: () => ipcRenderer.invoke(IPC.tagTree),
    entries: (tagId, limit, offset) => ipcRenderer.invoke(IPC.tagEntries, tagId, limit, offset),
    impact: (from) => ipcRenderer.invoke(IPC.tagImpact, from),
    rename: (from, to) => ipcRenderer.invoke(IPC.tagRename, from, to),
  },
  props: {
    keys: () => ipcRenderer.invoke(IPC.propKeys),
    values: (name) => ipcRenderer.invoke(IPC.propValues, name),
    entries: (name, value, limit, offset) =>
      ipcRenderer.invoke(IPC.propEntries, name, value, limit, offset),
    keyPut: (name, type) => ipcRenderer.invoke(IPC.propKeyPut, name, type),
    keyConvert: (name, to) => ipcRenderer.invoke(IPC.propKeyConvert, name, to),
    keyRename: (from, to) => ipcRenderer.invoke(IPC.propKeyRename, from, to),
  },
  bookmarks: {
    list: () => ipcRenderer.invoke(IPC.bookmarkList),
    toggle: (kind, ref, title) => ipcRenderer.invoke(IPC.bookmarkToggle, kind, ref, title),
  },
  links: {
    backlinks: (entryId) => ipcRenderer.invoke(IPC.linkBacklinks, entryId),
    graph: (entryId, depth) => ipcRenderer.invoke(IPC.linkGraph, entryId, depth),
    graphAll: () => ipcRenderer.invoke(IPC.linkGraphAll),
    outgoing: (entryId) => ipcRenderer.invoke(IPC.linkOutgoing, entryId),
  },
  search: {
    run: (query, limit, order) => ipcRenderer.invoke(IPC.searchRun, query, limit, order),
  },
  fts: {
    status: () => ipcRenderer.invoke(IPC.ftsStatus),
  },
  query: {
    run: (body) => ipcRenderer.invoke(IPC.queryRun, body),
  },
  saved: {
    list: () => ipcRenderer.invoke(IPC.savedList),
    create: (name, body) => ipcRenderer.invoke(IPC.savedCreate, name, body),
    update: (id, patch) => ipcRenderer.invoke(IPC.savedUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(IPC.savedRemove, id),
    used: (id) => ipcRenderer.invoke(IPC.savedUsed, id),
  },
  templates: {
    list: () => ipcRenderer.invoke(IPC.tplList),
    create: (input) => ipcRenderer.invoke(IPC.tplCreate, input),
    update: (id, patch) => ipcRenderer.invoke(IPC.tplUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(IPC.tplRemove, id),
  },
  transfer: {
    pickDirectory: (mode) => ipcRenderer.invoke(IPC.transferPick, mode),
    exportPlan: (dir) => ipcRenderer.invoke(IPC.exportPlan, dir),
    exportRun: (dir) => ipcRenderer.invoke(IPC.exportRun, dir),
    exportProgress: () => ipcRenderer.invoke(IPC.exportProgress),
    exportCancel: () => ipcRenderer.invoke(IPC.exportCancel),
    importPlan: (dir) => ipcRenderer.invoke(IPC.importPlan, dir),
    importRun: (dir) => ipcRenderer.invoke(IPC.importRun, dir),
    importProgress: () => ipcRenderer.invoke(IPC.importProgress),
    importCancel: () => ipcRenderer.invoke(IPC.importCancel),
  },
  settings: {
    all: () => ipcRenderer.invoke(IPC.settingsAll),
    patch: (patch) => ipcRenderer.invoke(IPC.settingsPatch, patch),
  },
  backup: {
    status: () => ipcRenderer.invoke(IPC.backupStatus),
    now: () => ipcRenderer.invoke(IPC.backupNow),
    restore: (name) => ipcRenderer.invoke(IPC.backupRestore, name),
    prune: () => ipcRenderer.invoke(IPC.backupPrune),
  },
  workspace: {
    load: () => ipcRenderer.invoke(IPC.workspaceLoad),
    save: (ws) => ipcRenderer.invoke(IPC.workspaceSave, ws),
  },
  snippets: {
    list: () => ipcRenderer.invoke(IPC.snippetList),
    // 铃里不携带文件名：一次保存会给出好几个事件，名字与类型都不可信（期-09b §〇 M4）
    onChanged: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.snippetChanged, listener)
      return () => ipcRenderer.off(IPC.snippetChanged, listener)
    },
  },
  shell: {
    openDir: (which) => ipcRenderer.invoke(IPC.shellOpenDir, which),
    info: () => ipcRenderer.invoke(IPC.appInfo),
  },
  revisions: {
    list: (entryId) => ipcRenderer.invoke(IPC.revisionList, entryId),
    get: (id) => ipcRenderer.invoke(IPC.revisionGet, id),
    restore: (id) => ipcRenderer.invoke(IPC.revisionRestore, id),
    snapshot: (entryId) => ipcRenderer.invoke(IPC.revisionSnapshot, entryId),
  },
  attachments: {
    import: (name, data) => ipcRenderer.invoke(IPC.attachmentImport, name, data) as Promise<string>,
  },
  win: {
    minimize: () => ipcRenderer.send(IPC.winMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.winToggleMaximize),
    close: () => ipcRenderer.send(IPC.winClose),
    onMaximizeChange: (cb) => {
      const listener = (_event: unknown, maximized: boolean): void => cb(maximized)
      ipcRenderer.on(IPC.winMaximizeChanged, listener)
      return () => ipcRenderer.off(IPC.winMaximizeChanged, listener)
    },
    onFlushRequest: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.winFlushRequest, listener)
      return () => ipcRenderer.off(IPC.winFlushRequest, listener)
    },
    flushDone: () => ipcRenderer.send(IPC.winFlushed),
  },
  // 条件挂载：见文件头 `packaged` 那条。开发版里 `await kestrel.__dev.sql('select …')`
  // 直接查库，本期 §10 的性能红线与验收全靠它计时。
  ...(packaged
    ? {}
    : {
        __dev: {
          sql: (query: string) => ipcRenderer.invoke(IPC.devSql, query) as Promise<unknown[]>,
        },
      }),
}

contextBridge.exposeInMainWorld('kestrel', api)