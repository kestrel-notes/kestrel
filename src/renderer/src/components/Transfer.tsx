/** 「流通」面板的外壳（期-08 §九）：两档向导共用一张卡片。
 *
 *  分成两档是因为这两件事的风险不一样：导出写的是**副本**（库里一个字不动，最坏是目标目录里
 *  同名文件被盖掉），导入写的是**库本身**。所以两档各有各的账，各有各的确认按钮。
 *
 *  写盘/写库进行中把 `transferBusy` 挂到 store 上，Esc 那条链（`App.tsx`）看着它决定放不放行。
 *  放在 store 而不是这里挂事件监听，是因为 Esc 该关谁本来就是那一条链一个人说了算——
 *  在面板里再堵一道，等于同一件事有两个判据（实测那样会漏）。要停手用那一档里的「中止」。 */

import type { JSX } from 'react'
import { useStore } from '@/store'
import { ExportWizard } from './ExportWizard'
import { ImportWizard } from './ImportWizard'

export function Transfer(): JSX.Element | null {
  const open = useStore((s) => s.transferOpen)
  const setOpen = useStore((s) => s.setTransferOpen)
  const tab = useStore((s) => s.transferTab)
  const setTab = useStore((s) => s.setTransferTab)
  const busy = useStore((s) => s.transferBusy)
  const setBusy = useStore((s) => s.setTransferBusy)

  if (!open) return null

  const 标题 = tab === 'export' ? '导出为 Markdown' : '从 Markdown 导回'

  return (
    <div className="sheet open" onClick={() => !busy && setOpen(false)}>
      <div
        className="sheet-card tr-card"
        role="dialog"
        aria-modal="true"
        aria-label={标题}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h3>{标题}</h3>
            <p>
              {tab === 'export'
                ? '目录树 + front-matter，任何编辑器都能读'
                : '只认自家导出的那一份，认不出的一个字都不读'}
            </p>
          </div>
          <button className="close-x" disabled={busy} onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        <div className="tr-tabs" role="tablist">
          {(['export', 'import'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`tr-tab ${tab === t ? 'on' : ''}`}
              disabled={busy}
              title={busy ? '正在写，等它停下再来' : undefined}
              onClick={() => setTab(t)}
            >
              {t === 'export' ? '导出' : '导入'}
            </button>
          ))}
        </div>

        <ExportWizard open={tab === 'export'} onBusy={setBusy} />
        <ImportWizard open={tab === 'import'} onBusy={setBusy} />
      </div>
    </div>
  )
}
