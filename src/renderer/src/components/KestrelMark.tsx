import type { JSX } from 'react'

/** 界面上那枚红隼标记：圆角渐变底 + 奶油剪影，与 resources/icon.svg 同一份图形、
 *  同一套配色，所以任务栏上那枚和应用里这枚是同一个东西。
 *  带背景是因为奶油色在白桦的玻璃标题栏上几乎看不见——底色必须对比得起来。
 *  应用图标（窗口/安装包）走 resources/icon.svg 栅格化出的 .ico/.png，
 *  两处的图形比例必须一致；改这里记得同步改 icon.svg。 */
export function KestrelMark({ size = 18 }: { size?: number }): JSX.Element {
  const id = `kestrel-mark-grad-${size}`
  return (
    <svg
      className="kestrel-mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Kestrel"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand-deep)" />
          <stop offset="1" stopColor="var(--brand-light)" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill={`url(#${id})`} />
      {/* 俯冲的红隼：头喙压在左下、双翼掠向右上，一笔成型的极简箭头鸟。
          与 resources/icon.svg 同一份路径，改这里记得同步改那边。 */}
      <path
        fill="var(--brand-cream)"
        d="M12 52 C18 40 24 26 30 14 C31 26 30 34 28 40 C34 36 44 32 54 32 C44 40 30 50 12 52 Z"
      />
    </svg>
  )
}
