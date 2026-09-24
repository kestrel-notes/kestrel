/** 反复提到（期-11b §四）。
 *
 *  右栏这一块说的是：这一篇提到的某个目标，还在别的哪些**月份**被提过，而且提到它的那几篇
 *  彼此一条链都没有。判据写在 `main/db/repeats.ts`，界面上把那两个数（跨几个月、彼此没连）
 *  原样写出来——这一档误报的代价是"用户学会了忽略它"，所以得让人一眼能自己判（决策 96）。
 *
 *  为什么整块可以不渲染而不是显示"没有"：右栏已经有六块东西，一块常年说"这里没东西"
 *  比不出现更糟（与 `Chronicle` 同一条规矩）。
 *
 *  「整理成一篇」只摊材料（决策 94）：新建一篇空标题的文章，正文里是那 N 条双链，
 *  然后交给编辑器。**不合并、不代写、不删原来的篇**——升格那颗按钮本来就是"原文一字不动"。 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { RailBlock } from '@/components/RailBlock'
import type { Repeat } from '../../../shared/types'

/** 一簇里摊出来的篇数。再多折起来：右栏不是清单页 */
const SHOW = 6

/** 那一天的日记用日期当链接目标（`links.ts` 那条解析顺序里日期是第一层，认得最准）；
 *  文章用标题。日记的 title 常常就是那个日期或者空，拿它去连会连不到。 */
function 链(r: Repeat['篇'][number]): string {
  return r.kind === 'diary' ? `[[${r.entryDate}]]` : `[[${r.title ?? r.entryDate}]]`
}

export function Repeats(): JSX.Element | null {
  const entry = useStore((s) => s.entry)
  const savedAt = useStore((s) => s.savedAt)
  const 全局 = useStore((s) => s.repeatsGlobal)
  const showRepeats = useStore((s) => s.showRepeats)
  const openEntry = useStore((s) => s.openEntry)
  const [簇, set簇] = useState<Repeat[]>([])
  const [还有, set还有] = useState(0)
  const [忙, set忙] = useState<string | null>(null)
  const [话, set话] = useState<string | null>(null)

  useEffect(() => {
    // 全库那一档不读 entry：清单本身与"当前是哪一篇"无关（那一档里每行自带「打开」）
    if (!全局 && !entry) {
      set簇([])
      return
    }
    let live = true
    const 取 = 全局 ? window.kestrel.repeats.all() : window.kestrel.repeats.for(entry!.id)
    void 取.then((r) => {
      if (!live) return
      set簇(r.簇)
      set还有(r.还有)
    }).catch(() => live && set簇([]))
    return () => {
      live = false
    }
  }, [entry?.id, savedAt, 全局])

  // 「整理成一篇」之后这一篇哪一簇都不掺了（新建的那篇是那些链接的**源**，不是簇里的料），
  // 但那句"给你摊开了、标题还没写"得留在屏幕上——不然点下去之后整块消失，像什么都没发生
  if (簇.length === 0 && !话) return null

  async function 整理(r: Repeat): Promise<void> {
    set忙(r.key)
    set话(null)
    try {
      const 料 = [...new Set(r.篇.map(链))]
      const 正文 = ['材料（这几篇彼此没有链，说的像是同一件事）：', '', ...料.map((x) => `- ${x}`), ''].join('\n')
      const d = new Date()
      const 今天 = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const e = await window.kestrel.entries.create({ kind: 'article', entryDate: 今天, title: '', content: 正文 })
      await openEntry(e.id)
      set话(`新开了一篇空文章，里面列了那 ${r.篇数} 条——标题与内容都还没写`)
    } catch (err) {
      set话(err instanceof Error ? err.message : String(err))
    } finally {
      set忙(null)
    }
  }

  return (
    <RailBlock title={全局 ? '思想重复度 · 全库' : '反复提到'} count={簇.length}>
      <div className="ch-sub">
        <span>
          {全局
            ? '同一个目标被这些篇在互不相干的月份各自提到，而这些篇彼此一条链都没有'
            : '这一篇提到的目标里，有这些还在别的月份被提过'}
        </span>
        <button className="rp-switch" onClick={() => showRepeats(!全局)}>
          {全局 ? '只看这一篇' : '看全库'}
        </button>
      </div>
      {簇.slice(0, 全局 ? 50 : 3).map((r) => (
        <div className="rp-item" key={r.key}>
          <div className="rp-head">
            <span className="rp-target" title={r.目标}>
              {r.目标}
            </span>
            <span className="rp-meta">
              跨 {r.跨月} 个月 · {r.篇数} 篇彼此没连{r.存在 ? '' : ' · 至今没有这一篇'}
            </span>
          </div>
          <ul className="rp-list">
            {r.篇.slice(-SHOW).map((p) => (
              <li key={p.id}>
                <button className="rp-open" onClick={() => void openEntry(p.id)}>
                  <span className="rp-date">{p.entryDate}</span>
                  <span className="rp-title">{p.kind === 'diary' ? '日记' : (p.title ?? '未命名')}</span>
                </button>
              </li>
            ))}
            {r.篇数 > SHOW && <li className="rp-more">…另有 {r.篇数 - SHOW} 篇</li>}
          </ul>
          <button className="rp-do" disabled={忙 === r.key} onClick={() => void 整理(r)}>
            整理成一篇
          </button>
        </div>
      ))}
      {!全局 && 簇.length > 3 && (
        <div className="rp-more">这一篇还掺在另外 {簇.length - 3} 簇里 · 上面「看全库」一起看</div>
      )}
      {还有 > 0 && <div className="rp-more">另有 {还有} 簇没列出来</div>}
      {话 && <div className="set-note">{话}</div>}
    </RailBlock>
  )
}
