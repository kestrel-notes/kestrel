/** 主题改名的确认弹层（§8-D4）。与 `TagRenameCard` 同一个形状，多出来的是那枚勾选框。
 *
 *  为什么改名要问第二遍而改颜色不用：它动的是**全库正文**，一次点下去可能重写上几十篇。
 *  所以确认之前必须把 `topic:impact` 那两个数字摊开，并且让用户自己决定要不要搬 `[[旧名]]`：
 *  - 勾上 → 名字与正文同一个事务里改完（`topics.rename`）
 *  - 不勾 → 只改这一行，旧引用降级成悬空，会出现在悬空那一栏里而不是静悄悄消失
 *
 *  改前每篇都会先存一版历史（`reason='manual'`），**那就是它的撤销**，所以这里不再 undo。 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { RenameImpact } from '../../../shared/types'
import { useStore } from '@/store'
import { focusEditor } from '@/dom'

export function TopicRenameCard(): JSX.Element | null {
  const target = useStore((s) => s.topicRename)
  const setTarget = useStore((s) => s.setTopicRename)
  const impactOf = useStore((s) => s.topicImpact)
  const rename = useStore((s) => s.renameTopic)

  const [to, setTo] = useState('')
  const [rewrite, setRewrite] = useState(true)
  const [impact, setImpact] = useState<RenameImpact | null>(null)

  // 每次点名一个主题都重新起头：默认填当前名字、默认勾上「改写正文」，代价数字重算一遍。
  // 依赖只写 target——跟着 topics 变的话，用户正在敲字时后台刷了列表，输入会被冲掉
  useEffect(() => {
    if (target === null) return
    setTo(target.from)
    setRewrite(true)
    setImpact(null)
    let alive = true
    void impactOf(target.from).then((r) => {
      if (alive) setImpact(r)
    })
    return () => {
      alive = false
      focusEditor()
    }
  }, [target, impactOf])

  if (target === null) return null

  const trimmed = to.trim()
  const changed = trimmed !== '' && trimmed !== target.from
  const legal = trimmed !== '' && trimmed.length <= 40

  return (
    <div className="sheet open" onClick={() => setTarget(null)}>
      <div
        className="sheet-card rename-card"
        role="dialog"
        aria-modal="true"
        aria-label={`重命名主题 ${target.from}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h3>重命名「{target.from}」</h3>
            <p>主题名是正文里 [[双链]] 的查找键，所以改名可能动到别的记录</p>
          </div>
          <button className="close-x" onClick={() => setTarget(null)}>
            ×
          </button>
        </div>

        <label className="field">
          <span>新名字</span>
          <input
            autoFocus
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && legal && changed) void rename(target.id, trimmed, rewrite)
            }}
          />
        </label>

        {!legal && trimmed !== '' && <div className="empty-hint">主题名最多 40 个字符。</div>}
        {legal && !changed && <div className="empty-hint">名字没变，不用改。</div>}

        {legal && changed && impact && (
          <label className="tm-rewrite">
            <input
              type="checkbox"
              checked={rewrite}
              onChange={(e) => setRewrite(e.target.checked)}
            />
            <span>
              同时改写正文里的 [[{target.from}]]
              {impact.entries > 0
                ? `（${impact.entries} 篇记录、${impact.hits} 处）`
                : '（现在没有正文在用它，勾不勾一样）'}
            </span>
          </label>
        )}
        {legal && changed && impact && (
          <div className="empty-hint">
            {rewrite
              ? '每篇动手之前先存一版历史，改错了在右栏「历史版本」里退回那一版。'
              : `不勾的话那 ${impact.hits} 处 [[${target.from}]] 会变成悬空引用——它们会列在悬空那一栏里，哪天把主题改回这个名字又能自动连上。`}
          </div>
        )}

        <div className="card-actions">
          <button className="chip" onClick={() => setTarget(null)}>
            取消
          </button>
          <button
            className="chip primary"
            disabled={!legal || !changed}
            onClick={() => void rename(target.id, trimmed, rewrite)}
          >
            改名
          </button>
        </div>
      </div>
    </div>
  )
}
