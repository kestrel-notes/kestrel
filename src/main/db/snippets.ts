/** CSS 片段（期-09b §二）。用户手放在目录里的 `.css` 就是数据，这里**不落库**：
 *  把片段抄进 `Setting` 会造出第二真相源，两份不一致的时候没人能解释哪一份算（§七 决策 49）。
 *
 *  目录固定在库旁边，与 `attachments/`、`backups/` 同一屋檐——那一侧是卸载时保留的
 *  （`electron-builder.yml` 的 `deleteAppDataOnUninstall: false` 是承重的），
 *  人放的样式表跟着日记一起活着才是对的。
 *
 *  渲染进程拿不到路径，也改不了文件：这里只有「读一份清单」和「目录变了吱一声」。 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Snippet } from '../../shared/types'
import { all as settingsAll } from './settings'

/** 单份上限 1 MB。给「读盘 + 把一坨字符串搬过 IPC」设的，不是给 CSS 引擎设的
 *  （实测 273 KB / 5000 条：注入 4.2 ms + 重算 1.3 ms，见 `docs/期-09b-设计稿.md` §〇 M3）。 */
const 上限 = 1024 * 1024

/** `--no-snippets` 起来的那一跑：一份都不读。
 *  这是§七 决策 44 那两条自救路里的一条，走主进程是因为它必须**在读文件之前**就成立。
 *  清单本身照给——人要知道「我有几份被压住了」，不然这一条变成另一件静默失灵的事。 */
let 会话停用 = false
export function pauseForFlag(): void {
  if (process.argv.includes('--no-snippets')) 会话停用 = true
}

export function snippetRoot(): string {
  return join(app.getPath('userData'), 'snippets')
}

/** 目录不存在就建出来：设置页上要写「文件在这儿」，指着一个月球不合适。
 *  建失败（只读盘、权限）不算错——清单照样给得出来，那一格顶多显示不出来。 */
function 备好目录(): boolean {
  const dir = snippetRoot()
  if (existsSync(dir)) return true
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** 清单按文件名**升序**。这个顺序就是生效顺序（§七 决策 41）：平局由 `<style>` 的先后决定，
 *  所以它必须可预测、且与「谁先落盘」无关——两个人拿同一份目录得到同一个界面。 */
export function list(): Snippet[] {
  const dir = snippetRoot()
  if (!备好目录()) return []
  const 关 = new Set(settingsAll().snippetsOff)
  let 名字: string[]
  try {
    名字 = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.css'))
  } catch {
    return []
  }
  return 名字.sort().map((name) => {
    const 路 = join(dir, name)
    const out: Snippet = { name, bytes: 0, mtime: 0, on: !关.has(name), css: null }
    try {
      const st = statSync(路)
      out.bytes = st.size
      out.mtime = st.mtimeMs
      if (st.size > 上限) out.note = '太大'
      // `--no-snippets` 那一跑：一份都不读，但清单照给（人要知道有几份被压着）
      else if (会话停用) out.note = '本次停用'
      // 关着的那一份不读：它不该进界面，也就没必要把字节搬过进程边界。
      // 但上面那行 note 还是要给——否则清单里那一行会显示成「0 字节、没生效、没原因」
      else if (out.on) out.css = readFileSync(路, 'utf8')
      else out.css = null
    } catch {
      out.note = '读不了'
    }
    return out
  })
}

/* ── 那一声铃 ─────────────────────────────────────────────────────
 *
 *  M4 实测：Windows 上一次保存给 4 个事件（`rename` + 三发 `change`），名字与类型都不可信。
 *  所以这里把整目录的变动**收敛成一声**：事件只当「该重问了」的铃，600 ms 去抖，
 *  铃里不携带任何文件名。渲染层收到就去 `snippet:list` 重问一遍（§七 决策 42）。 */

let 观察者: FSWatcher | null = null
let 尾巴: NodeJS.Timeout | null = null

export function startWatch(吱一声: () => void): void {
  if (!备好目录()) return
  stopWatch()
  try {
    观察者 = watch(snippetRoot(), () => {
      if (尾巴) clearTimeout(尾巴)
      尾巴 = setTimeout(吱一声, 600)
    })
    // 窗口关掉之后不该把 node 的事件循环钉住（退出时也不该等它）
    观察者.unref?.()
  } catch {
    观察者 = null
    console.log('[snippets] 目录看不住，改动只能靠重开或聚焦才看得见')
  }
}

export function stopWatch(): void {
  if (尾巴) {
    clearTimeout(尾巴)
    尾巴 = null
  }
  if (观察者) {
    try {
      观察者.close()
    } catch {
      /* 目录已经被删了，close 会抛——那正是我们不想要的事件源 */
    }
    观察者 = null
  }
}
