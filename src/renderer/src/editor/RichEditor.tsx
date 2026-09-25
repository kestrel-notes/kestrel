/** 所见即所得那一半（Tiptap），兼作阅读视图。
 *
 *  和 store 是带守卫的双向同步：编辑器自己吐出去的 Markdown 不再灌回来。
 *  不加这道守卫的话，每敲一个字都会 setContent → 回灌 → 整篇重建文档 → 光标跳到文首。
 *
 *  `readOnly` 挂同一棵 ProseMirror，只是 `editable: false`——所以阅读视图不新起
 *  一条渲染管线（§2.3 结论；红线：renderer 不许有 innerHTML sink）。
 *
 *  期-09a 起**一个标签一棵，实例挂在看不见的那些身上也不重建**（设计稿 §五 ①）。
 *  于是这一半多了三个前提，全都围着「看不见的那一棵不该动」：
 *  · `content` 只在看得见时读 store，看不见时读自己挂载那一刻的那一份——
 *    否则切到乙-中会把甲-小那棵的文档整篇换掉；
 *  · 交给外面的句柄（`richView`）只有看得见那一棵，隐藏的不认领也不交还；
 *  · 看不见 = `readOnly` 一律成立，所以 `onUpdate` 那条 `if (readOnly) return` 顺手
 *    保证了「任意时刻最多一篇是脏的」——M5 量过的那条不变量在多实例下仍然成立。 */

import { EditorContent, useEditor } from '@tiptap/react'
import { isNodeSelection } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { useStore } from '@/store'
import { releaseRichEditor, releaseRichView, setRichView, setRichEditor } from '@/editor/richView'
import { buildExtensions, linkKey, resolveLink, type LinkBridge } from '@/editor/markdown'
import type { PreviewAsk } from '../../../shared/types'
import { SlashMenu, SlashPopup } from '@/editor/SlashMenu'
import { WikiComplete, WikiCompletePopup } from '@/editor/wikiComplete'
import { Folding } from '@/editor/folding'
import { FootnoteNumbers } from '@/editor/footnote'
import { Attachments } from '@/editor/assets'
import { QueryBlocks } from '@/editor/queryBlock'

