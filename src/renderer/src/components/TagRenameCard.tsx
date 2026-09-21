/** 标签改名的确认弹层（期-02-设计 §2.3 的「先算，再问，再改」里那一步"问"）。
 *
 *  动的是全库正文，不是某一行记录，所以确认之前必须把 `tag:impact` 那两个数字摊开。
 *  改名前每篇都会先存一版历史（`reason='manual'`），**那就是它的撤销**——
 *  所以这里不另做 undo，也不再问第二遍。 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { RenameImpact } from '../../../shared/types'
import { isTagName, normalizeTagKey } from '../../../shared/tags'
import { findTag, useStore } from '@/store'
import { focusEditor } from '@/dom'

export function TagRenameCard(): JSX.Element | null {
  /** 要改名的那个标签（归一后的完整路径），null = 弹层关着 */
  const from = useStore((s) => s.tagRename)
  const tags = useStore((s) => s.tags)
  const setTagRename = useStore((s) => s.setTagRename)
  const tagImpact = useStore((s) => s.tagImpact)
  const rename = useStore((s) => s.renameTag)

  const [to, setTo] = useState('')
  const [impact, setImpact] = useState<RenameImpact | null>(null)

  // 每次点名一个标签都重新起头：默认填当前名字，代价数字重算一遍。
  // 依赖只写 from——跟着 tags 变的话，用户正在敲字时后台刷了树，输入会被冲掉
  useEffect(() => {
    if (from === null) return
    setTo(from)
    setImpact(null)
    let alive = true
    void tagImpact(from).then((r) => {
      if (alive) setImpact(r)
    })
    return () => {
      alive = false
      focusEditor()
    }
  }, [from, tagImpact])

  if (from === null) return null

  const key = normalizeTagKey(to)
  // 「改完还是一个标签」这件事必须由解析器说了算：`#a b`、`#123`、带 emoji 的尾巴
  // 写进正文会被规则 4、6 吃掉一半，那是内容损失，不是改名
  const legal = to.trim() !== '' && isTagName(to)
  const changed = key !== '' && key !== from
  const merge = changed && findTag(tags, (n) => n.name === key) !== null

  return (
    <div className="sheet open" onClick={() => setTagRename(null)}>
      <div
        className="sheet-card rename-card"
        role="dialog"
        aria-modal="true"
        aria-label={`重命名标签 #${from}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h3>重命名 #{from}</h3>
            <p>改的是全库正文里的 # 写法，它的子孙标签（#{from}/…）跟着一起搬</p>
          </div>
          <button className="close-x" onClick={() => setTagRename(null)}>
            ×
          </button>
        </div>

        <label className="field">
          <span>新名字</span>
          <input
            autoFocus
            value={to}
            placeholder="例如 工作/项目B"
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && legal && changed) void rename(to)
            }}
          />
        </label>

        {!legal && to.trim() !== '' && (
          <div className="empty-hint">
            这个名字写进正文不会被解析成标签（不能带空格、不能是纯数字、尾巴上的中文标点会被剪掉），
            所以不能改成它。
          </div>
        )}
        {legal && !changed && <div className="empty-hint">名字没变，不用改。</div>}
        {legal && changed && impact && (
          <div className="empty-hint">
            会改写 {impact.entries} 篇记录里的 {impact.hits} 处。每篇动手前先存一版历史，
            改错了在右栏「历史版本」里退回那一版。
          </div>
        )}
        {legal && changed && merge && (
          <div className="empty-hint">
            #{key} 已经在用了：改完这两个会并成一个标签，它原来配的颜色与说明可能被 #{from} 那份顶掉。
          </div>
        )}

        <div className="card-actions">
          <button className="chip" onClick={() => setTagRename(null)}>
            取消
          </button>
          <button
            className="chip primary"
            disabled={!legal || !changed}
            onClick={() => void rename(to)}
          >
            改名
          </button>
        </div>
      </div>
    </div>
  )
}
