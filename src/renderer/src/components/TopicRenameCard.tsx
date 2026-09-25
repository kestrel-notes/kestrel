/** 主题改名的确认弹层（§8-D4）。与 `TagRenameCard` 同一个形状，多出来的是那三档选择。
 *
 *  为什么改名要问第二遍而改颜色不用：它动的是**全库正文**，一次点下去可能重写上几十篇。
 *  所以确认之前必须把 `topic:impact` 那两个数字摊开，并且让用户自己决定怎么处理 `[[旧名]]`：
 *  - `'rewrite'` → 名字与正文同一个事务里改完（每篇动手前先存一版历史，那就是撤销）
 *  - `'alias'`（**默认**）→ 正文一个字不动，旧名绑成这个主题的一条别名（期-05c）
 *  - `'detach'` → 只改这一行，旧引用降级成悬空，会出现在悬空那一栏里而不是静悄悄消失
 *
 *  为什么默认从"不勾"换成"留别名"：原来那两档里，默认档是**代价最大**的那一档
 *  （什么都不做 = 几十处链接掉下来）。三档里只有 'alias' 既不写正文又不让链接掉。
 *  旧名被别处占着时这一档会退化成 detach，那一层由 toast 说出来（store 里那句"别名没留下"）。 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { RenameImpact, TopicRenameMode } from '../../../shared/types'
import { useStore } from '@/store'
import { focusEditor } from '@/dom'

const 项: { mode: TopicRenameMode; 标题: string; 说: string }[] = [
  {
    mode: 'alias',
    标题: '旧名留作别名（正文一个字不动）',
    说: '之后写着 [[旧名]] 的地方照样指到这里。这一条在「别名」窗里能看到、能删。',
  },
  {
    mode: 'rewrite',
    标题: '连正文一起改写',
    说: '每篇动手之前先存一版历史，改错了在右栏「历史版本」里退回那一版。',
  },
  {
    mode: 'detach',
    标题: '什么都不做，旧写法掉成悬空',
    说: '它们会列在悬空那一栏里，哪天把主题改回这个名字又能自动连上。',
  },
]

export function TopicRenameCard(): JSX.Element | null {
  const target = useStore((s) => s.topicRename)
  const setTarget = useStore((s) => s.setTopicRename)
  const impactOf = useStore((s) => s.topicImpact)
  const rename = useStore((s) => s.renameTopic)

  const [to, setTo] = useState('')
  const [mode, setMode] = useState<TopicRenameMode>('alias')
  const [impact, setImpact] = useState<RenameImpact | null>(null)

  // 每次点名一个主题都重新起头：默认填当前名字、默认「留作别名」，代价数字重算一遍。
  // 依赖只写 target——跟着 topics 变的话，用户正在敲字时后台刷了列表，输入会被冲掉
  useEffect(() => {
    if (target === null) return
    setTo(target.from)
    setMode('alias')
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
  const 在用它 = impact !== null && impact.hits > 0

  return (
    <div className="sheet open" onClick={() => setTarget(null)}>
      <div
        className="sheet-card rename-card topic-rename-card"
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
              if (e.key === 'Enter' && legal && changed) void rename(target.id, trimmed, mode)
            }}
          />
        </label>

        {!legal && trimmed !== '' && <div className="empty-hint">主题名最多 40 个字符。</div>}
        {legal && !changed && <div className="empty-hint">名字没变，不用改。</div>}

        {legal && changed && impact && (
          <div className="rn-modes" role="radiogroup" aria-label="旧名字怎么处理">
            {项.map((it) => (
              <label key={it.mode} className={`rn-mode ${mode === it.mode ? 'on' : ''}`}>
                <input
                  type="radio"
                  name="topic-rename-mode"
                  checked={mode === it.mode}
                  onChange={() => setMode(it.mode)}
                />
                <span className="rn-t">
                  {it.标题}
                  {it.mode === 'rewrite' && 在用它
                    ? `（${impact.entries} 篇记录、${impact.hits} 处）`
                    : it.mode === 'detach' && 在用它
                      ? `（${impact.hits} 处会掉）`
                      : it.mode === 'alias' && 在用它
                        ? `（${impact.hits} 处照旧指着这里）`
                        : ''}
                </span>
                {mode === it.mode && <span className="rn-s">{it.说}</span>}
              </label>
            ))}
          </div>
        )}
        {legal && changed && impact && !在用它 && (
          <div className="empty-hint">现在没有正文在写这个名字，三档效果一样。</div>
        )}

        <div className="card-actions">
          <button className="chip" onClick={() => setTarget(null)}>
            取消
          </button>
          <button
            className="chip primary"
            disabled={!legal || !changed}
            onClick={() => void rename(target.id, trimmed, mode)}
          >
            改名
          </button>
        </div>
      </div>
    </div>
  )
}
