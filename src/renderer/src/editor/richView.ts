/** 所见即所得那个 ProseMirror 实例的句柄（与 `cmView.ts` 对称）。
 *
 *  为什么需要它：`Editor.tsx` 只拿得到 DOM，而**改 `window.getSelection()` 不算数**——
 *  ProseMirror 把自己那份 selection 同步回 DOM，直接写进去的 Range 会被收回成一个点。
 *  所以选中一串字必须走 PM 自己的事务：DOM 侧量出位置，`posAtDOM` 换成文档坐标，
 *  再 dispatch 一个 TextSelection。
 *
 *  量位置仍然在 DOM 上做（PM 不虚拟化，整篇都在 DOM 里），这与 `cmView.ts` 的分工一致。 */

import type { EditorView } from '@tiptap/pm/view'
import type { Editor as TiptapEditor } from '@tiptap/core'

let view: EditorView | null = null
let editor: TiptapEditor | null = null

export function setRichView(v: EditorView | null): void {
  view = v
}

export function getRichView(): EditorView | null {
  return view
}

/** 表格增删那几条命令要的是 Editor 实例（`editor.chain().focus().addRowAfter().run()`
 *  与 `editor.isActive('table')` 都挂在它身上，view 上没有）。与 view 句柄并存：
 *  view 给搜索定位用，editor 给块级操作用，两个都在 RichEditor 卸载时清成 null。 */
export function setRichEditor(e: TiptapEditor | null): void {
  editor = e
}

export function getRichEditor(): TiptapEditor | null {
  return editor
}
