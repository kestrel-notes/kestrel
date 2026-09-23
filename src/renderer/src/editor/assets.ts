/** 附件的拖入 / 粘贴导入（期-04 §4.8、§5.2）。只在编辑实例挂，不进闸门那套 manager。
 *
 *  与折叠插件同一条纪律：导入只在**可编辑**那一档生效，阅读模式（`editable:false`）沉默。
 *  字节交给主进程 `attachments.import` 落盘（内容寻址），回来拼一个
 *  `kestrel-asset://<name>` 塞进 Image 节点——走的是既有的图片往返，闸门一个字不碰。 */

import { Extension, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { useStore } from '@/store'

const OK_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'])

function isImageFile(f: File): boolean {
  if (f.type.startsWith('image/')) return true
  const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
  return OK_EXT.has(ext)
}

async function importAndInsert(
  editor: Editor,
  files: File[],
  rawPos: number | null
): Promise<void> {
  const notify = (m: string): void => useStore.getState().notify(m)
  const image = editor.schema.nodes.image
  if (!image) return notify('图片扩展没接上')
  let pos = rawPos ?? editor.state.selection.head
  for (const f of files) {
    try {
      const buf = new Uint8Array(await f.arrayBuffer())
      const name = await window.kestrel.attachments.import(f.name, buf)
      const src = `kestrel-asset://${name}`
      // 落在顶层块「之后」而不是文本光标里：图片是块级节点，直接塞进光标会把那一整段
      // （比如标题）劈成两半。depth 0 时落点本来就是块边界，原样用。
      const clamped = Math.min(pos, editor.state.doc.content.size)
      const $pos = editor.state.doc.resolve(clamped)
      const at = $pos.depth >= 1 ? $pos.after(1) : clamped
      const node = image.create({ src })
      editor.view.dispatch(editor.state.tr.insert(at, node).scrollIntoView())
      pos = at + node.nodeSize // 连拖多张时错开，别叠在同一处
    } catch (err) {
      notify(err instanceof Error ? err.message : '附件导入失败')
    }
  }
}

export const Attachments = Extension.create({
  name: 'attachments',

  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          handlePaste(_view, event) {
            if (!editor.isEditable) return false
            const files = [...(event.clipboardData?.files ?? [])].filter(isImageFile)
            if (!files.length) return false
            event.preventDefault()
            void importAndInsert(editor, files, null)
            return true
          },
          handleDrop(view, event) {
            if (!editor.isEditable) return false
            const dt = (event as DragEvent).dataTransfer
            const files = [...(dt?.files ?? [])].filter(isImageFile)
            if (!files.length) return false
            event.preventDefault()
            event.stopPropagation()
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
            void importAndInsert(editor, files, at?.pos ?? null)
            return true
          },
        },
      }),
    ]
  },
})
