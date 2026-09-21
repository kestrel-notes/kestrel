import type { ThemeName } from '../../shared/types'

/** 主题的「文案与色板」。
 *  配色本身不在这里——真值在 styles/tokens.css 的 [data-theme] 块里，
 *  外观面板的缩略图直接挂 data-theme 复用真变量，所以不会出现预览与实际不一致。 */

export interface ThemeMeta {
  name: ThemeName
  label: string
  desc: string
  /** 该主题下可一键切换的强调色预设，第一个是主题默认 */
  accents: string[]
}

export const THEMES: ThemeMeta[] = [
  {
    name: 'cloud',
    label: '云雾白',
    desc: '亮色默认',
    accents: ['#4f6ef7', '#7c5cf0', '#0ea5a5', '#e0526e'],
  },
  {
    name: 'paper',
    label: '纸感暖',
    desc: '亮色 · 长阅读',
    accents: ['#c2703f', '#8a6a3b', '#5c7a45', '#a34c3c'],
  },
  {
    name: 'midnight',
    label: '极夜黑',
    desc: '暗色默认',
    accents: ['#7c9cff', '#a78bfa', '#38bdf8', '#34d399'],
  },
  {
    name: 'terminal',
    label: '终端青',
    desc: '暗色 · 极客',
    accents: ['#2ee6a8', '#7dd3fc', '#facc15', '#fb7185'],
  },
]

export const DARK_THEMES: ThemeName[] = ['midnight', 'terminal']

export function themeMeta(name: ThemeName): ThemeMeta {
  return THEMES.find((t) => t.name === name) ?? THEMES[0]
}

/** 跟随系统时在「亮色默认 ↔ 暗色默认」之间切，用户手选的具体主题作为亮色档 */
export function resolveTheme(
  theme: ThemeName,
  followSystem: boolean,
  prefersDark: boolean
): ThemeName {
  if (!followSystem) return theme
  if (prefersDark) return DARK_THEMES.includes(theme) ? theme : 'midnight'
  return DARK_THEMES.includes(theme) ? 'cloud' : theme
}