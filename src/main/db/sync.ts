/** 文件夹同步（期-10）。推 = `VACUUM INTO` 到那个夹，拉 = 走既有的换库那一路。
 *
 *  三条承重的东西，全都写在这里而不是界面上：
 *
 *  1. **应用一个网络包都不发。** 全程 `node:fs` + SQLite，那个夹归 Dropbox / OneDrive /
 *     Syncthing 去搬。「零网络请求」那句承诺（`README.md:8`）因此一个字都不用改。
 *  2. **拉就是换库，所以拉必须走 `backup.restore()` 那一条被审过的路**：先把那个夹里那一份
 *     拷成 backups/ 里一份合法命名的快照，再叫它换。自己另写一段"关连接 → 拷 → 重开"
 *     只会漏掉那条路上已有的东西（自保那一份、`-wal`/`-shm` 的清理顺序、失败时把原库开回来）。
 *  3. **判据不在这里，在 `shared/syncFormat.ts`。** 这一半只有落盘与实机验，
 *     那一半离线一条一条问遍（`scratch/p10-fmt-test.mjs`，52 条）。
 *
 *  库身份 `lib-id` 落 `Setting`（kv 表，加键不用迁移——实测 M1），**随库走**：
 *  所以快照、备份、推出去的那一份天然都带着它，认不出身份的那一份一律不换。 */

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { SyncFace, SyncMark } from '../../shared/syncFormat'
import {
  判,
  基线文件,
  夹里有货,
  库名,
  记名,
  那句话,
  解析记录,
  能拉,
  能推,
  临时名,
  要人挑,
  同面,
} from '../../shared/syncFormat'
import type { SyncResult, SyncStatus } from '../../shared/types'
import { restore, backupRoot, 说人话 } from './backup'
import { DatabaseSync, getDatabase } from './index'
import { all as settingsAll, patch as settingsPatch } from './settings'
import { snapshotName, dayKey, stampKey, isDailyName } from '../../shared/backupFormat'

/** 库身份那一行。它不在 `Settings` 那个类型里（那是给人调的），这一行是库自己的属性 */
const 身份键 = 'lib-id'

/** 惰性生成：第一次用到才有。生成在库里的，所以换过一次机器之后它跟着库走 */
export function libId(): string {
  const db = getDatabase()
  const 行 = db.prepare('select value from Setting where key = ?').get(身份键) as unknown as
    | { value: string }
    | undefined
  if (行) {
    try {
      const v = JSON.parse(行.value)
      if (typeof v === 'string' && v.length >= 8) return v
    } catch {
      /* 坏了就往下重新生成：认不出身份的库比一个坏掉的键更危险 */
    }
  }
  const 新 = randomUUID().replace(/-/g, '').slice(0, 12)
  db.prepare(
    'insert into Setting(key, value) values(?, ?) on conflict(key) do update set value = excluded.value'
  ).run(身份键, JSON.stringify(新))
  return 新
}

/** 本地此刻那三个数。全是读，各 ≤1ms（实测 M3） */
function 本地面(): SyncFace {
  const db = getDatabase()
  const 篇 = db
    .prepare('select count(*) c from Entry where deleted_at is null')
    .get() as unknown as { c: number | bigint }
  const 时 = db
    .prepare('select max(updated_at) m from Entry')
    .get() as unknown as { m: string | null }
  const 构 = db.prepare('pragma user_version').get() as unknown as { user_version: number }
  return {
    libId: libId(),
    schema: Number(构.user_version),
    entries: Number(篇.c),
    updatedAt: 时.m ?? '',
  }
}

function 基线路(): string {
  return join(app.getPath('userData'), 基线文件)
}

function 读基线(): SyncMark | null {
  try {
    return 解析记录(readFileSync(基线路(), 'utf8'))
  } catch {
    return null
  }
}

function 写基线(面: SyncFace, at: string): void {
  const 记: SyncMark = { ...面, at }
  try {
    writeFileSync(基线路(), JSON.stringify(记, null, 2))
  } catch (err) {
    throw 说人话(err, '记下同步基线')
  }
}

function 夹的路(): string | null {
  const d = settingsAll().syncDir
  return d && d.trim() ? d : null
}

/** 只读地打开那个夹里那一份，问它一句：能开吗、几篇、结构到第几版、库是谁的。
 *  **只读**——这一问要是把 WAL 建在那个夹里，就等于替别人的机器写了一次盘。
 *  数不出来就回 null（界面上写「读不了」），不猜。 */
