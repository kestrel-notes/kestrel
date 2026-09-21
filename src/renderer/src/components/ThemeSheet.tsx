import type { JSX } from 'react'
import { useStore } from '@/store'
import { THEMES } from '@/themes'

export function ThemeSheet(): JSX.Element | null {
  const open = useStore((s) => s.sheetOpen)
  const setOpen = useStore((s) => s.setSheetOpen)
  const settings = useStore((s) => s.settings)
  const patch = useStore((s) => s.patchSettings)

  if (!open) return null

  return (
    <div className="sheet open" onClick={() => setOpen(false)}>
      <div className="sheet-card" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <h3>外观</h3>
            <p>配色方案、强调色与毛玻璃参数</p>
          </div>
          <button className="close-x" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

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
                <i
                  style={{
                    left: 6,
                    top: 6,
                    width: 40,
                    height: 5,
                    background: 'var(--text-3)',
                    opacity: 0.55,
                  }}
                />
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
                <i
                  style={{ left: 74, top: 17, width: 24, height: 26, background: 'var(--accent)' }}
                />
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

        <div className="row-toggle">
          <div>
            启用毛玻璃
            <em>关闭后所有面板降级为纯色，长列表滚动更省电</em>
          </div>
          <button
            className={`sw ${settings.glass ? 'on' : ''}`}
            aria-pressed={settings.glass}
            onClick={() => void patch({ glass: !settings.glass })}
          />
        </div>

        <div className="row-toggle">
          <div>
            跟随系统深浅色
            <em>系统切暗色时自动换到极夜黑，亮色时回到亮色主题</em>
          </div>
          <button
            className={`sw ${settings.followSystem ? 'on' : ''}`}
            aria-pressed={settings.followSystem}
            onClick={() => void patch({ followSystem: !settings.followSystem })}
          />
        </div>
      </div>
    </div>
  )
}