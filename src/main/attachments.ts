/** 附件（期-04 §5.2 / §5.3）：内容寻址落盘 + `kestrel-asset://` 受控读取。
 *
 *  为什么另起一条协议而不是 `file://`：`file://` 全盘可读、没有边界（设计稿 A④ 实测
 *  `![绝对](file:///C:/Windows/win.ini)` 真的发了一次本地文件读取，构成存在性 oracle），
 *  而且打包版是 `file://` origin 下的页面，放开 `file://` 等于放开整块盘。这条协议
 *  只认 `<userData>/attachments/` 下、我们自己去过扩展名白名单、且文件名严格等于
 *  「40 位小写十六进制 + 白名单后缀」那一种形状的东西——越界与名单外一律 404。
 *
 *  渲染进程碰不到裸 fs：落盘只走这一侧的 `importAsset`，字节进来、内容寻址后的
 *  文件名出去。目标路径由主进程拼，用户给的文件名只用来取扩展名，绝不当路径用。 */

import { app, net, protocol } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 只收图片。svg 单列：`<img>` 语境下 Chromium 会禁用 svg 内脚本（HTML 规范层的规定），
 *  我们渲染只用 `<img>`，所以 svg 可以收；但正文绝不给它 `<object>` / `<iframe>` 那条路。 */
const EXT_WHITELIST = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'])

/** 存储名的严格形状：sha1 十六进制（小写、40 位）+ 白名单小写后缀。
 *  渲染层拼 URL、主进程解 URL 都对着它；不含任何路径分隔符，所以无从越界。 */
const ASSET_NAME = /^[0-9a-f]{40}\.[a-z]{2,5}$/

const SCHEME = 'kestrel-asset'

function attachmentsDir(): string {
  return join(app.getPath('userData'), 'attachments')
}

/** 把一条 scheme 声明为特权标准协议。**必须在 `app.whenReady()` 之前**调用（Electron
 *  硬要求）。`secure: true` 让它进 CSP 的白名单、被当作可信来源；`supportFetchAPI: false`
 *  是故意的——只给 `<img>` 这类资源加载用，渲染进程不能拿 `fetch()` 去打它。 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } },
  ])
}

/** 把 handler 装配进协议。**在 `app.whenReady()` 之后**调用（与上面那条相对）。 */
export function mountAssetProtocol(): void {
  protocol.handle(SCHEME, handleAssetRequest)
}

/** 从请求 URL 里抠出存储名。`standard: true` 下 Chromium 可能给裸 host 补一个前导 /
 *  尾随斜杠，所以先把斜杠剥掉，再要求剩下的严格等于 ASSET_NAME。任何一步不满足——
 *  带 `..`、带 `%2F`、后缀在名单外、甚至大小写不对——都返回 null，调用方回 404。
 *  这一函数要能被单元用例直接喂脏串，故导出。 */
export function assetNameFromUrl(raw: string): string | null {
  const prefix = `${SCHEME}://`
  if (!raw.startsWith(prefix)) return null
  let rest = raw.slice(prefix.length)
  // 解码后再判：把 `%2e%2e%2f` 这种先还原，防止绕过下面的字面校验
  try {
    rest = decodeURIComponent(rest)
  } catch {
    return null
  }
  rest = rest.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!ASSET_NAME.test(rest)) return null
  // 兜底：存储名必须本身就是个纯 basename（防未来 ASSET_NAME 放松时漏掉分隔符）
  if (basename(rest) !== rest) return null
  if (!EXT_WHITELIST.has(extname(rest).slice(1))) return null
  return rest
}

/** `protocol.handle` 的落点。装配进主进程 index.ts 的 whenReady 里。 */
export function handleAssetRequest(request: Request): Promise<Response> {
  const name = assetNameFromUrl(request.url)
  if (!name) return Promise.resolve(new Response('not found', { status: 404 }))
  const file = join(attachmentsDir(), name)
  if (!existsSync(file)) return Promise.resolve(new Response('not found', { status: 404 }))
  // net.fetch 走 file:// → 交回带正确 MIME、支持 range 的响应，我们不必自己缓冲整张图
  return net.fetch(pathToFileURL(file).toString())
}

/** 导入一份附件：算 sha1 → 校验扩展名 → 落盘（同 sha1 命中就跳过写）→ 回存储名。
 *  `originalName` 只贡献扩展名，正文里不留原始文件名。 */
export async function importAsset(originalName: string, data: Uint8Array): Promise<string> {
  if (!data || data.byteLength === 0) throw new Error('空文件')
  const ext = extname(originalName).toLowerCase().replace(/^\./, '')
  if (!EXT_WHITELIST.has(ext)) throw new Error(`不支持的文件类型：${ext || '未知'}`)

  const sha1 = createHash('sha1').update(data).digest('hex')
  const name = `${sha1}.${ext}`
  const dir = attachmentsDir()
  await mkdir(dir, { recursive: true })
  const target = join(dir, name)
  try {
    // 内容寻址：同名即同内容，已经在那儿了就不用再写一遍（这就是去重）
    if ((await stat(target)).size > 0) return name
  } catch {
    /* 还没落过盘，往下写 */
  }
  await writeFile(target, data)
  return name
}
