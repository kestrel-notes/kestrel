/** 右栏的一块：标题 + 可选折叠 + 内容。
 *
 *  设计稿（期-02-设计 §3.2）要求在第六块进来之前先把它抽出来：折叠那套
 *  `role=button` + `tabIndex` + Enter/Space 的键盘处理手抄到第六份就会各自漂移，
 *  期 1 那条「焦点被浮层抢」的 bug 就是这么长出来的。 */

import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'

export function RailBlock({
  title,
  count,
  foldable,
  defaultOpen = true,
  resetKey,
  children,
}: {
  title: ReactNode
  /** 标题右边那个计数。0 或省略都不画——「0 条」不是信息 */
  count?: number
  /** 不给就不能折叠，标题就是一行普通 `h5` */
  foldable?: boolean
  defaultOpen?: boolean
  /** 变了就把展开状态收回 `defaultOpen`。历史版本用它：换文档时收起，
   *  免得用户眼前跳出一张属于另一篇的列表 */
  resetKey?: string | number
  children?: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => setOpen(defaultOpen), [resetKey, defaultOpen])

  const badge = count ? <em className="net-count">{count}</em> : null

  return (
    <div className="rail-block">
      {foldable ? (
        <h5
          className="rail-fold"
          onClick={() => setOpen((v) => !v)}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setOpen((v) => !v)
            }
          }}
        >
          <i className={`caret ${open ? 'on' : ''}`} aria-hidden="true">
            ▸
          </i>
          {title}
          {badge}
        </h5>
      ) : (
        <h5>
          {title}
          {badge}
        </h5>
      )}
      {(!foldable || open) && children}
    </div>
  )
}