export function RichEditor({
  entryId,
  visible,
  readOnly = false,
}: {
  entryId: number
  /** 这一棵此刻在不在屏幕上。`false` 涵盖两种情况：切到别的标签了、整屏在源码模式 */
  visible: boolean
  readOnly?: boolean
}): JSX.Element {
  const 冻结 = !visible || readOnly
  /** 只在「这一棵就是当前那一篇」时才跟着 store 走。
   *  选择器返回 null 就当没订阅——隐藏的那几棵不该跟着别人每次敲键重画一遍 */
  const 外部正文 = useStore((s) => (s.currentId === entryId ? s.content : null))
  const 外部日期 = useStore((s) => (s.currentId === entryId ? (s.entry?.entryDate ?? '') : null))
  const 挂载正文 = useRef('')
  const 挂载日期 = useRef('')
  if (!挂载正文.current && 外部正文 !== null) 挂载正文.current = 外部正文
  if (!挂载日期.current && 外部日期) 挂载日期.current = 外部日期
  const content = 外部正文 ?? 挂载正文.current
  const entryDate = 外部日期 ?? 挂载日期.current
  const setContent = useStore((s) => s.setContent)

  const bridge = useMemo<LinkBridge>(
    () => ({
      resolve: (raw) => resolveLink(useStore.getState().outgoing, raw, entryDate),
      open: (nodeKey, label, 落点) => {
        const s = useStore.getState()
        if (落点?.samePage) {
          // 指的是当前这一篇：不换文档，只在这篇里滚过去（期-05f 乙）
          if (s.entry) s.jumpToAnchor(s.entry.id, 落点)
          return
        }
        if (nodeKey) {
          void s.openNode(nodeKey)
          // 只认 `e:` 那一头：主题的 nodeKey 也是数字，拿它当 entryId 会撞上另一篇
          const id = nodeKey.startsWith('e:') ? Number(nodeKey.slice(2)) : NaN
          if (落点 && Number.isFinite(id)) s.jumpToAnchor(id, 落点)
        }
        // 悬空只提示不跳（原型的规矩）
        else s.notify(`「${label}」还没有创建`)
      },
      subscribe: (cb) => useStore.subscribe(cb),
      // 正文里的 `#标签`：Ctrl+点击切到标签视图并选中它（§6）。平点留给光标
      openTag: (name) => void useStore.getState().selectTagName(name),
      // 期-05d：编辑与阅读这两档给这根线。**幻灯片那份 bridge 不给**，于是那边
      // 连 mouseenter 都不会挂（判据 7 要的是结构保证，不是运行时开关）
      preview: (raw, 显示): PreviewAsk => {
        const hit = resolveLink(useStore.getState().outgoing, raw, entryDate)
        // 悬空的那一条 resolveLink 回 null，键还是要自己算：卡片上那个"被写了几处"按的就是它
        return { nodeKey: hit?.nodeKey ?? null, key: hit?.key ?? linkKey(raw, entryDate), 显示 }
      },
      // 期-05f 丙：`![[…]]` 那一截。**幻灯片那份 bridge 不给这根线**，于是那边连"取值 +
      // 开第二棵"这条代码路径都不存在（§18.5 第 3 条，与上面 preview 同一招）
      embed: (问) => window.kestrel.links.embed(问),
      /** 链上的第一颗就是我自己：`![[自己]]` 因此当场判成环，而不是原地递归。
       *  `e:` 这个前缀与 `outgoing` / `openNode` 用的是同一套键 */
      嵌链: [`e:${entryId}`],
    }),
    [entryDate, entryId]
  )

  // SlashMenu 只在编辑实例里挂；阅读实例即使复用了同一棵 PM，插件也会因 view.editable=false 而沉默。
  // Folding 两档都挂：折叠是「读」的本事。FootnoteNumbers 同理——序号是读出来的东西。
  // Attachments 靠 isEditable 守卫，阅读模式下不吞拖放/粘贴。
  // QueryBlocks 两档都挂：查询结果是**读**出来的，且它是纯装饰器（不进 schema、不进 md），
  // 挂进 buildExtensions() 反而会把这份名单污染成闸门的 schema（期-07 §一）。
  const extensions = useMemo(
    () => [...buildExtensions(bridge), SlashMenu, WikiComplete, Folding, FootnoteNumbers, Attachments, QueryBlocks],
    [bridge]
  )

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
        // 隐藏的那一棵永远不该往 store 那一格写：那一格此刻指的是别的标签。
        // （editable 已经是 false，正常走不到这儿；这一道是防「将来有人改了 editable 规则」）
        if (冻结) return
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
    if (editor.isEditable === !冻结) return
    editor.setEditable(!冻结)
  }, [editor, 冻结])

  useEffect(() => {
    // 看不见的那一棵不动它：它读的是自己挂载那一刻的那一份，store 里那一格已经是别人的了
    if (!editor || !visible) return
    if (content === emitted.current) return
    // 外部改的正文（切模式回写的规范化文本）才灌回去
    emitted.current = content
    editor.commands.setContent(content, { contentType: 'markdown', emitUpdate: false })
  }, [editor, visible, content])

  // 交出去的句柄只有一份：搜索命中要在 PM 自己的坐标系里选字（见 richView.ts）；
  // editor 实例给表格增删那几条命令用（见 commands.ts 的 table.* 那组）。
  // 期-09a 之后挂着好几棵，所以「看得见」才有句柄可交，交还也只交还自己那一份
  useEffect(() => {
    if (!editor || !visible) return
    const view = editor.view
    setRichView(view)
    setRichEditor(editor)
    return () => {
      releaseRichView(view)
      releaseRichEditor(editor)
    }
  }, [editor, visible])

  /** 看不见之前把这一格的光标记下来。滚动不在这里量：那一段属于外面那个共用的
   *  滚动容器，它在 cleanup 之前就已经被 `display:none` 夹到 0 了（见 Editor.tsx 的 `记滚动`）。 */
  useEffect(() => {
    if (!editor || !visible) return
    return () => {
      const sel = editor.state.selection
      useStore.getState().setTabView(entryId, {
        anchor: sel.from,
        head: sel.to,
        focused: editor.view.hasFocus(),
      })
    }
  }, [editor, visible, entryId])

  // 看得见的那一刻把这一格摆回它该在的位置：存过光标就回到那一处（切回来、或重启恢复），
  // 没存过就是第一次打开这一篇——沿用原来的行为，光标放文末（落在文首的话第一句话会插到最前面）。
  // 阅读模式不占光标，免得把 window 焦点从别处抢走。
  useEffect(() => {
    if (!editor || !visible) return
    const 格 = useStore.getState().tabs.find((t) => t.entryId === entryId)
    if (格 && 格.anchor !== null && 格.head !== null) {
      const 大小 = editor.state.doc.content.size
      // 库里那一串可能已经不是这一棵手里那一串了（恢复过历史版本、外部改过）：
      // 越界就贴边，贴不出文字块就退到最近的位置——宁可光标不对，不要点进来一片空白
      const 夹 = (p: number): number => Math.max(1, Math.min(p, Math.max(1, 大小 - 1)))
      const 起点 = editor.state.doc.resolve(夹(格.anchor))
      const 选 = 起点.parent.isTextblock
        ? TextSelection.between(起点, editor.state.doc.resolve(夹(格.head)))
        : TextSelection.near(起点)
      editor.view.dispatch(editor.state.tr.setSelection(选))
      if (格.focused && !readOnly) editor.view.focus()
      return
    }
    if (readOnly) return
    // Tiptap 的 `focus()` 命令把真正的 `view.focus()` 排进了 requestAnimationFrame（为
    // iOS / Safari 的键盘调的）。窗口一被遮挡 rAF 就不跑，光标也就没落地，后面那两条选区
    // 事务更没人往 DOM 里同步——先把焦点拿进来，选区才有地方落。
    editor.view.focus()
    editor.commands.focus('end')
    // `focus('end')` 交出来的位置在文末可能是两块的**缝隙**上（文末那是公式 / 图那种原子块
    // 时），或者干脆是整块选中。缝隙上没有光标，用户看到的是「我打的字跑到下面另起一段」；
    // 整块选中更糟——第一个字符把刚看到的图整块换掉。两种都往回收一步：退回上一个文字块末尾。
    const sel = editor.state.selection
    if (isNodeSelection(sel) || !sel.$from.parent.isTextblock) {
      const back = TextSelection.near(sel.$from, -1)
      if (back.$from.parent.isTextblock) editor.commands.setTextSelection(back.from)
    }
  }, [editor, visible, readOnly, entryId])

  return (
    <div className="md-body">
      <EditorContent editor={editor} />
      {冻结 ? null : <SlashPopup />}
      {冻结 ? null : <WikiCompletePopup />}
    </div>
  )
}