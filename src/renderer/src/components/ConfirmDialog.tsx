/** 确认弹层：所有「先问一句再动手」的公共形状。
 *
 *  替掉两处原生 `window.confirm`。原生那弹框有两层毛病：一是它跟设计系统无关，
 *  二是它把渲染进程冻在原地——一句话丢进去等结果，期间什么都发生不了。
 *  换成界面内的弹层之后它就是个普通的 Promise，`askConfirm` 等用户答完才 resolve。
 *
 *  进不来第二张：`askConfirm` 在弹层已经开着时直接答 `false`，
 *  而快捷键那条路也在 `App.tsx` 里拦住了（弹层开着时不派发命令），
 *  否则「删掉这一条」会删到被 Ctrl+O 换掉的那一篇。 */

import type { JSX, KeyboardEvent } from 'react'
import { useEffect, useRef } from 'react'
import { useStore } from '@/store'

export function ConfirmDialog(): JSX.Element | null {
  const req = useStore((s) => s.confirm)
  const answer = useStore((s) => s.answerConfirm)
  const card = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  /** 弹层打开前那一刻的焦点，关掉之后还回原地 */
  const back = useRef<HTMLElement | null>(null)

  // 依赖只写 req：每次点名一个新问题都重新接一次焦点
  useEffect(() => {
    if (req === null) return
    back.current = document.activeElement as HTMLElement | null
    // 初始焦点给「取消」。这两处问的都是删东西，Enter 顺手删掉不是该有的默认——
    // 想删就明明白白点到那颗按钮上去（Tab 一下也到）。
    cancelRef.current?.focus()
    return () => {
      back.current?.focus()
      back.current = null
    }
  }, [req])

  if (req === null) return null

  /** 焦点圈在卡片里：两颗按钮之间转，不许跑到背后那些列表里去 */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'Tab') return
    const nodes = [...(card.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    if (nodes.length === 0) return
    e.preventDefault()
    const at = nodes.indexOf(document.activeElement as HTMLButtonElement)
    const next = (at + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length
    nodes[next].focus()
  }

  return (
    <div className="confirm-scrim" onClick={() => answer(false)}>
      <div
        ref={card}
        className="confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-label={req.title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h3>{req.title}</h3>
        <p>{req.body}</p>
        <div className="confirm-actions">
          <button ref={cancelRef} className="chip" onClick={() => answer(false)}>
            {req.cancelLabel ?? '取消'}
          </button>
          <button className="chip danger" onClick={() => answer(true)}>
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
