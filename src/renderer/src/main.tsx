import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
/* Maple Mono 是自带进包的（`@fontsource` 只发布 latin 子集，离线应用不能指望 CDN）。
   只引界面上真用得到的字重：400/500/600/700 + 400 斜体（`.cm-em`、`<em>` 要用）。
   样式表里 650 会命中 700、550 会命中 500——CSS 的字体匹配规则本来就往最近的那个走。 */
import '@fontsource/maple-mono/400.css'
import '@fontsource/maple-mono/500.css'
import '@fontsource/maple-mono/600.css'
import '@fontsource/maple-mono/700.css'
import '@fontsource/maple-mono/400-italic.css'
import '@/styles/tokens.css'
import '@/styles/app.css'

const host = document.getElementById('root')
if (!host) throw new Error('#root 不存在')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>
)