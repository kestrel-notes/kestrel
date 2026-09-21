/** 历史版本的预览。点右栏「历史版本」里的一行打开（设计文档 §2.4）。
 *
 *  差异是**纯文本行级**的，不引 diff 库：一份修订版通常只差几处，行级够看。
 *  方向是「当前 → 那一版」：`+` 是恢复后会回来的行，`-` 是恢复后会消失的行。 */

import type { JSX } from 'react'
import { useMemo } from 'react'
import { useStore } from '@/store'
import { diffLines } from '@/diff'
import { relativeTime } from '../../../shared/date'

const REASON: Record<string, string> = {
  auto: '自动',
  manual: '手动保存',
  restore: '恢复前自保',
}

export function VersionSheet(): JSX.Element | null {
  const rev = useStore((s) => s.versionOf)
  const content = useStore((s) => s.content)
  const close = useStore((s) => s.closeVersion)
  const restore = useStore((s) => s.restoreVersion)

  const lines = useMemo(
    () => (rev ? diffLines(content, rev.content) : []),
    [rev, content]
  )

  if (!rev) return null

  const changed = lines.filter((l) => l.kind !== 'same').length

  return (
    <div className="sheet open" onClick={close}>
      <div
        className="sheet-card version-card"
        role="dialog"
        aria-modal="true"
        aria-label="历史版本"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h3>{rev.title ?? '无标题版本'}</h3>
            <p>
              {rev.createdAt.slice(0, 16).replace('T', ' ')} · {relativeTime(rev.createdAt)} ·{' '}
              {REASON[rev.reason] ?? rev.reason} · {rev.content.length} 字
            </p>
          </div>
          <button className="close-x" onClick={close}>
            ×
          </button>
        </div>

        <div className="sec-label" style={{ padding: 0, marginBottom: 9 }}>
          {changed === 0 ? '与当前内容完全一致' : `相对当前内容有 ${changed} 行不同（+ 恢复后回来，− 恢复后消失）`}
        </div>

        <div className="diff">
          {lines.map((l, i) => (
            <div key={i} className={`diff-line ${l.kind}`}>
              <span className="diff-mark">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
              <span>{l.text}</span>
            </div>
          ))}
        </div>

        <div className="card-actions">
          <button className="chip" onClick={close}>
            关闭
          </button>
          <button
            className="chip primary"
            disabled={changed === 0}
            onClick={() => void restore(rev.id)}
            title="会先把当前状态存一版，所以恢复错了还能退回来"
          >
            恢复到此版本
          </button>
        </div>
      </div>
    </div>
  )
}