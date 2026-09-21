/** 校验生成的小尺寸图标还认得出：中央有奶油点、角上被圆角切掉、边上还是栗红底。
 *  16px 是任务栏/开始菜单的真实尺寸，这一档糊了就白做。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluate } from '../scratch/cdp-client.mjs'

const ROOT = join(import.meta.dirname, '..')
const ico = readFileSync(join(ROOT, 'resources/icon.ico'))

const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = {}
for (const [i, size] of sizes.entries()) {
  const at = 6 + i * 16
  const offset = ico.readUInt32LE(at + 12)
  const bytes = ico.readUInt32LE(at + 8)
  images[size] = ico.subarray(offset, offset + bytes).toString('base64')
}

const out = await evaluate(`(async () => {
  const images = ${JSON.stringify(images)}
  const res = {}
  for (const [size, b64] of Object.entries(images)) {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const cv = document.createElement('canvas')
    cv.width = Number(size)
    cv.height = Number(size)
    const ctx = cv.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const px = (x, y) => [...ctx.getImageData(x, y, 1, 1).data]
    const 中央 = px(Math.floor(size / 2), Math.floor(size / 2))
    const 角上 = px(0, 0)
    const 上边中 = px(Math.floor(size / 2), 1)
    // 奶油点在这一档有多少像素宽（横向扫过中心那一行）
    let 点宽 = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x, Math.floor(size / 2))
      if (a > 200 && r > 220 && g > 200 && b > 180) 点宽++
    }
    res[size] = {
      中央: 中央.join(','),
      角上: 角上.join(','),
      上边中: 上边中.join(','),
      奶油点像素宽: 点宽,
    }
  }
  return res
})()`)

console.table(out)
const bad = Object.entries(out).filter(([, v]) => !v.中央.startsWith('251,239,223') || v.奶油点像素宽 < 2)
if (bad.length) {
  console.error('这几档不对：', bad.map(([k]) => k).join(', '))
  process.exitCode = 1
}