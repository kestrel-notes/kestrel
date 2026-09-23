/** 查询与模板（期-07 §四、§五）：两张新表的管理面板。
 *
 *  为什么合成一张而不是两张：它们的用法是同一件事的两头——模板写下「要记什么」，
 *  查询读出「记成了什么」。分开两处管理的话，调模板的人要来回跳着看查询有没有命中。
 *
 *  这里只放**列表与增删改**。结果的预览在正文那截围栏下面（`editor/queryBlock.ts`），
 *  不在面板里再画一遍：两套渲染器要一起养，而面板里能做的选择正文那边都做得。 */

import { useState, type JSX } from 'react'
import { useStore } from '@/store'
import { varsIn } from '../../../shared/template'
import type { SavedQuery, Template } from '../../../shared/types'

export function Library(): JSX.Element | null {
  const open = useStore((s) => s.libraryOpen)
  const setOpen = useStore((s) => s.setLibraryOpen)
  const saved = useStore((s) => s.savedQueries)
  const tpls = useStore((s) => s.templates)
  const insertQuery = useStore((s) => s.insertQuery)
  const removeSaved = useStore((s) => s.removeSaved)
  const applyTemplate = useStore((s) => s.applyTemplate)
  const updateTemplate = useStore((s) => s.updateTemplate)
  const removeTemplate = useStore((s) => s.removeTemplate)
  const createTemplate = useStore((s) => s.createTemplate)
  const askConfirm = useStore((s) => s.askConfirm)

  const [newName, setNewName] = useState('')
  const [newScope, setNewScope] = useState<'diary' | 'article'>('diary')
  const [newBody, setNewBody] = useState('## 今日\n\n- \n')

  if (!open) return null

  async function addTemplate(): Promise<void> {
    if (!newName.trim() || !newBody.trim()) return
    await createTemplate({ name: newName.trim(), scope: newScope, body: newBody })
    setNewName('')
  }

  async function forgetTemplate(t: Template): Promise<void> {
    const ok = await askConfirm({
      title: `删掉模板「${t.name}」？`,
      body: '只删模板本身。已经套进正文的那一份是普通文字，一个字都不动。',
      confirmLabel: '删除',
    })
    if (ok) void removeTemplate(t.id)
  }

  async function forgetQuery(q: SavedQuery): Promise<void> {
    const ok = await askConfirm({
      title: `删掉查询「${q.name}」？`,
      body: '正文里已经插进去的那截围栏不受影响——存查询只是语句的一个别名，不是引用。',
      confirmLabel: '删除',
    })
    if (ok) void removeSaved(q.id)
  }

  return (
    <div className="sheet open" onClick={() => setOpen(false)}>
      <div
        className="sheet-card lib-card"
        role="dialog"
        aria-modal="true"
        aria-label="查询与模板"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h3>查询与模板</h3>
            <p>模板写下「要记什么」，查询读出「记成了什么」</p>
          </div>
          <button className="close-x" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        <div className="lib-scroll">
          <section>
            <h4>存查询</h4>
            {saved.length === 0 ? (
              <div className="empty-hint">
                还没有存下的查询。在正文里写一截 ```query 围栏，跑出结果后点右上角「存为」。
              </div>
            ) : (
              <div className="lib-list">
                {saved.map((q) => (
                  <div key={q.id} className="lib-row">
                    <div className="lib-main">
                      <b>{q.name}</b>
                      <pre className="lib-body mono">{q.body}</pre>
                    </div>
                    <span className="lib-tag mono">{q.view}</span>
                    <button className="chip" onClick={() => void insertQuery(q.body, q.id)}>
                      插入
                    </button>
                    <button className="chip danger" onClick={() => void forgetQuery(q)}>
                      删除
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h4>模板</h4>
            {tpls.length === 0 ? (
              <div className="empty-hint">还没有模板。下面起个名字、写好正文，就能存一条。</div>
            ) : (
              <div className="lib-list">
                {tpls.map((t) => (
                  <div key={t.id} className="lib-row">
                    <div className="lib-main">
                      <b>{t.name}</b>
                      <pre className="lib-body mono">{t.body}</pre>
                      <span className="lib-vars mono">{varsIn(t.body).map((v) => `{{${v}}}`).join(' ')}</span>
                    </div>
                    <span className="lib-tag">{t.scope === 'diary' ? '日记' : '文章'}</span>
                    <button
                      className={`chip${t.isDefault ? ' on' : ''}`}
                      title="新建那一篇时自动套这一条（每个类别只能有一条）"
                      onClick={() => void updateTemplate(t.id, { isDefault: !t.isDefault })}
                    >
                      默认
                    </button>
                    <button className="chip" onClick={() => void applyTemplate(t.id)}>
                      套用
                    </button>
                    <button className="chip danger" onClick={() => void forgetTemplate(t)}>
                      删除
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="lib-new">
              <input
                className="lib-name"
                placeholder="模板名字"
                maxLength={60}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <select value={newScope} onChange={(e) => setNewScope(e.target.value as 'diary' | 'article')}>
                <option value="diary">日记</option>
                <option value="article">文章</option>
              </select>
              <textarea
                className="lib-edit"
                rows={5}
                spellCheck={false}
                placeholder={'## 今天\n\n- {{date:YYYY 年 MM 月 DD 日}} {{weekday}}\n- 接着上一篇：{{last_entry}}'}
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
              />
              <div className="lib-new-foot">
                <span className="lib-vars mono">
                  认得：{'{{date}} {{date:…}} {{time}} {{weekday}} {{mood}} {{topic}} {{last_entry}}'}
                </span>
                <button className="chip" disabled={!newName.trim() || !newBody.trim()} onClick={() => void addTemplate()}>
                  存为模板
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
