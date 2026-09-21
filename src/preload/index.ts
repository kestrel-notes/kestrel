import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type KestrelApi } from '../shared/types'

/** 渲染进程能碰到的全部能力的边界。
 *  暴露的是**领域方法**（取某天的日记、存这篇内容），不是通用通道：
 *  一条 `query(sql)` 会让 contextIsolation 白设。 */
const api: KestrelApi = {
  entries: {
    listByDate: (date) => ipcRenderer.invoke(IPC.entryListByDate, date),
    get: (id) => ipcRenderer.invoke(IPC.entryGet, id),
    ensureDiary: (date) => ipcRenderer.invoke(IPC.entryEnsureDiary, date),
    create: (input) => ipcRenderer.invoke(IPC.entryCreate, input),
    update: (id, patch) => ipcRenderer.invoke(IPC.entryUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(IPC.entryRemove, id),
    recent: (limit) => ipcRenderer.invoke(IPC.entryRecent, limit),
    countByDay: (from, to) => ipcRenderer.invoke(IPC.entryCountByDay, from, to),
    listByTopic: (topicId) => ipcRenderer.invoke(IPC.entryListByTopic, topicId),
    promote: (id, input) => ipcRenderer.invoke(IPC.entryPromote, id, input),
    listDeleted: () => ipcRenderer.invoke(IPC.entryListDeleted),
    restore: (id) => ipcRenderer.invoke(IPC.entryRestore, id),
    purge: (id) => ipcRenderer.invoke(IPC.entryPurge, id),
    listPromotedOn: (date) => ipcRenderer.invoke(IPC.entryListPromotedOn, date),
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
    outgoing: (entryId) => ipcRenderer.invoke(IPC.linkOutgoing, entryId),
  },
  settings: {
    all: () => ipcRenderer.invoke(IPC.settingsAll),
    patch: (patch) => ipcRenderer.invoke(IPC.settingsPatch, patch),
  },
  revisions: {
    list: (entryId) => ipcRenderer.invoke(IPC.revisionList, entryId),
    get: (id) => ipcRenderer.invoke(IPC.revisionGet, id),
    restore: (id) => ipcRenderer.invoke(IPC.revisionRestore, id),
    snapshot: (entryId) => ipcRenderer.invoke(IPC.revisionSnapshot, entryId),
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
}

contextBridge.exposeInMainWorld('kestrel', api)