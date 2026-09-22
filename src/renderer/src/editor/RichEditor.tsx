/** 所见即所得那一半（Tiptap），兼作阅读视图。
 *
 *  和 store 是带守卫的双向同步：编辑器自己吐出去的 Markdown 不再灌回来。
 *  不加这道守卫的话，每敲一个字都会 setContent → 回灌 → 整篇重建文档 → 光标跳到文首。
 *
 *  `readOnly` 挂同一棵 ProseMirror，只是 `editable: false`——所以阅读视图不新起
 *  一条渲染管线（§2.3 结论；红线：renderer 不许有 innerHTML sink）。 */

import { EditorContent, useEditor } from '@tiptap/react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { useStore } from '@/store'
import { setRichView, setRichEditor } from '@/editor/richView'
import { buildExtensions, resolveLink, type LinkBridge } from '@/editor/markdown'

export function RichEditor({ readOnly = false }: { readOnly?: boolean }): JSX.Element {
  const content = useStore((s) => s.content)
  const entryDate = useStore((s) => s.entry?.entryDate ?? '')
  const setContent = useStore((s) => s.setContent)

  const bridge = useMemo<LinkBridge>(
    () => ({
      resolve: (raw) => resolveLink(useStore.getState().outgoing, raw, entryDate),
      open: (nodeKey, label) => {
        const s = useStore.getState()
        if (nodeKey) void s.openNode(nodeKey)
        // 悬空只提示不跳（原型的规矩）
        else s.notify(`「${label}」还没有创建`)
      },
      subscribe: (cb) => useStore.subscribe(cb),
      // 正文里的 `#标签`：Ctrl+点击切到标签视图并选中它（§6）。平点留给光标
      openTag: (name) => void useStore.getState().selectTagName(name),
    }),
    [entryDate]
  )

  const extensions = useMemo(() => buildExtensions(bridge), [bridge])

  /** 编辑器自己吐出去的那一版。和 store 里的相同 = 这次变化是自己造的，别回灌 */
  const emitted = useRef(content)

  const editor = useEditor(
    {
      extensions,
      content,
      contentType: 'markdown',
      editable: !readOnly,
      editorProps: {
        attributes: {
          class: readOnly ? 'md-prose md-reading' : 'md-prose',
          spellcheck: 'false',
        },
      },
      onUpdate: ({ editor, transaction }) => {
        if (readOnly) return
        // 光标移动也会走到这里。不拦的话，点一下正文就会整篇重新序列化（末尾会多一个
        // 空行）、标脏、落库——用户什么都没改，文件却变了
        if (!transaction.docChanged) return
        // 每次按键都整篇序列化。文档是几 KB 量级，换来的是「出链染色跟着正文走」
        // 而不必再养一套「什么时候该重算」的状态机
        const md = editor.getMarkdown()
        emitted.current = md
        setContent(md)
      },
    },
    // 只建一次。正文、条目日期、出链都从 store 现取；换文档时整个组件按 key 重建
    []
  )

  // 挂载后编辑性变了要跟着改（同 key 的情况下 readOnly 只有从 rich 切到 reading 会翻转，
  // 但那条路径会走 set-editorMode → Editor 层重新渲染 RichEditor；这里 editor 实例保住，
  // 只 setEditable 一次——省一次整篇重建）
  useEffect(() => {
    if (!editor) return
    if (editor.isEditable === !readOnly) return
    editor.setEditable(!readOnly)
  }, [editor, readOnly])

  useEffect(() => {
    if (!editor || content === emitted.current) return
    // 外部改的正文（切模式回写的规范化文本）才灌回去
    emitted.current = content
    editor.commands.setContent(content, { contentType: 'markdown', emitUpdate: false })
  }, [editor, content])

  // 交出去的句柄只有一份：搜索命中要在 PM 自己的坐标系里选字（见 richView.ts）；
  // editor 实例给表格增删那几条命令用（见 commands.ts 的 table.* 那组）
  useEffect(() => {
    if (!editor) return
    setRichView(editor.view)
    setRichEditor(editor)
    return () => {
      setRichView(null)
      setRichEditor(null)
    }
  }, [editor])

  // 装好就把光标放到文末：这是"接着写"的场景，落在文首的话第一句话会插到最前面。
  // 阅读模式不占光标，免得把 window 焦点从别处抢走。
  useEffect(() => {
    if (readOnly) return
    editor?.commands.focus('end')
  }, [editor, readOnly])

  return (
    <div className="md-body">
      <EditorContent editor={editor} />
    </div>
  )
}