/** 别名窗（期-05c §9.2 第 5 件）：全库「写法 → 目标」那一本台账。
 *
 *  为什么要有这一扇窗，而不是把别名当成改主题名的副产品：别名一旦写进库就是**数据**，
 *  有生命也有寿命——看不见、查不到、删不掉的数据是负债。尤其改名自动留下的那一条
 *  （`旧名 → 那个已经改叫别的名字的主题`），总有一天用户想把它撤掉；没有入口的话
 *  那条写法会永远指着过去的名字。
 *
 *  绑目标只给两种选法：一个已有主题，或**当前正开着这一篇**。不做全库记录搜索——
 *  那是 `Ctrl+K` 的活，在这扇窗里再塞一套搜索结果，界面就变成两块面板的混合物，
 *  而"绑一条别名"本来是个十几次一量的动作。
 *
 *  每行右侧那两枚标记都不能省：`未生效`说的是"这一条轮不到"（前三层有人占着这个名字），
 *  `连着几篇`说的是"删掉会松开几条"。删完掉回悬空是**故意的**，所以那条数要报出来。 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from '@/store'

export function AliasSheet(): JSX.Element | null {
  const open = useStore((s) => s.aliasOpen)
  const rows = useStore((s) => s.aliasRows)
  const setOpen = useStore((s) => s.setAliasOpen)
  const topics = useStore((s) => s.topics)
  const currentId = useStore((s) => s.currentId)
  const title = useStore((s) => s.title)
  const entry = useStore((s) => s.entry)
  const add = useStore((s) => s.addAlias)
  const drop = useStore((s) => s.dropAlias)

  const [name, setName] = useState('')
  const [kind, setKind] = useState<'topic' | 'entry'>('topic')
  const [topicId, setTopicId] = useState<number | null>(null)

  // 每次开窗都回到"没在填"的样子：上一次填一半没绑的字不该在下次进来时还挂着
  useEffect(() => {
    if (!open) return
    setName('')
    setKind(topics.length > 0 ? 'topic' : 'entry')
    setTopicId(null)
  }, [open, topics.length])

  if (!open) return null

  const 当前标题 = title.trim() === '' ? (entry?.entryDate ?? '') : title.trim()
  const 绑到 = kind === 'topic' ? topicId : currentId
  const 能绑 = name.trim() !== '' && 绑到 !== null

  return (
    <div className="sheet open" onClick={() => setOpen(false)}>
      <div
        className="sheet-card alias-card"
        role="dialog"
        aria-modal="true"
        aria-label="全局别名"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h3>全局别名</h3>
            <p>别名是兜底那一层：日期、主题名、文章标题都认不出的写法才轮到它。绑上之后，正文里 [[这么写]] 的都指过去</p>
          </div>
          <button className="close-x" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        <div className="al-add">
          <label className="field">
            <span>写法</span>
            <input
              value={name}
              placeholder="玻璃"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && 能绑) void add(name.trim(), kind, 绑到 as number)
              }}
            />
          </label>
          <div className="field">
            <span>绑到</span>
            <div className="al-kind">
              <button
                className={`chip ${kind === 'topic' ? 'on' : ''}`}
                onClick={() => setKind('topic')}
                disabled={topics.length === 0}
                title={topics.length === 0 ? '库里还没有主题' : '绑到一个主题上'}
              >
                主题
              </button>
              <button
                className={`chip ${kind === 'entry' ? 'on' : ''}`}
                onClick={() => setKind('entry')}
                disabled={currentId === null}
                title={currentId === null ? '没有打开的记录' : '绑到当前正开着的这一篇'}
              >
                当前这一篇
              </button>
            </div>
            {kind === 'topic' ? (
              <select
                className="al-target"
                value={topicId ?? ''}
                onChange={(e) => setTopicId(e.target.value === '' ? null : Number(e.target.value))}
              >
                <option value="">（挑一个主题）</option>
                {topics.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="al-target as-text">
                {currentId === null ? '没有打开的记录' : `#${currentId} ${当前标题}`}
              </div>
            )}
          </div>
          <button
            className="chip primary"
            disabled={!能绑}
            onClick={() => void add(name.trim(), kind, 绑到 as number)}
          >
            绑定
          </button>
        </div>

        {rows.length === 0 ? (
          <div className="empty-hint">
            还没有别名。改主题名时选「留下旧名当别名」会在这里留下一条，上面也能手动绑。
          </div>
        ) : (
          <>
            <div className="sec-label">
              全库别名<span>{rows.length}</span>
            </div>
            <div className="al-list">
              {rows.map((r) => (
                <div key={r.id} className={`al-row ${r.active ? '' : 'inactive'}`}>
                  <div className="al-main">
                    <b>{r.name}</b>
                    <span className="al-arrow">→</span>
                    <span className="al-to">
                      {r.targetKind}「{r.targetName}」
                    </span>
                  </div>
                  {!r.active && <span className="badge draft">未生效 · 被{r.shadowedBy}占着</span>}
                  {r.active && r.holding > 0 && (
                    <span className="bk-sub" title="删掉这一条，那几处会掉回悬空">
                      连着 {r.holding} 处
                    </span>
                  )}
                  <button className="chip" onClick={() => void drop(r.id)} title="解绑（内容一篇不动）">
                    解绑
                  </button>
                </div>
              ))}
            </div>
            {rows.some((r) => !r.active) && (
              <div className="empty-hint">
                标「未生效」的那些一条也没连过——解析轮不到它们。要么把占着的那个名字改走，要么解绑这一条。
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
