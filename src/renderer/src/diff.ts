/** 行级差异。**不引 diff 库**：一份修订版通常只差几处，行级够看；
 *  引库要处理它的高亮样式与主题变量对接，成本大于收益（设计文档 §2.4）。
 *
 *  先剪掉公共前后缀，只对中间那一段求 LCS——修订版 99% 的篇幅是相同的，
 *  不剪的话 2000 行的文档要开一张 2000×2000 的表。 */

export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

/** 中间那段超过这个行数就不求 LCS 了，直接"整段换掉"。
 *  两张 1500 行的表 = 225 万格，JS 里要几百毫秒，那是拖动滚动条都会卡的量级。 */
const LCS_CAP = 1500

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')

  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++
  }

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const out: DiffLine[] = []
  for (let i = 0; i < head; i++) out.push({ kind: 'same', text: a[i] })

  if (midA.length > LCS_CAP || midB.length > LCS_CAP) {
    out.push(...midA.map((text) => ({ kind: 'del' as const, text })))
    out.push(...midB.map((text) => ({ kind: 'add' as const, text })))
  } else {
    out.push(...lcsDiff(midA, midB))
  }

  for (let i = a.length - tail; i < a.length; i++) out.push({ kind: 'same', text: a[i] })
  return out
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  // table[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'del', text: a[i++] })
    } else {
      out.push({ kind: 'add', text: b[j++] })
    }
  }
  for (; i < a.length; i++) out.push({ kind: 'del', text: a[i] })
  for (; j < b.length; j++) out.push({ kind: 'add', text: b[j] })
  return out
}