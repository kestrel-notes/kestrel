/** 幻灯片分页（期-09c）。把一篇 markdown 按「独占一行的分割线」切成页。
 *
 *  为什么是一个带状态的行扫描而不是 `split('\n---\n')`：
 *
 *  1. **代码围栏里的 `---` 是内容**，切了就把人家的示例切碎。
 *  2. **`---` 紧跟在一行正文之后时它根本不是分割线，是 setext 二级标题的下划线**
 *     （CommonMark 特意规定：由 `-` 组成的 thematic break 不许打断段落）。
 *     所以「上一行不是空行」的破折号那一律不当分页。`***` / `___` 按规范可以打断段落，
 *     但这里一并要求上下留空行——**宁可少切一页，也不切出一页不存在的东西**：
 *     少切是「这一页长一点」，多切是把一段完整的话劈成两半。
 *  3. 认的是**行**而不是 ProseMirror 的 `<hr>` 节点：09a 之后一个窗口里挂着好几棵树，
 *     「当前那一棵」还要额外判；而 `content` 这个字符串是三档模式共同的真相（§一）。
 *
 *  实测撑着这条：`---` / `- - -` / `***` 三种写法在编辑器一轮往返（`Ctrl+S`）之后逐字节不变
 *  （`docs/期-09c-设计稿.md` §〇 M1），所以分页标记不会在第一次保存之后失效。 */

/** 缩进 4 空格以上不是分割线，是代码块 */
const 最多缩进 = 3

const 围栏 = /^ {0,3}(`{3,}|~{3,})/

/** 这一行去掉空格之后是不是「三个以上的同一种横线字符」 */
export function isSlideBreak(line: string): boolean {
  const 前导空格 = line.length - line.trimStart().length
  if (前导空格 > 最多缩进) return false
  const 净 = line.trim().replace(/ /g, '')
  if (净.length < 3) return false
  return /^-{3,}$/.test(净) || /^\*{3,}$/.test(净) || /^_{3,}$/.test(净)
}

/** 切成页。没有分页符就是整篇一页（`[md]`，永远不为空数组）。
 *  连续两条分页符切出来的空页直接丢掉——演示里没人要看一页白屏。
 *
 *  页首与页尾的空行是分页符自己的呼吸空间，不算内容，去掉；
 *  **页内一个字都不动**（不 trim 行、不吞行、不改行尾）。 */
export function slideSplit(md: string): string[] {
  const 页: string[] = []
  let 当前: string[] = []
  let 在围栏里 = false
  const 收 = (): void => {
    while (当前.length && 当前[0].trim() === '') 当前.shift()
    while (当前.length && 当前[当前.length - 1].trim() === '') 当前.pop()
    if (当前.length) 页.push(当前.join('\n'))
    当前 = []
  }
  const 行 = md.split(/\r?\n/)
  for (let i = 0; i < 行.length; i++) {
    const 这一行 = 行[i]
    if (围栏.test(这一行)) {
      在围栏里 = !在围栏里
      当前.push(这一行)
      continue
    }
    const 上面空 = i === 0 || 行[i - 1].trim() === ''
    if (!在围栏里 && 上面空 && isSlideBreak(这一行)) {
      收()
      continue
    }
    当前.push(这一行)
  }
  收()
  return 页.length ? 页 : [md]
}
