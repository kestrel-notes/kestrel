/** 编辑器把焦点交还给 DOM 的两个小工具。
 *
 *  浮层关掉之后焦点要回到正文，否则下一次打字打到空处（设计文档 §3.3）。
 *  两种编辑器各有一个可聚焦的根：Tiptap 的 `.md-prose`（contenteditable）、
 *  CodeMirror 的 `.cm-content`（tabindex=0），哪个在文档里就给哪个。 */

export function editorRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.md-prose, .cm-content')
}

export function focusEditor(): void {
  editorRoot()?.focus()
}