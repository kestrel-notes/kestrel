import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useStore, type SheetTab } from '@/store'
import { THEMES } from '@/themes'
import { COMMANDS, keyLabel, type CommandGroup } from '@/commands'
import { keepClamp } from '../../../shared/backupFormat'
import { FONT_ROOT_MAX, FONT_ROOT_MIN, fontRootClamp } from '../../../shared/types'
import type { AppInfo } from '../../../shared/types'

const TABS: { id: SheetTab; label: string; hint: string }[] = [
  { id: 'look', label: '外观', hint: '配色、强调色与毛玻璃' },
  { id: 'editor', label: '编辑器', hint: '开应用落在哪一档' },
  { id: 'snippets', label: '片段', hint: '丢 .css 进目录即改外观' },
  { id: 'keys', label: '快捷键', hint: '全部键位，只读' },
  { id: 'data', label: '数据', hint: '每日快照留几份' },
  { id: 'about', label: '关于', hint: '版本、库在哪' },
]

/** 期-09b：由 `ThemeSheet` 长成的一整页设置。
 *
 *  为什么就地长大而不是并存两份：那六颗控件（主题 / 强调色 / 模糊 / 饱和 / 玻璃 / 跟随系统）
 *  搬家重抄一遍只会造出「改了 A 忘了 B」的地方。外壳（`.sheet` + `.sheet-card`）与 `Esc` 链
 *  都沿用既有那一套，不新建第二套 overlay 语法。
 */
export function Settings(): JSX.Element | null {
  const open = useStore((s) => s.sheetOpen)
  const setOpen = useStore((s) => s.setSheetOpen)
  const tab = useStore((s) => s.sheetTab)
  const settings = useStore((s) => s.settings)

 if (!open) return null
  const 当前 = TABS.find((t) => t.id === tab) ?? TABS[0]

  return (
    <div className="sheet open" onClick={() => setOpen(false)}>
      <div className="sheet-card settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <h3>设置</h3>
            <p>{当前.hint}</p>
          </div>
          <button className="close-x" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-rail">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`settings-tab ${tab === t.id ? 'on' : ''}`}
                onClick={() => setOpen(true, t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="settings-pane">
            {tab === 'look' && <Look />}
            {tab === 'editor' && <Editor />}
            {tab === 'snippets' && <Snippets />}
            {tab === 'keys' && <Keys />}
            {tab === 'data' && <Data />}
            {tab === 'about' && <About settingsTheme={settings.theme} />}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── 外观（原来那一整张 ThemeSheet 的内容，一个字没改语义） ── */

function Look(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const patch = useStore((s) => s.patchSettings)
  return (
    <>
      <div className="sec-label" style={{ padding: 0, marginBottom: 9 }}>
        配色方案
      </div>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button
            key={t.name}
            className={`theme-card ${settings.theme === t.name ? 'on' : ''}`}
            onClick={() => void patch({ theme: t.name, accent: null })}
          >
            {/* 缩略图自己挂 data-theme，用的是真主题变量——预览和实际不可能不一致 */}
            <div
              className="prev"
              data-theme={t.name}
              style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-wall)' }}
            >
              <i style={{ left: 6, top: 6, width: 40, height: 5, background: 'var(--text-3)', opacity: 0.55 }} />
              <i
                style={{
                  left: 6,
                  top: 17,
                  width: 62,
                  height: 26,
                  background: 'var(--bg-glass)',
                  border: '1px solid var(--border)',
                }}
              />
              <i style={{ left: 74, top: 17, width: 24, height: 26, background: 'var(--accent)' }} />
              <i
                style={{
                  left: 6,
                  top: 49,
                  width: 54,
                  height: 7,
                  background: 'var(--hover)',
                  border: '1px solid var(--border)',
                }}
              />
            </div>
            <div className="nm">{t.label}</div>
            <div className="ds">{t.desc}</div>
          </button>
        ))}
      </div>

      <div className="sec-label" style={{ padding: 0, marginBottom: 9 }}>
        强调色
      </div>
      <div className="swatches">
        {THEMES.find((t) => t.name === settings.theme)?.accents.map((color, i) => (
          <button
            key={color}
            className={`swatch ${settings.accent === color || (settings.accent === null && i === 0) ? 'on' : ''}`}
            style={{ background: color }}
            title={i === 0 ? `${color}（主题默认）` : color}
            onClick={() => void patch({ accent: i === 0 ? null : color })}
          />
        ))}
      </div>

      <div className="sec-label" style={{ padding: 0, marginBottom: 9 }}>
        字号
      </div>
      <div className="slider-row">
        <label htmlFor="fontRoot">整条阶梯</label>
        <input
          id="fontRoot"
          type="range"
          min={FONT_ROOT_MIN}
          max={FONT_ROOT_MAX}
          step={1}
          value={fontRootClamp(settings.fontRoot)}
          onChange={(e) => void patch({ fontRoot: Number(e.target.value) })}
        />
        <b>{fontRootClamp(settings.fontRoot)}px</b>
      </div>
      <div className="set-note" style={{ marginTop: 2 }}>
        正文与界面共用这一颗：<code>16px</code> 是默认，往两头整条字号阶梯等比缩放。
        上下限是实测出来的，不是拍的——再往大，图标按钮里的字会画到自己那格外面去。
      </div>

      <div className="sec-label" style={{ padding: 0, marginBottom: 9 }}>
        毛玻璃
      </div>
      <div className="slider-row">
        <label htmlFor="blur">模糊半径</label>
        <input
          id="blur"
          type="range"
          min={0}
          max={40}
          value={settings.blur}
          onChange={(e) => void patch({ blur: Number(e.target.value) })}
        />
        <b>{settings.blur}px</b>
      </div>
      <div className="slider-row">
        <label htmlFor="sat">饱和度</label>
        <input
          id="sat"
          type="range"
          min={100}
          max={220}
          value={Math.round(settings.sat * 100)}
          onChange={(e) => void patch({ sat: Number(e.target.value) / 100 })}
        />
        <b>{settings.sat.toFixed(2)}</b>
      </div>

      <Toggle
        on={settings.glass}
        title="启用毛玻璃"
        desc="关闭后所有面板降级为纯色，长列表滚动更省电"
        onClick={() => void patch({ glass: !settings.glass })}
      />
      <Toggle
        on={settings.followSystem}
        title="跟随系统深浅色"
        desc="系统切暗色时自动换到松林，亮色时回到亮色主题"
        onClick={() => void patch({ followSystem: !settings.followSystem })}
      />
      <p className="set-note">
        想更深地改外观（换字体、调间距、把某一块挪走）：写一个 <code>.css</code> 丢到「片段」那一格说的目录里。
      </p>
    </>
  )
}