function 问那份(path: string): (SyncFace & { ok: boolean; note: string }) | null {
  let conn: DatabaseSync | null = null
  try {
    conn = new DatabaseSync(path, { readOnly: true })
    const 篇 = conn
      .prepare('select count(*) c from Entry where deleted_at is null')
      .get() as unknown as { c: number | bigint }
    const 时 = conn
      .prepare('select max(updated_at) m from Entry')
      .get() as unknown as { m: string | null }
    const 构 = conn.prepare('pragma user_version').get() as unknown as { user_version: number }
    const 身 = conn
      .prepare('select value from Setting where key = ?')
      .get(身份键) as unknown as { value: string } | undefined
    let 身值 = ''
    const 原 = 身?.value
    if (原) {
      try {
        const 解: unknown = JSON.parse(原)
        if (typeof 解 === 'string') 身值 = 解
      } catch {
        身值 = ''
      }
    }
    const 检 = conn.prepare('pragma integrity_check').get() as unknown as Record<string, string>
    const 结 = Object.values(检)[0] ?? ''
    return {
      libId: 身值,
      schema: Number(构.user_version),
      entries: Number(篇.c),
      updatedAt: 时.m ?? '',
      ok: 结 === 'ok',
      note: 结,
    }
  } catch {
    return null
  } finally {
    conn?.close()
  }
}

/** 那个夹里那一份的"记录"。读不到或读坏都当"没有那一份"——
 *  当成"夹是空的"会更糟：`判()` 于是以为只有本地动过，下一次推直接把对方盖掉 */
function 读夹内(dir: string): SyncMark | null {
  if (!夹里有货(existsSync(join(dir, 库名)), existsSync(join(dir, 记名)))) return null
  try {
    return 解析记录(readFileSync(join(dir, 记名), 'utf8'))
  } catch {
    return null
  }
}

export function status(): SyncStatus {
  const dir = 夹的路()
  const 在 = !!dir && existsSync(dir)
  const 本地 = 本地面()
  const 基线 = 读基线()
  const 夹内 = dir && 在 ? 读夹内(dir) : null
  const 判据 = 判(基线, 本地, 夹内)
  const 库文件 = dir && 在 && existsSync(join(dir, 库名)) ? statSync(join(dir, 库名)).size : null
  return {
    dir,
    hasDir: 在,
    verdict: 判据,
    line: 那句话(判据),
    baseline: 基线,
    local: 本地,
    remote: 夹内,
    canPush: 能推(判据),
    canPull: 能拉(判据),
    needChoice: 要人挑(判据),
    dbBytes: 库文件,
    // 那份记录说的数与那一份库自己说的数不一致 ⇒ 有人动过那个夹（手拷、或另一版客户端）。
    // 界面要写这一句，因为它意味着"判据站不住"
    mismatch:
      !!夹内 && !!dir && 在
        ? (() => {
            const 真 = 问那份(join(dir, 库名))
            if (!真) return '那一份库打不开'
            if (!真.ok) return `那一份库自检没过（${真.note}）`
            if (!同面(夹内, 真)) return '那份记录与库自己说的数不一致（那个夹被人动过）'
            if (真.libId && 真.libId !== 夹内.libId) return '那份记录写的库身份与库里那一个不同'
            return null
          })()
        : null,
  }
}

/** 推：`VACUUM INTO` 落 .tmp → rename 成 `kestrel.db` → 写记录 → 写基线。
 *  分这两步是 M2b 那条：rename 是元数据操作（2ms，与大小无关），
 *  所以那个夹里的同步盘永远只看到"整份文件出现了"，看不到半截。
 *
 *  开头那一道 `能推` 闸不是防御性编程：推会把**那个夹里那一份整个换掉**，而那一头可能正被
 *  另一台机器当参照物——界面上那颗灰按钮是唯一的提醒，机器不该在 IPC 那一层绕过去。
 *  （实机第一跑就是从这里露的：C 那台在 `other-lib` 态下从 IPC 推成功了。） */
export function push(): SyncResult {
  const dir = 夹的路()
  if (!dir) throw new Error('还没挑过那个夹：先按「换一个夹」')
  if (!existsSync(dir)) throw new Error(`那个夹不在了：${dir}`)
  const 起 = 本地面()
  const 夹内 = 读夹内(dir)
  const 判据 = 判(读基线(), 起, 夹内)
  if (!能推(判据))
    throw new Error(
      判据 === 'other-lib'
        ? `现在不能推：那个夹里住着另一部库（${夹内?.libId || '没写身份'}），这一部是 ${起.libId}。` +
          '要换整部库请走设置 · 数据那一格，或者挑一个新文件夹'
        : `现在不能推：${那句话(判据)}`
    )
  const tmp = join(dir, 临时名)
  const 终 = join(dir, 库名)
  const t0 = Date.now()
  // VACUUM INTO 撞见同名文件会直接报错，所以上一次没走完的那一份先清掉。
  // 清的是 .tmp——`库名` 那一份永远不在这儿被删
  if (existsSync(tmp)) rmSync(tmp)
  try {
    getDatabase().prepare('vacuum into ?').run(tmp)
  } catch (err) {
    if (existsSync(tmp)) rmSync(tmp)
    throw 说人话(err, '推过去')
  }
  const 检 = 问那份(tmp)
  if (!检 || !检.ok) {
    rmSync(tmp)
    throw new Error(`推过去的那一份自检没过（${检?.note ?? '打不开'}），没有落进那个夹`)
  }
  try {
    renameSync(tmp, 终)
  } catch (err) {
    // rename 失败时那份 .tmp 是我们自己的，留下它等于在别人的同步夹里留一个几百 KB 的孤儿
    // （实测：目标被独占锁住时 rename 报 EPERM，而 .tmp 好好地躺在那儿）
    rmSync(tmp, { force: true })
    throw 说人话(err, `落到那个夹（${库名}）`)
  }
  const at = new Date().toISOString()
  const 记: SyncMark = { ...起, at }
  try {
    writeFileSync(
      join(dir, 记名),
      JSON.stringify({ ...记, app: app.getVersion(), 库文件: 库名 }, null, 2)
    )
  } catch (err) {
    throw 说人话(err, '写那份记录')
  }
  写基线(起, at)
  return { side: 'push', ms: Date.now() - t0, entries: 起.entries, file: 终, face: 起 }
}

