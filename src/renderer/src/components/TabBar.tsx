/** 标签条（期-09a §三、§四）。
 *
 *  只有一个标签时整条不画：新东西不该在用户什么都没做的时候先占 30px。
 *
 *  拖序是自己用 pointer 事件写的，没引库（§九 风险 4）。做法是「拖到谁身上就跟谁换」：
 *  指针越过相邻那一格的一半就把两格对调，指针本身不跟着动——
 *  于是看到的是一排在让位，而不是一个幽灵在飞。这条路比 HTML5 那套 draggable 短，
 *  也不会和窗口拖动抢事件。 */

import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useRef, useState } from 'react'
import { useStore } from '@/store'

export function TabBar(): JSX.Element | null {
  const tabs = useStore((s) => s.tabs)
  const activeTab = useStore((s) => s.activeTab)
  const labels = useStore((s) => s.tabLabels)
  const activateTab = useStore((s) => s.activateTab)
  const closeTab = useStore((s) => s.closeTab)
  const togglePin = useStore((s) => s.togglePin)

  const [拖的, set拖的] = useState<number | null>(null)
  const 起点 = useRef<{ x: number; id: number } | null>(null)

  if (tabs.length <= 1) return null

  const 按下 = (e: ReactPointerEvent, id: number): void => {
    // 中键：只挡掉那个默认的自动滚动十字准心，关那一格交给 onAuxClick（§三）
    if (e.button === 1) {
      e.preventDefault()
      return
    }
    if (e.button !== 0) return
    起点.current = { x: e.clientX, id }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const 移动 = (e: ReactPointerEvent, 目标id: number): void => {
    const 起 = 起点.current
    if (!起 || 起.id === 目标id) return
    // 3px 以内当点击，不算拖：不然在标签上按一下就被当成挪位
    if (Math.abs(e.clientX - 起.x) < 3) return
    if (拖的 !== 起.id) set拖的(起.id)
    const s = useStore.getState()
    const 我 = s.tabs.findIndex((t) => t.entryId === 起.id)
    const 它 = s.tabs.findIndex((t) => t.entryId === 目标id)
    if (我 < 0 || 它 < 0) return
    // 一格一格地换：moveTab 自己守着「不许跨过固定那道界」（§三）
    void s.moveTab(我, 它 > 我 ? 1 : -1)
  }

  const 抬起 = (e: ReactPointerEvent): void => {
    起点.current = null
    set拖的(null)
    const el = e.currentTarget as HTMLElement
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
  }

  return (
    <div className="tab-bar" role="tablist" aria-label="开着的笔记">
      {tabs.map((t, i) => {
        const 名 = labels[t.entryId] ?? '（读名字中）'
        return (
          <div
            key={t.entryId}
            className={`tab ${i === activeTab ? 'active' : ''} ${拖的 === t.entryId ? 'dragging' : ''}`}
            role="tab"
            aria-selected={i === activeTab}
            title={名}
            onPointerDown={(e) => 按下(e, t.entryId)}
            onPointerMove={(e) => 移动(e, t.entryId)}
            onPointerUp={抬起}
            onPointerCancel={抬起}
            onAuxClick={(e) => {
              // 中键点在别的标签上 = 关掉它（浏览器习惯）
              if (e.button === 1) void closeTab(i)
            }}
            onDoubleClick={() => togglePin(i)}
            onClick={() => void activateTab(i)}
          >
            {t.pinned && <span className="pin" aria-hidden>◎</span>}
            <span className="tab-name">{名}</span>
            <button
              className="close"
              aria-label={`关掉「${名}」`}
              onClick={(e) => {
                e.stopPropagation()
                void closeTab(i)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