function Toggle({
  on,
  title,
  desc,
  onClick,
}: {
  on: boolean
  title: string
  desc: string
  onClick(): void
}): JSX.Element {
  return (
    <div className="row-toggle">
      <div>
        {title}
        <em>{desc}</em>
      </div>
      <button className={`sw ${on ? 'on' : ''}`} aria-pressed={on} onClick={onClick} />
    </div>
  )
}

/* ── 编辑器 ── */

const 档位: { id: 'rich' | 'source' | 'reading'; label: string; desc: string }[] = [
  { id: 'rich', label: '所见即所得', desc: '排版好的那一版。这一档过无损闸门，认不出的东西会把你按在源码里' },
  { id: 'source', label: '源码', desc: 'markdown 原文。不解析、不改写，任何内容都编辑得了' },
  { id: 'reading', label: '阅读', desc: '只读的那一版，同样过闸门' },
]

function Editor(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const patch = useStore((s) => s.patchSettings)
  return (
    <>
      <div className="sec-label" style={{ padding: 0, marginBottom: 9 }}>
        开应用落在哪一档
      </div>
      {档位.map((m) => (
        <button
          key={m.id}
          className={`set-row ${settings.editorModeDefault === m.id ? 'on' : ''}`}
          onClick={() => void patch({ editorModeDefault: m.id })}
        >
          <span className="k">{m.label}</span>
          <span className="v">{m.desc}</span>
        </button>
      ))}
      <p className="set-note">
        只管启动那一下。中途换档（<code>Ctrl+1</code> 到 <code>Ctrl+4</code>）不留进这里；
        而这一篇如果有文件树认不出的东西，闸门仍会把你留在源码模式——那是内容安全，不是设置没生效。
      </p>
      <p className="set-note">字号没有这一格：正文里 179 处字号是硬写的像素，一个滑块推不动它。那条账记在路线图上。</p>
    </>
  )
}

