/** 图谱标签的截断规则。右栏局部图谱与全屏图谱共用一份——两处各写一份的话，
 *  「9 月 16 日」这种会在一个视图里被切成「9 月 1…」、另一个视图里切成「9 月 16…」 */

/** 宽字符：汉字、CJK 标点（「」——…）、全角形式。emoji 不算在内，它是特例，不值得为它加分支 */
const WIDE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uff60\u2014\u2018-\u201d\u2026]/

/** 按显示宽度截断：宽字算 2 格、窄字算 1 格。
 *  按字符数截会把「9 月 16 日」从数字中间切成「9 月 16…」，看着像坏了。 */
export function fitLabel(text: string, budget: number): string {
  let width = 0
  let out = ''
  for (const ch of text) {
    width += WIDE.test(ch) ? 2 : 1
    if (width > budget) return `${out}…`
    out += ch
  }
  return out
}

/** 估算文本像素宽（只用来判断「会不会顶到画布边」。拿不到 SVG 的 getBBox，粗略够用） */
export function textWidth(text: string, widePx: number, narrowPx: number): number {
  let width = 0
  for (const ch of text) width += WIDE.test(ch) ? widePx : narrowPx
  return width
}
