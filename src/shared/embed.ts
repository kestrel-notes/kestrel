/** `![[…]]` 嵌入要的那一截正文（期-05f 丙）。纯函数，主进程与测试共用一套——
 *  两边各写一份的话，"这一处到底嵌的是哪几行"迟早会有两种答案（与 `shared/links.ts` 同一条理由）。
 *
 *  为什么切片算在主进程而不是渲染进程：渲染进程为了画一截，得先把**整篇**正文拿过来，
 *  而那在最坏的一篇上是 20 万字一趟（`期-05-设计稿.md` §11.4 量的 2229 µs / 200000 字）。
 *  切好再回，过的就只是那几行。
 *
 *  为什么这里**不建 `Block` 表**：段尾那串 `^id` 本身就是真相，读时现算（§15.3 第 3 条实测它
 *  能在真闸门下逐字节原样往返）。存一份进表等于给同一个事实造第二个真相源。 */

import { normalizeLinkKey } from './links'

/** 一次嵌入最多回多少字。超了要**按行**截断并把 `截了` 说清楚——截断不报，等于骗人说"那一头就这些" */
export const 嵌的字数 = 20000

const 标题行 = /^ {0,3}(#{1,6})[ \t]+(.*)$/
const 围栏开 = /^(`{3,}|~{3,})/
const 围栏关 = /^(`{3,}|~{3,})[ \t]*$/
const 段尾块 = /\s\^([A-Za-z0-9-]+)[ \t]*$/

export interface 切片结果 {
  /** 切出来的那几行 Markdown。`命中` 为假时是空串 */
  md: string
  /** 锚点/块 id 有没有真的对上那一处。对不上时界面要说什么都不画，而不是画一个空框 */
  命中: boolean
  /** 被 `嵌的字数` 截过 */
  截了: boolean
}

/** 那一行是不是围栏的边界（含 `> ` / 缩进那层壳，与 `links.ts` 的 `unwrap` 同一把尺） */
function 壳(s: string): string {
  const m = /^(?:\s{0,3}|>\s?)+/.exec(s)
  return m ? s.slice(m[0].length) : s
}

/** 按行扫一遍，标出每一行在不在围栏代码块里。
 *  `# 标题` 与段尾 `^id` 写在代码块里都**不算**——那是字面文本，不是结构。 */
function 行表(正文: string): { 行: string[]; 在围栏内: boolean[] } {
  const 行 = 正文.split('\n')
  const 在围栏内: boolean[] = []
  let 栏: string | null = null
  for (const s of 行) {
    在围栏内.push(栏 !== null)
    const 脱 = 壳(s)
    if (栏) {
      const 关 = 围栏关.exec(脱)
      if (关 && 关[1][0] === 栏 && 关[1].length >= 栏.length) 栏 = null
    } else {
      const 开 = 围栏开.exec(脱)
      if (开) 栏 = 开[1][0]
    }
  }
  return { 行, 在围栏内 }
}

/** 取到下一道**同级或更高一级**标题为止——Obsidian 同一条规矩：`[[x#甲]]` 嵌的是"甲这一节"，
 *  不是"甲往下的所有东西"（后者会把整篇套进去）。
 *
 *  围栏代码块里那一行 `## 假标题` **不算**道标题：它不看它，那一节就提前收了尾——
 *  判下来的这一截少半篇，而界面上一个字都不会说。所以 `在围栏内` 要一路带进来。 */
function 那一节(行: string[], 在围栏内: boolean[], 起: number, 级: number): string[] {
  const 出: string[] = [行[起]]
  for (let i = 起 + 1; i < 行.length; i++) {
    if (在围栏内[i]) {
      出.push(行[i])
      continue
    }
    const h = 标题行.exec(壳(行[i]))
    if (h && h[1].length <= 级) break
    出.push(行[i])
  }
  return 出
}

/** 段尾写着 `^id` 的那个块：从它所属那一段的第一行，到下一个空行为止。
 *  多行段落（列表项、引用、软换行的正文）都算一块，与 Obsidian 一样按空行分。 */
function 那一段(行: string[], 在围栏内: boolean[], id: string): string[] | null {
  for (let i = 0; i < 行.length; i++) {
    if (在围栏内[i]) continue
    const m = 段尾块.exec(行[i])
    if (!m || m[1] !== id) continue
    let 起 = i
    while (起 > 0 && 行[起 - 1].trim() !== '') 起--
    let 止 = i
    while (止 + 1 < 行.length && 行[止 + 1].trim() !== '') 止++
    const 出 = 行.slice(起, 止 + 1)
    // 那串 `^id` 是**给机器看的地址**，不是人要读的字：嵌出来要把它去掉
    出[i - 起] = 行[i].replace(段尾块, '')
    return 出
  }
  return null
}

/** 按行截到 `上限` 个字以内（不砍半行——半行 Markdown 会画出半截语法记号）。 */
function 截(取: string[], 上限: number): { md: string; 截了: boolean } {
  let 总 = ''
  for (const s of 取) {
    if (总 && (总.length + s.length + 1) > 上限) return { md: 总, 截了: true }
    总 = 总 ? `${总}\n${s}` : s
  }
  return { md: 总, 截了: false }
}

/** 切出 `![[目标#锚点]]` / `![[目标^块id]]` 要的那一截。
 *
 *  两样都给时先认**块 id**（它比标题精确，`![[x#甲^乙]]` 说的就是那一段）。
 *  锚点比对走 `normalizeLinkKey`：与链接解析、别名、乙那一次跳转**同一条**规矩，
 *  所以 `## 装 窑` 那一节，`![[x#装窑]]` 也认得它。 */
export function 切片(
  正文: string,
  锚点: string | null,
  块: string | null,
  上限: number = 嵌的字数
): 切片结果 {
  const { 行, 在围栏内 } = 行表(正文)

  if (块) {
    const 中 = 那一段(行, 在围栏内, 块)
    if (!中) return { md: '', 命中: false, 截了: false }
    const r = 截(中, 上限)
    return { md: r.md, 命中: true, 截了: r.截了 }
  }

  if (锚点) {
    const 键 = normalizeLinkKey(锚点)
    for (let i = 0; i < 行.length; i++) {
      if (在围栏内[i]) continue
      const h = 标题行.exec(壳(行[i]))
      if (!h) continue
      if (normalizeLinkKey(h[2]) !== 键) continue
      const 取 = 那一节(行, 在围栏内, i, h[1].length)
      const r = 截(取, 上限)
      return { md: r.md, 命中: true, 截了: r.截了 }
    }
    return { md: '', 命中: false, 截了: false }
  }

  const r = 截(行, 上限)
  return { md: r.md, 命中: true, 截了: r.截了 }
}