/* ── 片段 ── */

function Snippets(): JSX.Element {
  const list = useStore((s) => s.snippets)
  const paused = useStore((s) => s.snippetsPaused)
  const setPaused = useStore((s) => s.setSnippetsPaused)
  const reload = useStore((s) => s.reloadSnippets)
  const patch = useStore((s) => s.patchSettings)
  const off = new Set(list.filter((x) => !x.on).map((x) => x.name))
  const 目录 = useAppInfo()?.snippetsDir ?? ''

  const 开关 = (name: string, on: boolean): void => {
    const 新 = new Set(off)
    if (on) 新.delete(name)
    else 新.add(name)
    void patch({ snippetsOff: [...新] }).then(() => void reload())
  }

  return (
    <>
      <p className="set-note">
        把 <code>.css</code> 丢进下面这个目录，<strong>立刻</strong>改外观；删掉就撤回来。
        生效顺序按文件名升序。
      </p>
      <div className="set-path">
        <code>{目录 || '（还没拿到路径）'}</code>
        <button className="btn ghost" onClick={() => void window.kestrel.shell.openDir('snippets')}>
          打开这个文件夹
        </button>
      </div>

      {list.length === 0 && <p className="set-note">目录里现在一份都没有。</p>}
      {list.map((s) => (
        <div className={`set-row snippet ${s.on && !paused ? 'on' : ''}`} key={s.name}>
          <span className="k">{s.name}</span>
          <span className="v">
            {s.bytes < 1024 ? s.bytes + ' B' : Math.round(s.bytes / 1024) + ' KB'}
            {s.note ? ` · ${s.note}` : ''}
          </span>
          <button
            className={`sw ${s.on ? 'on' : ''}`}
            aria-pressed={s.on}
            onClick={() => 开关(s.name, !s.on)}
          />
        </div>
      ))}

      <div className="set-actions">
        <button className="btn ghost" onClick={() => void reload()}>
          重读一遍
        </button>
        <button className="btn ghost" onClick={() => setPaused(!paused)}>
          {paused ? '恢复全部片段' : '暂停全部片段（本次会话）'}
        </button>
      </div>
      {paused && (
        <p className="set-note">
          暂停只影响这一次运行，不落库。界面被片段改坏了时用它自救；命令行加 <code>--no-snippets</code> 是同一件事的另一条路。
        </p>
      )}
      <p className="set-note">
        写片段的一句话经验：<strong>直接改类选择器最稳</strong>（比如 <code>.md-prose &#123; ... &#125;</code>）。
        要换主题变量的写成 <code>body[data-theme] &#123; --text-1: ... &#125;</code>——实测写成{' '}
        <code>body &#123;&#8203;...&#8203;&#125;</code> 或 <code>:root &#123;&#8203;...&#8203;&#125;</code> 都压不住主题那一层。
      </p>
      <p className="set-note">片段是文件，不在库里：每日快照、导出、换库都<strong>不含</strong>它们。</p>
    </>
  )
}

/* ── 快捷键（只读。为什么不做改键：期-09b 设计稿 §七 决策 46） ── */

const 顺序: CommandGroup[] = ['跳转', '新建', '工作区', '视图', '编辑器', '数据']

function Keys(): JSX.Element {
  const [问, set问] = useState('')
  const 组 = useMemo(() => {
    const 词 = 问.trim().toLowerCase()
    const 中 = COMMANDS.filter(
      (c) => !词 || c.title.toLowerCase().includes(词) || (c.keys ?? []).join(' ').toLowerCase().includes(词)
    )
    return 顺序.map((g) => ({ g, items: 中.filter((c) => c.group === g) })).filter((x) => x.items.length)
  }, [问])

  return (
    <>
      <input
        className="set-search"
        placeholder="搜命令或键位，比如 升格 / Ctrl+Shift"
        value={问}
        onChange={(e) => set问(e.target.value)}
      />
      <p className="set-note">键位目前改不了：这里照的是命令表那一份真相源，改键是另一期要做的事。</p>
      {组.map((x) => (
        <div key={x.g}>
          <div className="sec-label" style={{ padding: 0, marginBottom: 6 }}>
            {x.g}
          </div>
          {x.items.map((c) => (
            <div className="set-row" key={c.id}>
              <span className="k">{c.title}</span>
              <span className="v keys">
                {(c.keys ?? []).length === 0 ? (
                  <em>只从命令面板进</em>
                ) : (
                  (c.keys ?? []).map((k) => <kbd key={k}>{keyLabel(k)}</kbd>)
                )}
              </span>
            </div>
          ))}
        </div>
      ))}
    </>
  )
}

