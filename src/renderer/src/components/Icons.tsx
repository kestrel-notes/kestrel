import type { JSX } from 'react'

/** 图标统一走 stroke，颜色继承 currentColor，尺寸由 .ic 控制 */
export function IconTheme(): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18" />
      <circle cx="9" cy="9.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="15" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconFocus(): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
    </svg>
  )
}

export function IconTrash(): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6" />
    </svg>
  )
}

/** 编辑器模式切换用（源码模式 ⇄ 所见即所得），形状取自原型的 modeBtn */
export function IconCode(): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
    </svg>
  )
}

export function IconPlus(): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function IconMin(): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 12h12" />
    </svg>
  )
}

export function IconMax(): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  )
}

export function IconRestore(): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="8" width="11" height="11" rx="1.5" />
      <path d="M9 5h9a1 1 0 0 1 1 1v9" />
    </svg>
  )
}

export function IconClose(): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

/** 升格：一条线往上走。日记 → 文章是"往上归一层"，不用箭头以外的隐喻 */
export function IconPromote(): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  )
}

/** 回收站：桶身 + 盖子 + 提手。与 IconTrash（软删除那个按钮）区分开：
 *  那个是动作，这个是入口，所以多一条提手、少两条桶身竖线 */
export function IconBin(): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7h14M9 7V5h6v2M6.5 7l1 12h9l1-12M10 11v5M14 11v5" />
    </svg>
  )
}

/** 收藏那颗星。`filled` 时把星涂实——标题栏那一格只按「有没有收藏」显隐，
 *  而编辑器与 sheet 里要知道「这一条收藏了没有」，那是个二态，只能靠形状区分。
 *  签名收一个 props 对象（与这个文件里别的图标不同）：它是唯一需要参数的图标。 */
export function IconStar({ filled = false }: { filled?: boolean }): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.6l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  )
}

/** 改名用的一支笔。侧栏标签树上每行一个，所以尺寸靠 .tag-act 收，不在这里改 viewBox */
export function IconRename(): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4l11-11a2.1 2.1 0 0 0-3-3L5 17v3zM14 6l4 4" />
    </svg>
  )
}

/** 两滑杆 = 「这些行是可以调的」。主题那一格的入口（§3.5），比齿轮少一层「设置」的联想 */
export function IconManage(): JSX.Element {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 8h9M4 16h4M18 8h2M13 16h7" />
      <circle cx="15.5" cy="8" r="2.2" />
      <circle cx="10.5" cy="16" r="2.2" />
    </svg>
  )
}