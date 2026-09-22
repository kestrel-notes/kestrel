import type { JSX } from 'react'

/** 界面上那枚红隼标记：圆角渐变底 + 奶油剪影，与 resources/icon.svg 同一份图形、
 *  同一套配色，所以任务栏上那枚和应用里这枚是同一个东西。
 *  带背景是因为奶油色在云雾白的玻璃标题栏上几乎看不见——底色必须对比得起来。
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
      <g fill="var(--brand-cream)">
        <path d="M28 22 Q19 12 10 5 Q13 20 23 31 Z" />
        <path d="M36 22 Q45 12 54 5 Q51 20 41 31 Z" />
        <path d="M32 12 C36.5 12 37.5 16.5 37 20 C37 28 34 36 32 40 C30 36 27 28 27 20 C26.5 16.5 27.5 12 32 12 Z" />
        <path d="M29 39 L25 57 Q32 59 39 57 L35 39 Z" />
      </g>
      <g fill="#7a2411">
        <path d="M27 15 A5 3.2 0 0 1 37 15 Z" />
        <path d="M32 18.4 L31 21 L33 21 Z" />
        <rect x="28.2" y="17.5" width="1.1" height="4" rx="0.55" />
        <rect x="34.7" y="17.5" width="1.1" height="4" rx="0.55" />
      </g>
    </svg>
  )
}
