import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import {
  IconBin,
  IconClose,
  IconFocus,
  IconMax,
  IconMin,
  IconRestore,
  IconStar,
  IconTheme,
} from '@/components/Icons'

export function TitleBar(): JSX.Element {
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const focus = useStore((s) => s.focus)
  const toggleFocus = useStore((s) => s.toggleFocus)
  const setSheetOpen = useStore((s) => s.setSheetOpen)
  const binRows = useStore((s) => s.binRows)
  const setBinOpen = useStore((s) => s.setBinOpen)
  const bookmarks = useStore((s) => s.bookmarks)
  const setBookmarkOpen = useStore((s) => s.setBookmarkOpen)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => window.kestrel.win.onMaximizeChange(setMaximized), [])

  return (
    <header className="titlebar glass">
      <div className="brand">
        <span className="brand-dot" />
        Kestrel
      </div>

      <div className="mode-switch">
        <button
          className={mode === 'diary' ? 'active' : ''}
          onClick={() => void setMode('diary')}
        >
          今天
        </button>
        <button
          className={mode === 'topic' ? 'active' : ''}
          onClick={() => void setMode('topic')}
        >
          主题
        </button>
        {/* 后两格是「回头看」，字号比前两格小一档（app.css 里按 nth-child 收，不加新类） */}
        <button className={mode === 'tag' ? 'active' : ''} onClick={() => void setMode('tag')}>
          标签
        </button>
        <button className={mode === 'prop' ? 'active' : ''} onClick={() => void setMode('prop')}>
          属性
        </button>
      </div>

      <div className="titlebar-right">
        {/* 只在这时候冒出来：一条收藏都没有的话，这个按钮点了也没东西看（期 1 §8.1 那条规则）。
            与旁边的回收站同一款显隐判据，所以两格都空时标题栏右侧只剩主题与专注 */}
        {bookmarks.length > 0 && (
          <button className="tb-btn" title="收藏 · Ctrl+D" onClick={() => setBookmarkOpen(true)}>
            <IconStar />
            收藏
            <em className="tb-count">{bookmarks.length}</em>
          </button>
        )}
        {/* 只在这时候冒出来：回收站空着的话，这个按钮点了也没东西看 */}
        {binRows.length > 0 && (
          <button className="tb-btn" title="回收站" onClick={() => setBinOpen(true)}>
            <IconBin />
            回收站
            <em className="tb-count">{binRows.length}</em>
          </button>
        )}
        <button className="tb-btn" onClick={() => setSheetOpen(true)}>
          <IconTheme />
          主题
        </button>
        <button className={`tb-btn ${focus ? 'on' : ''}`} onClick={toggleFocus}>
          <IconFocus />
          专注
        </button>
      </div>

      <div className="win-controls">
        <button title="最小化" onClick={() => window.kestrel.win.minimize()}>
          <IconMin />
        </button>
        <button
          title={maximized ? '还原' : '最大化'}
          onClick={() => window.kestrel.win.toggleMaximize()}
        >
          {maximized ? <IconRestore /> : <IconMax />}
        </button>
        <button className="close" title="关闭" onClick={() => window.kestrel.win.close()}>
          <IconClose />
        </button>
      </div>
    </header>
  )
}