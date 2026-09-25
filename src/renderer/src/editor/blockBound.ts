/** 块级 `start` 的搜索边界：一颗 `start` 只需要在**当前这一段**里找标记，不必扫完剩下的整篇。
 *
 *  ## 为什么这句话值一次改动
 *
 *  marked 的块循环（`node_modules/marked/lib/marked.esm.js` 逐字抠）每一轮都做两件事：
 *
 *  ```js
 *  if (this.options.extensions?.block?.some(s => (r = s.call({lexer:this}, e, t))
 *        ? (e = e.substring(r.raw.length), t.push(r), !0) : !1)) continue   // ① 逐颗问过去
 *  …内置块规则（space / code / fences / heading / hr / blockquote / list / html / def / table / lheading）…
 *  let i = e
 *  if (this.options.extensions?.startBlock) {                               // ② 只为剪段落
 *    let s = 1/0, a = e.slice(1)
 *    this.options.extensions.startBlock.forEach(l => { o = l.call({lexer:this}, a); … })
 *    s < 1/0 && s >= 0 && (i = e.substring(0, s + 1))
 *  }
 *  if (this.state.top && (r = this.tokenizer.paragraph(i))) { … }
 *  ```
 *
 *  `e` 是**剩下的整篇**。② 那条路里，`start` 的答案唯一的作用是"把当前这一段在标记处剪断"，
 *  而段落规则自己就在第一个空行停下（`paragraph: /^([^\n]+(?:\n(?!…)[^\n]+)*)/` —— `\n` 后面
 *  必须跟 `[^\n]+`，所以空行进不了 raw）。⇒ 标记落在空行之后，剪与不剪长出来的是同一个 token。
 *  于是把搜索边界收到本段尽头，答案在这一段之内时逐字相同，越界时从"一个大于本段长度的下标"
 *  变成"-1"——而那个下标本来就进不了 `i`（段落规则在它之前就停了）。
 *
 *  ## 等价性不是推出来的，是量出来的
 *
 *  15 档用例逐颗比 token 树（含标记在段内 / 独占一段 / 列表项里 / 嵌套列表 / 引用里的 callout /
 *  围栏 / 行内公式 / 块公式 / 脚注隔一段 / 标记在 200 段之后 / 一段两个标记 / 隔着一整段 /
 *  围栏里有 `>` 与 `[[` / 引用块里再嵌一段 / 块标记紧跟空行），**未界与扫到段尾两版逐颗相同**：
 *  探针 `scratch/p177b-entry.ts` → `node scratch/p177b.mjs`（判据写在设计稿
 *  `docs/期-09a-设计稿.md` §十一）。
 *
 *  ## 但边界**不能**用"把串剪短"来实现
 *
 *  最省事的做法是 `原来的start(src.slice(0, 本段尽头))` —— 这条**错**：
 *  ` ```mermaid ` 围栏可以跨过空行（图里空行是合法内容），剪短之后 `closeOf` 就再也看不见
 *  闭围栏，于是"标记在本段之内却延到段外"的那一档从"报下标"变成"报 -1"，token 树真会变。
 *  所以边界只能当**找开头的循环的上限**传进去（`for (at < 止)`），标记本体往后读多少由各家自己定；
 *  调用点各改各的，这颗函数只提供"本段尽头在哪"这一个数。
 *
 *  ## 与"斜率"的关系（为什么这一趟值得做）
 *
 *  离线 `scratch/p177d.mjs` 按名字记的账（800 段 / 30,291 字，只 lex 一趟）：整趟 184.6 ms 里
 *  ① 那一列占 118.7 ms、② 那一列占 46.4 ms，最贵的三颗是 `mermaidBlock.tokenize` 52.9、
 *  `taskList.tokenize` 31.5、`orderedList.tokenize` 30.1。② 里最贵的是 `mermaidBlock.start` 27.0。
 *  也就是说：**平方不在"扫了多少字"，在"每一轮都按整篇的尺度读一遍"** ——
 *  同一趟里把 `start` 的边界收到本段（② 46.4 → 16.8 ms）只快了 19%，
 *  而把 `tokenize` 那句"先扫完整条再回头看开头"换成"先看开头"是 **108×**
 *  （`scratch/p177e-anchor.mjs`，两版对 1600 轮的 matched/不 matched 结论逐轮一致）。
 *  所以落地的是两件事：本文件提供边界，`mermaidBlock.tokenize` 提供锚定预检。 */

/** `src` 里**第一个空行**的行首下标；没有空行就返回 `src.length`。
 *
 *  "空行"与 marked 自己那条 `other.blankLine = /^[ \t]*(?:\n|$)/` 同判据（只允许空格与制表符）。
 *  写成字符码循环而不是 `indexOf('\n')` 一行一行跳，是为了不在这条最短的路径上分配字符串。 */
export function blockEnd(src: string): number {
  const n = src.length
  let i = 0
  for (;;) {
    const lineStart = i
    while (i < n && src.charCodeAt(i) !== 10) i++
    const next = i < n ? i + 1 : n
    let blank = true
    for (let k = lineStart; k < next - 1; k++) {
      const c = src.charCodeAt(k)
      if (c !== 32 && c !== 9 && c !== 13) {
        blank = false
        break
      }
    }
    if (blank) return lineStart
    if (next >= n) return n
    i = next
  }
}
