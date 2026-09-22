import type { JSX } from 'react'
import { useEffect } from 'react'
import { useStore } from '@/store'
import { findByKey, keyOf } from '@/commands'
import { resolveTheme } from '@/themes'
import { TitleBar } from '@/components/TitleBar'
import { Sidebar } from '@/components/Sidebar'
import { Editor } from '@/components/Editor'
import { Rail } from '@/components/Rail'
import { ThemeSheet } from '@/components/ThemeSheet'
import { Palette } from '@/components/Palette'
import { SearchPanel } from '@/components/SearchPanel'
import { PromoteCard } from '@/components/PromoteCard'
import { RecycleBin } from '@/components/RecycleBin'
import { Bookmarks } from '@/components/Bookmarks'
import { KestrelMark } from '@/components/KestrelMark'
import { TagRenameCard } from '@/components/TagRenameCard'
import { TopicSheet } from '@/components/TopicSheet'
import { TopicRenameCard } from '@/components/TopicRenameCard'
import { PropConvertCard } from '@/components/PropConvertCard'
import { VersionSheet } from '@/components/VersionSheet'
import { ConfirmDialog } from '@/components/ConfirmDialog'

export default function App(): JSX.Element {
  const ready = useStore((s) => s.ready)
  const bootError = useStore((s) => s.bootError)
  const settings = useStore((s) => s.settings)
  const prefersDark = useStore((s) => s.prefersDark)
  const focus = useStore((s) => s.focus)
  const toast = useStore((s) => s.toast)
  const init = useStore((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  // Theme token 落到 body：所有面板与浮层都靠 CSS 变量取色，这里改一次就够了
  useEffect(() => {
    const theme = resolveTheme(settings.theme, settings.followSystem, prefersDark)
    document.body.dataset.theme = theme
    document.body.style.setProperty('--blur', `${settings.blur}px`)
    document.body.style.setProperty('--sat', String(settings.sat))

    if (settings.accent) {
      document.body.style.setProperty('--accent', settings.accent)
      document.body.style.setProperty(
        '--accent-soft',
        `color-mix(in srgb, ${settings.accent} 14%, transparent)`
      )
    } else {
      document.body.style.removeProperty('--accent')
      document.body.style.removeProperty('--accent-soft')
    }
  }, [settings.theme, settings.accent, settings.blur, settings.sat, settings.followSystem, prefersDark])

  useEffect(() => {
    document.body.classList.toggle('no-glass', !settings.glass)
  }, [settings.glass])

  useEffect(() => {
    document.body.classList.toggle('focus-mode', focus)
  }, [focus])

  // 切到别的窗口就先落盘，别等 500ms 定时器——用户可能写完就切走了
  useEffect(() => {
    const flush = (): void => void useStore.getState().flush()
    window.addEventListener('blur', flush)
    return () => window.removeEventListener('blur', flush)
  }, [])

  // 关窗是 blur 救不了的那一种：窗口一销毁渲染进程就跟着走了。
  // 所以主进程关窗前会问这一句，落完盘回一声它才真关（期-01 设计 §4.6）。
  useEffect(
    () =>
      window.kestrel.win.onFlushRequest(() => {
        void useStore
          .getState()
          .flush()
          .finally(() => window.kestrel.win.flushDone())
      }),
    []
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const s = useStore.getState()

      // Escape 留在本地，不进命令表：它要按浮层的开关状态决定先关谁，
      // 那是一次「当前界面」的判定，不是一条全局命令。
      // 顺序 = 从最里面那层往外收，一次只关一个
      if (e.code === 'Escape') {
        if (s.confirm) s.answerConfirm(false)
        else if (s.palette !== null) s.closePalette()
        else if (s.searchOpen) s.closeSearch()
        else if (s.propConvert) s.setPropConvert(null)
        else if (s.topicRename !== null) s.setTopicRename(null)
        else if (s.tagRename !== null) s.setTagRename(null)
        else if (s.promoteOpen) s.setPromoteOpen(false)
        else if (s.topicSheetOpen) s.setTopicSheetOpen(false)
        else if (s.bookmarkOpen) s.setBookmarkOpen(false)
        else if (s.binOpen) s.setBinOpen(false)
        else if (s.versionOf) s.closeVersion()
        else if (s.sheetOpen) s.setSheetOpen(false)
        else if (s.focus) s.toggleFocus()
        return
      }

      const key = keyOf(e)
      if (!key) return
      // 确认弹层开着的时候不派发任何命令。那些快捷键会换掉「当前这一篇」，
      // 于是一句「删掉它」有可能删到别的记录上——弹层就该像弹层的样子
      if (useStore.getState().confirm !== null) return
      const cmd = findByKey(key)
      if (!cmd) return

      e.preventDefault()
      if (cmd.enabled && !cmd.enabled(s)) return
      void cmd.run(s)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ready) {
    return (
      <div className="boot">
        <KestrelMark size={22} />
        <span>正在打开库…</span>
      </div>
    )
  }

  if (bootError) {
    return (
      <div className="boot boot-error">
        <h3>库打不开</h3>
        <p>{bootError}</p>
        <p className="hint">如果另一个 Kestrel 正在运行，先把它关掉再试。</p>
      </div>
    )
  }

  return (
    <>
      <div className="app">
        <TitleBar />
        <Sidebar />
        <Editor />
        <Rail />
      </div>
      <ThemeSheet />
      <PromoteCard />
      <RecycleBin />
      <Bookmarks />
      <TagRenameCard />
      <TopicSheet />
      <TopicRenameCard />
      <PropConvertCard />
      <VersionSheet />
      <Palette />
      <SearchPanel />
      <ConfirmDialog />
      {toast && <div className="toast on">{toast}</div>}
    </>
  )
}