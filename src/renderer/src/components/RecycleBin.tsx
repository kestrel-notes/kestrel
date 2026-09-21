/** 回收站。软删除的记录在这里能取回，也能真删掉（设计文档 §2.3）。
 *
 *  恢复日记时可能撞上「这天已有一篇日记」——那是 `idx_entry_diary_date` 给的硬约束，
 *  不吞错，把主进程的话原样提示出来，那条记录留在回收站。
 *
 *  这里**不写倒计时**：主进程到现在没有任何自动清理路径（第 8 期才跟备份清理一处做），
 *  标一个「剩 30 天」等于承诺一件不会发生的事——用户可能因此以为不点「彻底删除」东西也会自己消失。 */

import type { JSX } from 'react'
import { useStore, entryLabel } from '@/store'
import { formatDateZh, relativeTime } from '../../../shared/date'

export function RecycleBin(): JSX.Element | null {
  const open = useStore((s) => s.binOpen)
  const rows = useStore((s) => s.binRows)
  const setOpen = useStore((s) => s.setBinOpen)
  const restore = useStore((s) => s.restoreDeleted)
  const purge = useStore((s) => s.purgeEntry)
  const askConfirm = useStore((s) => s.askConfirm)

  if (!open) return null

  async function confirmPurge(id: number, label: string): Promise<void> {
    const ok = await askConfirm({
      title: `彻底删掉「${label}」？`,
      body: '不可恢复：它的历史版本与所有链接会一起删掉。',
      confirmLabel: '彻底删除',
    })
    if (ok) void purge(id)
  }

  return (
    <div className="sheet open" onClick={() => setOpen(false)}>
      <div
        className="sheet-card"
        role="dialog"
        aria-modal="true"
        aria-label="回收站"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h3>回收站</h3>
            <p>删掉的记录留在这里，直到你点「彻底删除」</p>
          </div>
          <button className="close-x" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        {rows.length === 0 ? (
          <div className="empty-hint">回收站是空的。</div>
        ) : (
          <div className="bin-list">
            {rows.map((r) => {
              const label = entryLabel(r)
              return (
                <div key={r.id} className="bin-row">
                  <div className="bin-main">
                    <b>{label}</b>
                    <span className="bin-sub">
                      {r.kind === 'diary' ? '日记' : '文章'} · 删除于 {relativeTime(r.deletedAt ?? '')}
                    </span>
                  </div>
                  <span className="bin-date mono">{formatDateZh(r.entryDate)}</span>
                  <button className="chip" onClick={() => void restore(r.id)}>
                    恢复
                  </button>
                  <button className="chip danger" onClick={() => confirmPurge(r.id, label)}>
                    彻底删除
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}