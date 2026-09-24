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

/** 认领与交还都带着「谁在交」。
 *  期-09a 之前这里只有一颗实例，卸载时无条件清成 null 是对的；现在一屏之后挂着好几棵
 *  （每个标签一棵，见 `Editor.tsx` 的 `.tab-pane`），交还的那棵可能已经不是当前这一棵了——
 *  无条件清会把别人刚认领的句柄抹掉，命令面板那几处 `getRichEditor()` 就会突然变灰。 */
export function setRichView(v: EditorView | null): void {
  view = v
}

export function getRichView(): EditorView | null {
  return view
}

export function releaseRichView(owner: EditorView): void {
  if (view === owner) view = null
}

/** 表格增删那几条命令要的是 Editor 实例（`editor.chain().focus().addRowAfter().run()`
 *  与 `editor.isActive('table')` 都挂在它身上，view 上没有）。与 view 句柄并存：
 *  view 给搜索定位用，editor 给块级操作用。
 *  语义仍然是**只有当前看得见那一棵**——9a 是单栏，所以「当前」只有一个。 */
export function setRichEditor(e: TiptapEditor | null): void {
  editor = e
}

export function getRichEditor(): TiptapEditor | null {
  return editor
}

export function releaseRichEditor(owner: TiptapEditor): void {
  if (editor === owner) editor = null
}
