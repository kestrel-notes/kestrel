/** 出链（期-05a）。与「反向链接」成对：反链是"谁连着这一篇"，这一块的读法是
 *  「[[目标]]」写在这一篇的正文里，落到了哪儿。
 *
 *  为什么它排到反链前面：先说自己提到了什么，再说被谁提到——读的顺序就是这个顺序。
 *  为什么长得跟反链一模一样（同一套 `bl-*` 类）：这两块是一对，多一套视觉就会慢慢漂。
 *
 *  数据早就在场：`links.outgoing` + 那条 IPC + `store.outgoing`（每次换篇顺手取了一份，
 *  此前只喂给跨年同日那张卡与幻灯片的链接解析用）。这一档不动数据层。 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { RailBlock } from '@/components/RailBlock'
import type { OutgoingLink } from '../../../shared/types'

const DOT: Record<string, string> = {
  diary: 'tip-diary',
  article: 'tip-article',
  topic: 'tip-topic',
  dangling: 'tip-dangling',
}

const 种类: Record<string, string> = {
  diary: '日记',
  article: '文章',
  topic: '主题',
  dangling: '还没有这一篇',
}

/** `nodeKey` 是 `e:12` / `t:3`。日期链的目标也是某一篇记录（`keyFrom` 那一层把 'date'
 *  归到 entry 键上），所以这里只认两种前缀。悬空是 null，点了不跳。 */
function 篇号(key: string | null): number | null {
  if (!key) return null
  const [头, 尾] = key.split(':')
  return 头 === 'e' && Number.isFinite(Number(尾)) ? Number(尾) : null
}

export function Outgoing(): JSX.Element | null {
  const 出 = useStore((s) => s.outgoing)
  const topics = useStore((s) => s.topics)
  const openNode = useStore((s) => s.openNode)
  const [标签, set标签] = useState<Record<number, string>>({})

  useEffect(() => {
    const 缺 = 出
      .map((o) => 篇号(o.nodeKey))
      .filter((n): n is number => n !== null && !(n in 标签))
    if (缺.length === 0) return
    let live = true
    void window.kestrel.entries
      .labels(缺)
      .then((行) => {
        if (!live) return
        set标签((早) => {
          const 后 = { ...早 }
          for (const 一 of 行) 后[一.id] = 一.title ?? (一.kind === 'diary' ? 一.entryDate : '未命名文章')
          return 后
        })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [出])

  if (出.length === 0) return null

  const 名字 = (o: OutgoingLink): string => {
    if (o.targetType === 'topic') return topics.find((t) => `t:${t.id}` === o.nodeKey)?.name ?? o.key
    const 号 = 篇号(o.nodeKey)
    // 悬空没有名字可取（目标还不存在），落回正文里那个写法；名字还没取回来时也一样
    return (号 === null ? undefined : 标签[号]) ?? o.key
  }

  return (
    <RailBlock title="出链" count={出.length}>
      <div className="bl-list">
        {出.map((o) => {
          const 类 = o.targetType ?? 'dangling'
          const 名 = 名字(o)
          const 题 = 类 === 'dangling' ? `「${名}」还没有这一篇：去建一篇同名记录，这条就自己连上` : `跳到「${名}」`
          const 行 = (
            <>
              <span className="bl-top">
                <span className={`bl-dot ${DOT[类]}`} />
                <span className="bl-h">{名}</span>
                <span className={`bl-m k-${o.kind}`}>{种类[类]}</span>
              </span>
            </>
          )
          return o.nodeKey ? (
            <button key={`${o.nodeKey}-${o.key}`} type="button" className="bl" title={题} onClick={() => void openNode(o.nodeKey!)}>
              {行}
            </button>
          ) : (
            <div key={`d-${o.key}`} className="bl bl-dead" title={题}>
              {行}
            </div>
          )
        })}
      </div>
    </RailBlock>
  )
}
