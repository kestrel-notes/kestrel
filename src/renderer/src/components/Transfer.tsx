/** 「流通」面板的外壳（期-08 §九）：三档向导共用一张卡片。
 *
 *  分成三档是因为这三件事的风险不一样：导出写的是**副本**（库里一个字不动，最坏是目标目录里
 *  同名文件被盖掉），导入写的是**库本身**，备份那一档连库文件都要换掉。所以各有各的账，
 *  各有各的确认按钮。
 *
 *  写盘/写库进行中把 `transferBusy` 挂到 store 上，Esc 那条链（`App.tsx`）看着它决定放不放行。
 *  放在 store 而不是这里挂事件监听，是因为 Esc 该关谁本来就是那一条链一个人说了算——
 *  在面板里再堵一道，等于同一件事有两个判据（实测那样会漏）。要停手用那一档里的「中止」。 */

import type { JSX } from 'react'
import { useStore } from '@/store'
import { BackupPane } from './BackupPane'
import { ExportWizard } from './ExportWizard'
import { ImportWizard } from './ImportWizard'

const 档 = {
  export: { 名: '导出', 标题: '导出为 Markdown', 说: '目录树 + front-matter，任何编辑器都能读' },
  import: { 名: '导入', 标题: '从 Markdown 导回', 说: '只认自家导出的那一份，认不出的一个字都不读' },
  backup: { 名: '备份', 标题: '备份与恢复', 说: '一天一份，最近的几份随时换得回去' },
} as const

type Tab = keyof typeof 档

export function Transfer(): JSX.Element | null {
  const open = useStore((s) => s.transferOpen)
  const setOpen = useStore((s) => s.setTransferOpen)
  const tab = useStore((s) => s.transferTab) as Tab
  const setTab = useStore((s) => s.setTransferTab)
  const busy = useStore((s) => s.transferBusy)
  const setBusy = useStore((s) => s.setTransferBusy)

  if (!open) return null

  const 当前 = 档[tab] ?? 档.export

  return (
    <div className="sheet open" onClick={() => !busy && setOpen(false)}>
      <div
        className="sheet-card tr-card"
        role="dialog"
        aria-modal="true"
        aria-label={当前.标题}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h3>{当前.标题}</h3>
            <p>{当前.说}</p>
          </div>
          <button className="close-x" disabled={busy} onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        <div className="tr-tabs" role="tablist">
          {(Object.keys(档) as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`tr-tab ${tab === t ? 'on' : ''}`}
              disabled={busy}
              title={busy ? '正在写，等它停下再来' : undefined}
              onClick={() => setTab(t)}
            >
              {档[t].名}
            </button>
          ))}
        </div>

        <ExportWizard open={tab === 'export'} onBusy={setBusy} />
        <ImportWizard open={tab === 'import'} onBusy={setBusy} />
        <BackupPane open={tab === 'backup'} />
      </div>
    </div>
  )
}
