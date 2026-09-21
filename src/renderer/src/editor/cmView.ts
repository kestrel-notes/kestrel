/** 源码模式那个 CodeMirror 实例的句柄。
 *
 *  为什么要放模块级：大纲跳转与「当前标题」都由 `Editor.tsx` 统一处理，
 *  而它只拿得到 DOM。所见即所得里 DOM 就是全部内容（ProseMirror 不做虚拟化），
 *  照 DOM 量没问题；**源码模式不行——CM6 是虚拟化的，DOM 里只有视口附近那几十行**，
 *  按 DOM 数标题会数错、按 DOM 滚远处标题会滚不动。
 *
 *  所以源码模式改走 CM 自己的度量：文档坐标 → 屏幕坐标用 `view.documentTop`，
 *  滚动用 `EditorView.scrollIntoView`。这个模块就是两边握手的唯一接口。 */

import type { EditorView } from '@codemirror/view'

let view: EditorView | null = null

export function setCmView(v: EditorView | null): void {
  view = v
}

export function getCmView(): EditorView | null {
  return view
}