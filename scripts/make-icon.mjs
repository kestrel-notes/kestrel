/** 从 resources/icon.svg 生成 resources/icon.png（256，给窗口用）与 resources/icon.ico（给安装包/快捷方式用）。
 *
 *  为什么栅格化要跑在应用窗口里：项目里没有引入图像库（零原生模块是硬约束），
 *  而窗口里就有一个 Chromium —— canvas 画 SVG、toDataURL 出 PNG 都是现成的。
 *  代价是**得先把带调试端口的应用跑起来**（npm run dev -- --remoteDebuggingPort 9222）。
 *
 *  用法：node scripts/make-icon.mjs */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluate } from '../scratch/cdp-client.mjs'

const ROOT = join(import.meta.dirname, '..')
const SIZES = [16, 24, 32, 48, 64, 128, 256]
// apple-touch-icon 要 180，不在 .ico 的名单里；单独栅格一张
const RASTER = [...SIZES, 180]

const svg = readFileSync(join(ROOT, 'resources/icon.svg'), 'utf8')
const svgLiteral = JSON.stringify(svg)

const expression = `(async () => {
  const markup = ${svgLiteral}
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
  await img.decode()
  const out = {}
  for (const size of ${JSON.stringify(RASTER)}) {
    const cv = document.createElement('canvas')
    cv.width = size
    cv.height = size
    const ctx = cv.getContext('2d')
    ctx.drawImage(img, 0, 0, size, size)
    out[size] = cv.toDataURL('image/png').slice('data:image/png;base64,'.length)
  }
  return out
})()`

const pngs = await evaluate(expression)

/** ICO 容器：6 字节头 + 每张图 16 字节目录项 + 图像本体。
 *  图像本体直接用 PNG（Vista 以后的 Windows 认，electron-builder 也认），
 *  所以这里不需要自己写 BMP 编码。256 的宽高在目录项里按规范写 0。 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  let offset = 6 + entries.length * 16
  const dir = []
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    dir.push(e)
    offset += data.length
  }

  return Buffer.concat([header, ...dir, ...entries.map((e) => e.data)])
}

const entries = SIZES.map((size) => ({ size, data: Buffer.from(pngs[size], 'base64') }))
const ico = buildIco(entries)

writeFileSync(join(ROOT, 'resources/icon.png'), entries.find((e) => e.size === 256).data)
writeFileSync(join(ROOT, 'resources/icon.ico'), ico)

// 站点图标同源：favicon 用 32，apple-touch 用 180，favicon.ico 直接复用上面拼好的 ico
writeFileSync(join(ROOT, 'site/favicon.png'), Buffer.from(pngs[32], 'base64'))
writeFileSync(join(ROOT, 'site/apple-touch-icon.png'), Buffer.from(pngs[180], 'base64'))
writeFileSync(join(ROOT, 'site/favicon.ico'), ico)

// 回读校验：目录项说的大小和 PNG 头里的一致，说明拼装没串位
const check = SIZES.map((size) => {
  const i = 6 + SIZES.indexOf(size) * 16
  const at = ico.readUInt32LE(i + 12)
  return {
    尺寸: size,
    目录项里的宽: ico.readUInt8(i) || 256,
    PNG头里的宽: ico.readUInt32BE(at + 16),
    字节: ico.readUInt32LE(i + 8),
  }
})

console.log('icon.png', entries.find((e) => e.size === 256).data.length, '字节')
console.log('icon.ico', ico.length, '字节，', entries.length, '张图')
console.table(check)
if (check.some((c) => c.目录项里的宽 !== c.PNG头里的宽)) {
  console.error('目录项与 PNG 头对不上')
  process.exitCode = 1
}