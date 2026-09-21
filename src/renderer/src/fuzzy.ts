/** 子序列匹配的打分。**不引模糊搜索库**：命令面板与快速切换的数据量是几百条，
 *  自己写够用，也省掉一套要跟主题变量对接的高亮样式。
 *
 *  分数越小越靠前：
 *  0 → 前缀命中（`升格` 命中「升格为文章」）
 *  1 + 偏移 → 中间连续命中（`为文` 命中「升格为文章」），越靠前越好
 *  2 + 跨度 → 子序列命中（`sgwz` 命中「升格为文章」），跳过的字越少越好
 *  null → 不是子序列，这一条不显示 */
export function matchScore(text: string, query: string): number | null {
  if (!query) return 0
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  if (t.startsWith(q)) return 0

  const at = t.indexOf(q)
  if (at >= 0) return 1 + at / 1e4

  let hit = 0
  let first = -1
  let last = -1
  for (let i = 0; i < t.length && hit < q.length; i++) {
    if (t[i] !== q[hit]) continue
    if (first < 0) first = i
    last = i
    hit++
  }
  if (hit < q.length) return null
  return 2 + (last - first + 1 - q.length) / t.length
}