/** 拉：验身份 → 把那个夹里那一份拷成 backups/ 里一份合法命名的快照 → 走 `restore()`。
 *  不另写换库那一段（文件头第 2 条）。 */
export function pull(): SyncResult {
  const dir = 夹的路()
  if (!dir) throw new Error('还没挑过那个夹：先按「换一个夹」')
  const 终 = join(dir, 库名)
  if (!existsSync(终)) throw new Error(`那个夹里没有 ${库名}，先在那一头推一次过来`)
  const 基线 = 读基线()
  const 本地 = 本地面()
  const 夹内 = 读夹内(dir)
  const 判据 = 判(基线, 本地, 夹内)
  // 身份那一句要单独说，且带着**两边**的库身份：`那句话('other-lib')` 只说"另一部库"，
  // 而人真正要认的是"那一份是谁的、我这一台是谁的"（实机第一跑报的就是那句没有身份的）
  if (判据 === 'other-lib')
    throw new Error(
      `现在不能拉：那个夹里住着另一部库（${夹内?.libId || '没写身份'}），这一部是 ${本地.libId}。` +
        '要换整部库请走设置 · 数据那一格'
    )
  if (!能拉(判据)) throw new Error(`现在不能拉：${那句话(判据)}`)
  const 真 = 问那份(终)
  if (!真) throw new Error('那一份库打不开（不是 SQLite？被截断？）')
  if (!真.ok) throw new Error(`那一份库自检没过（${真.note}），不换`)
  if (真.libId && 真.libId !== 本地.libId)
    throw new Error(
      `那个夹里住着另一部库（${真.libId}），这一部是 ${本地.libId}。要换整部库请走设置 · 数据那一格`
    )
  const t0 = Date.now()
  // 拷进 backups/ 时用一个合法的快照名：`restore()` 认不出的名字它一概不换，
  // 这一条闸正好替我们把"那个夹里的杂七杂八"挡在外面
  const now = new Date()
  mkdirSync(backupRoot(), { recursive: true })
  const 当天 = readdirSync(backupRoot()).filter(
    (n) => isDailyName(n) && n.includes(dayKey(now))
  ).length
  const 快照名 = snapshotName(now, Math.max(1, 当天))
  const 落点 = join(backupRoot(), 快照名)
  try {
    copyFileSync(终, 落点)
  } catch (err) {
    throw 说人话(err, '把那个夹里那一份接进来')
  }
  const r = restore(快照名)
  // 基线跟着换：拉完之后"两边一致"的那三个数就是那一份的数。
  // 不更新基线的话，下一次一开界面就会报"两边都动过"——那是假冲突，而假冲突教人忽略真冲突
  写基线({ libId: 本地.libId, schema: 真.schema, entries: 真.entries, updatedAt: 真.updatedAt }, new Date().toISOString())
  return {
    side: 'pull',
    ms: Date.now() - t0,
    entries: r.entries ?? 真.entries,
    file: 终,
    savedAs: r.saved,
    face: 本地,
  }
}

/** 忘掉这台机器上的同步记录与那个夹。**不删那个夹里的任何文件**——
 *  那是用户自己的地盘，Kestrel 只往里放过东西，没资格替他清 */
export function forget(): void {
  try {
    rmSync(基线路(), { force: true })
  } catch (err) {
    throw 说人话(err, '清掉同步记录')
  }
  settingsPatch({ syncDir: null })
}

/** 界面上那颗按钮要的时刻戳：本地时区那一天 + 时分（与快照文件名同一口径，不另造一套） */
export function 此刻(now: Date = new Date()): string {
  return `${dayKey(now)} ${stampKey(now).slice(0, 2)}:${stampKey(now).slice(2, 4)}`
}
