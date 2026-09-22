/** 所见即所得那个 ProseMirror 实例的句柄（与 `cmView.ts` 对称）。
 *
 *  为什么需要它：`Editor.tsx` 只拿得到 DOM，而**改 `window.getSelection()` 不算数**——
 *  ProseMirror 把自己那份 selection 同步回 DOM，直接写进去的 Range 会被收回成一个点。
 *  所以选中一串字必须走 PM 自己的事务：DOM 侧量出位置，`posAtDOM` 换成文档坐标，
 *  再 dispatch 一个 TextSelection。
 *
 *  量位置仍然在 DOM 上做（PM 不虚拟化，整篇都在 DOM 里），这与 `cmView.ts` 的分工一致。 */

import type { EditorView } from '@tiptap/pm/view'

let view: EditorView | null = null

export function setRichView(v: EditorView | null): void {
  view = v
}

export function getRichView(): EditorView | null {
  return view
}
