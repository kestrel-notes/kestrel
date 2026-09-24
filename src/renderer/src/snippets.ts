/** 把主进程那份片段清单变成 `document.head` 里那几颗 `<style data-snippet>`（期-09b §五 ①）。
 *
 *  为什么是「全拆全建」而不是 diff：片段数量是个位数，diff 省下的那一次重算不值钱，
 *  而「界面上的样式表集合与清单严格相等」这一条保证值钱——它破了不会有报错，
 *  只会留下一颗没人知道从哪来的样式表。M3 实测 5000 条规则全链路 5.5 ms，付得起。
 *
 *  顺序 = 文件名升序（主进程那侧已经排好）。这条承重：平局由 `<style>` 的先后决定（M1 实测），
 *  所以它必须与「谁先落盘」无关。
 *
 *  为什么是内联 `<style>` 而不是 `<link>`：built 版 CSP 的 `style-src` 里没列 `kestrel-asset:`，
 *  `<link>` 那条路 dev 过得去、打包后静默失灵（§〇 M2）。`'unsafe-inline'` 是 `editor/inert.ts`
 *  头上明写的既有取舍，这条路不新增任何许可面。 */

import type { Snippet } from '../../shared/types'

export function applySnippets(list: Snippet[], paused = false): void {
  document.head.querySelectorAll('style[data-snippet]').forEach((el) => el.remove())
  if (paused) return
  for (const s of list) {
    // css 为 null 有三种可能：关着、太大、读不了。三种都不该进界面，且原因由设置页那一格说
    if (!s.on || s.css === null) continue
    const el = document.createElement('style')
    el.dataset.snippet = s.name
    el.textContent = s.css
    document.head.appendChild(el)
  }
}

/** 界面上此刻挂着哪几份。验收第 4 项要用它确认「删掉的那一份没有留下一颗空的 style」 */
export function appliedSnippets(): string[] {
  return [...document.head.querySelectorAll('style[data-snippet]')].map(
    (el) => (el as HTMLElement).dataset.snippet ?? ''
  )
}