/* ── 数据 ── */

function Data(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const patch = useStore((s) => s.patchSettings)
  const setTransferOpen = useStore((s) => s.setTransferOpen)
  const setTransferTab = useStore((s) => s.setTransferTab)
  const info = useAppInfo()
  return (
    <>
      <Toggle
        on={settings.backupEnabled}
        title="每天开应用时自动落一份快照"
        desc="落在 backups/ 目录里，VACUUM INTO 那一份是完整的库"
        onClick={() => void patch({ backupEnabled: !settings.backupEnabled })}
      />
      <div className="slider-row">
        <label htmlFor="keep">留几份</label>
        <input
          id="keep"
          type="number"
          min={3}
          max={30}
          value={settings.backupKeep}
          onChange={(e) => void patch({ backupKeep: keepClamp(Number(e.target.value)) })}
        />
        <b>{keepClamp(settings.backupKeep)} 份</b>
      </div>
      <p className="set-note">
        3 到 30，越界贴边。「回收站与历史版本满 30 天那一刀」只在<strong>当天那一份已经在盘上</strong>时才动手，
        所以关掉自动备份，那一刀也跟着停。
      </p>
      <div className="set-path">
        <code>{info?.backupsDir ?? ''}</code>
        <button className="btn ghost" onClick={() => void window.kestrel.shell.openDir('backups')}>
          打开这个文件夹
        </button>
      </div>
      <div className="set-actions">
        <button
          className="btn ghost"
          onClick={() => {
            setTransferTab('backup')
            setTransferOpen(true)
          }}
        >
          去备份 / 恢复那一档
        </button>
        <button
          className="btn ghost"
          onClick={() => {
            setTransferTab('export')
            setTransferOpen(true)
          }}
        >
          去导出 / 导入那一档
        </button>
      </div>
      <p className="set-note">别拿拷 <code>.db</code> 文件当备份：应用开着时最近的改动还在 <code>-wal</code> 里。</p>
    </>
  )
}

/* ── 关于 ── */

function About({ settingsTheme }: { settingsTheme: string }): JSX.Element {
  const info = useAppInfo()
  return (
    <>
      <div className="set-row">
        <span className="k">版本</span>
        <span className="v">{info?.version ?? '…'}</span>
      </div>
      <div className="set-row">
        <span className="k">库结构</span>
        <span className="v">v{info?.schema ?? '…'}</span>
      </div>
      <div className="set-row">
        <span className="k">当前主题</span>
        <span className="v">{settingsTheme}</span>
      </div>
      <div className="set-row">
        <span className="k">库文件</span>
        <span className="v mono">{info?.dbFile ?? '…'}</span>
      </div>
      <p className="set-note">
        本地优先：这一个文件就是你全部的内容，零网络请求。卸载应用不会动它，也不会动 <code>snippets/</code> 与{' '}
        <code>backups/</code>。
      </p>
      <p className="set-note">Kestrel · AGPL-3.0-only · Copyright © 2026 fangjj1008</p>
    </>
  )
}

/* AppInfo 取一次挂在模块上：它是「版本 + 路径」，跑着跑着不会变，
 *  而两个格子（片段 / 关于）都要看它——不如在第一次要的时候问一次。 */
let 缓存: AppInfo | null = null
let 在问: Promise<AppInfo> | null = null

function useAppInfo(): AppInfo | null {
  const [v, set] = useState<AppInfo | null>(缓存)
  useEffect(() => {
    if (缓存) {
      set(缓存)
      return
    }
    // 只问一次：片段与关于两格可能同屏
    在问 ??= window.kestrel.shell.info().then((r) => (缓存 = r))
    let 活着 = true
    void 在问.then((r) => {
      if (活着) set(r)
    })
    return () => {
      活着 = false
    }
  }, [])
  return v
}
