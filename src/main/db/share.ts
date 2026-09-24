/** 单篇离线分享（期-11a §五）：把渲染层洗好的那一串 HTML 落成一个文件。
 *
 *  这一层只有两件事，而且都是"界面上做不到"的那两件事：
 *  1. **取附件的字节**（渲染进程碰不到 fs）。名字先过 `assetNameFromUrl` 那一刀，
 *     所以这条通道给不出路径——与 `kestrel-asset://` 的协议 handler 同一个判据。
 *  2. **写那个文件**。目录只能来自 `transfer:pick('share')` 那一次系统对话框；
 *     文件名由这里的 `safeName` 拼（期-08 那一条洗名规矩，不抄第二份），
 *     渲染层给的标题只当字符串用，绝不当路径用。
 *
 *  落盘之前先跑 `自检()`（§四 那三条硬判据）。**过不了就不写**，一个字节都不落——
 *  一份带着脚本或者带着本机路径的文件寄出去之后，收的那一头才发现，改都改不回来。
 *  写的过程是 `.tmp` → `rename`：与期-10 推那一步同一条理由，
 *  目标目录里永远只出现"整份文件出现了"，不会出现半截。 */

import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { readAsset } from '../attachments'
import { safeName } from '../../shared/exportFormat'
import { 单张上限, 总量上限, 自检 } from '../../shared/shareFormat'
import type { ShareAsset, ShareWrite } from '../../shared/types'
import { 说人话 } from './backup'

export function asset(name: string): ShareAsset {
  return readAsset(name, 单张上限)
}

/** 撞车不盖：那一份可能是昨天导的、已经发给过人的。宁可多出 `·2` */
function 不撞车的名字(目录: string, 标题: string): { 名: string; 撞了: boolean } {
  const 基 = safeName(标题, '未命名')
  let 名 = `${基}.html`
  for (let k = 2; k <= 99 && existsSync(join(目录, 名)); k++) 名 = `${基}·${k}.html`
  return { 名, 撞了: 名 !== `${基}.html` }
}

export function write(目录: string, 标题: string, html: string): ShareWrite {
  const t0 = Date.now()
  if (!目录 || !目录.trim()) throw new Error('还没挑过放在哪儿：先按「放到哪个夹」')
  if (!existsSync(目录)) throw new Error(`那个夹不在了：${目录}`)
  const 底 = resolve(目录)
  if (!statSync(底).isDirectory()) throw new Error(`那是一个文件不是夹：${目录}`)
  const 字节 = Buffer.byteLength(html, 'utf8')
  if (字节 > 总量上限)
    throw new Error(
      `这一份是 ${(字节 / 1048576).toFixed(1)} MB，超过整篇 ${(总量上限 / 1048576).toFixed(0)} MB 那一条线——没有写出去。` +
        '要带走这么多图，请用流通 · 导出那一档（Markdown 目录树，图放旁边的 assets/ 里）'
    )
  const 检 = 自检(html)
  if (!检.通过)
    throw new Error(
      `这一份没写出去——它过不了这一档自己那三条判据：\n· ${检.问题.join('\n· ')}\n` +
        '（宁可少一份文件，也不要寄出去一份带着脚本、外链或者本机路径的）'
    )
  const { 名, 撞了 } = 不撞车的名字(底, 标题)
  const 终 = join(底, 名)
  // 名字是自己拼的，但这一句仍然要问：`safeName` 万一哪天松了，这里就是最后一道
  if (终 !== resolve(名) && !终.startsWith(底 + sep)) throw new Error(`落点对不上那个夹：${名}`)
  const 临时 = `${终}.tmp`
  try {
    writeFileSync(临时, html, 'utf8')
  } catch (err) {
    rmSync(临时, { force: true })
    throw 说人话(err, `写那一份 ${名}`)
  }
  try {
    renameSync(临时, 终)
  } catch (err) {
    rmSync(临时, { force: true })
    throw 说人话(err, `落成那一份 ${名}`)
  }
  return { file: 终, bytes: 字节, ms: Date.now() - t0, checks: 检.计数, renamed: 撞了 }
}
