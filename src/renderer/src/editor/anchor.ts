/** `[[x#小节]]` / `[[x^块id]]` 的落点（期-05f 乙）。
 *
 *  两条路各走各的度量，与大纲跳转同一套分工：
 *   - 富文本那一棵：ProseMirror 不虚拟化，整篇都在 DOM 里，直接在 DOM 上找那个元素。
 *     主编辑器与**幻灯片**共用这一份——幻灯片滚的是它自己那一页，不是背后那台编辑器。
 *   - 源码那一档：CM6 是虚拟化的，DOM 里只有视口附近那几十行，只能拿原文算行号，
 *     再交给 CM 自己的 `scrollIntoView`（理由与 `Editor.tsx` 里那段"实测差 46px"一样）。
 *
 *  锚点比对走 `normalizeLinkKey`：与链接解析、别名那一路**同一条**规矩（去空白 + 小写），
 *  所以 `## 装 窑` 这一节写得带空格，`[[#装窑]]` 也认得它。 */

import { EditorView } from '@codemirror/view'
import { normalizeLinkKey } from '../../../shared/links'

const 标题们 = 'h1, h2, h3, h4, h5, h6'
const 块候选 = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th'

/** 标题那一行**人看见的字**。折叠插件在标题里插了一颗 `▾`（`folding.ts` 那个
 *  `fold-chev`），直接取 `textContent` 会得到 `▾装窑`，与 `[[#装窑]]` 对不上——
 *  第一跑判据 2c 红就红在这儿（提示说"没找到"，其实找得到，只是名字上多了一枚记号）。 */
function 标题文字(el: Element): string {
  const 克 = el.cloneNode(true) as HTMLElement
  克.querySelectorAll('.fold-chev').forEach((x) => x.remove())
  return 克.textContent ?? ''
}

/** 富文本：滚到标题文字对得上的那一节，或段尾写着 `^id` 的那一段。动了没有要说出来，
 *  调用方据此提示"这一篇里没找到" */
export function 滚到锚点(根: Element | null, 锚点: string | null, 块: string | null): boolean {
  if (!根) return false
  if (块) {
    const 尾 = `^${块}`
    const 中 = [...根.querySelectorAll(块候选)].find((el) => (el.textContent ?? '').trimEnd().endsWith(尾))
    if (中) 中.scrollIntoView({ block: 'start' })
    return !!中
  }
  if (!锚点) return false
  const 键 = normalizeLinkKey(锚点)
  const 中 = [...根.querySelectorAll(标题们)].find((el) => normalizeLinkKey(标题文字(el)) === 键)
  if (中) 中.scrollIntoView({ block: 'start' })
  return !!中
}

/** 源码档：在原文里算出那一行，交给 CM 自己滚。
 *  视图由调用方给——一屏底下挂着好几棵（期-09a），拿"最后挂载的那一棵"会滚错格子。 */
export function 滚到锚点源码(
  v: EditorView | null,
  内容: string,
  锚点: string | null,
  块: string | null
): boolean {
  if (!v) return false
  const 行 = (() => {
    const 们 = 内容.split('\n')
    if (块) {
      const 尾 = `^${块}`
      return 们.findIndex((l) => l.trimEnd().endsWith(尾))
    }
    if (!锚点) return -1
    const 键 = normalizeLinkKey(锚点)
    return 们.findIndex((l) => /^#{1,6}\s/.test(l) && normalizeLinkKey(l.replace(/^#{1,6}\s*/, '')) === 键)
  })()
  if (行 < 0 || 行 + 1 > v.state.doc.lines) return false
  v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.line(行 + 1).from, { y: 'start' }) })
  return true
}
