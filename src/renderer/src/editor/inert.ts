/** 「字符串 → DOM」这一跳的唯一出口（期-05 §3 D5）。
 *
 *  仓库里本来 0 处 `innerHTML`（期-04 §2.1 结论 1），本期要渲染的 KaTeX 与 Mermaid 给的
 *  都是字符串。走 `DOMParser` 而不是 innerHTML 有两层意义：
 *  1. 解析出来的节点是 **inert** 的——`<script>` 搬进活文档也不会执行；
 *  2. 它只有一处，红线只要看这一个文件。
 *
 *  inert 不等于安全：**属性**是照原样搬过来的，`on*` 与 `href="javascript:"` 一进活文档就会
 *  生效；`<foreignObject>` 还能把 HTML 塞回来。所以再自己扫一遍（`scrubInsecure`），
 *  不只信 mermaid 的 `securityLevel: 'strict'`。剥完仍然是那张图，不做整体替占位。 */

/** HTML 字符串 → 一个 inert 元素（取 body 的第一个子节点）。 */
export function htmlToInert(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const first = doc.body.firstElementChild
  if (!first) return document.createElement('span')
  scrubInsecure(first)
  return first as HTMLElement
}

/** SVG 字符串 → inert 的 `<svg>`。MIME 用 `image/svg+xml`，否则命名空间会掉、图形画不出来。 */
export function svgToInert(svg: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const bad = doc.querySelector('parsererror')
  const root = doc.documentElement
  if (bad || !root || root.nodeName.toLowerCase() !== 'svg') {
    const fallback = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    fallback.setAttribute('data-svg-error', '')
    return fallback
  }
  scrubInsecure(root)
  return root as unknown as SVGSVGElement
}

/** 会执行的标签：连内容一起删。`<style>` 留着——mermaid 的主题色就在里面，
 *  且现代浏览器里 CSS 已无执行能力；CSP `style-src 'unsafe-inline'` 那一档是明写的取舍。 */
const DEADLY = new Set(['script', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base'])

/** 图片类属性只有这几种值能过：片段引用与内联数据。远程地址由 CSP `img-src` 再拦一层。 */
const SAFE_URL = /^(?:#|data:image\/|kestrel-asset:)/i
const URL_ATTR = /^(?:href|xlink:href|src|generator)$/i

export function scrubInsecure(root: Element): void {
  const own = (el: Element): void => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      const value = attr.value.trim()
      if (/^on/i.test(name)) el.removeAttribute(attr.name)
      else if (name === 'href' && /^\w*script:/i.test(value)) el.removeAttribute(attr.name)
      else if (URL_ATTR.test(name) && !SAFE_URL.test(value)) {
        // 相对/远程地址一律剥掉：图没了比任意本地文件被读走好
        el.removeAttribute(attr.name)
      }
    }
  }
  const walk = (el: Element): void => {
    for (const child of [...el.children]) {
      if (DEADLY.has(child.nodeName.toLowerCase())) {
        child.remove()
        continue
      }
      own(child)
      walk(child)
    }
  }
  own(root)
  walk(root)
}
