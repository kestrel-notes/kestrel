/** 大纲的**唯一规则**：正文里哪些行算标题、算第几个。
 *
 *  右栏大纲（Rail）、源码模式的大纲跳转与高亮（SourceEditor）都从这里取。
 *  三处各写一份的话，序号就会各算各的——错一个序号，点击就滚到别的标题去。
 *
 *  两条规矩：
 *  1. 只认 `#` ~ `###`（`####` 及以上不抽，见设计文档 §7 的已知简化）
 *  2. **围栏代码块里的 `#` 不算标题** */

export interface OutlineHeading {
  /** 0-based 行号。源码模式靠它换算成文档位置 */
  line: number
  level: number
  text: string
}

const FENCE = /^\s*(```|~~~)/
const ATX = /^(#{1,3})\s+(.+?)\s*#*\s*$/

export function outlineLines(content: string): OutlineHeading[] {
  const out: OutlineHeading[] = []
  let fence = false
  content.split('\n').forEach((line, i) => {
    if (FENCE.test(line)) {
      fence = !fence
      return
    }
    if (fence) return
    const m = ATX.exec(line)
    if (m) out.push({ line: i, level: m[1].length, text: m[2] })
  })
  return out
}