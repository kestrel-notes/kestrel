/** 同步那一档（期-10 §三）：把库推到一个你挑的文件夹，再从那个文件夹换回来。
 *
 *  这一档最贵的一刀是**换库**，所以界面上的规矩只有一条：把「谁动过」摆成人能读的数，
 *  然后**不替用户决定**。判据本身在 `shared/syncFormat.ts`（离线 52 条问遍），
 *  这里只负责摆出来与按下去之前再问一句。
 *
 *  三句写在界面上的话是有原因的，不是装饰：
 *   · 「应用不联网」——这一档容易被误认为云同步，得说清是谁在搬那个夹；
 *   · 「那个夹里是能读的全部日记」——明文这一条不能只写在设计稿里；
 *   · 「除了那两个文件，那个夹里的别的 .db 一概不读不删」——同步盘的冲突副本会躺在旁边，
 *     人要是以为我们会替他收拾，就会在错的那一份上按拉。 */

import { useCallback, useEffect, useState, type JSX } from 'react'
import { useStore } from '@/store'
import type { SyncStatus } from '../../../shared/types'

const MB = 1024 * 1024

/** 到**秒**，不是到分。实机第一跑就是这样：冲突那两行印成 `6 篇 · 最后改动 2026-09-24 17:28` 和
 *  一模一样的一句——判据说得对（两边的 ISO 到毫秒确实不同），人却看不出哪里不同。
 *  这一档全部的价值就是"让人自己挑"，那一列数看不出差别等于没摆（M3：`updated_at` 到毫秒）。 */
const 时 = (iso: string | null | undefined): string => (iso ? iso.replace('T', ' ').slice(0, 19) : '—')

export function SyncPane({ open, onBusy }: { open: boolean; onBusy: (b: boolean) => void }): JSX.Element | null {
  const notify = useStore((s) => s.notify)
  const askConfirm = useStore((s) => s.askConfirm)
  const patchSettings = useStore((s) => s.patchSettings)
  const syncDir = useStore((s) => s.settings.syncDir)

  const [st, setSt] = useState<SyncStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [swapped, setSwapped] = useState<{ saved: string; entries: number } | null>(null)

  const 取 = useCallback(async () => {
    try {
      setSt(await window.kestrel.sync.status())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    if (open) void 取()
  }, [open, 取, syncDir])

  if (!open) return null

  async function 挑(): Promise<void> {
    setErr(null)
    const dir = await window.kestrel.transfer.pickDirectory('sync')
    if (!dir) return
    // 先落设置再重取：那一格路径的真相源是 store 里那份设置（#128 与 #77 那一族错，
    // 拿 fetch 回来的那份当真相，点完会弹回原地）
    await patchSettings({ syncDir: dir })
    await 取()
    notify('那个夹定了：Kestrel 只往里面放两份文件')
  }

  async function 推(): Promise<void> {
    setErr(null)
    const 是冲突 = st?.verdict === 'conflict' || st?.verdict === 'unknown'
    if (是冲突) {
      const ok = await askConfirm({
        title: '两边都动过：确定以本地为准？',
        body:
          `那个夹里那一份有 ${st?.remote?.entries ?? '?'} 篇、最后改动 ${时(st?.remote?.updatedAt)}；` +
          `本地是 ${st?.local.entries ?? '?'} 篇、最后改动 ${时(st?.local.updatedAt)}。\n` +
          '推过去会把那个夹里那一份整个换掉。那一头如果还在别的机器上，那些改动就只剩那台机器上有了。',
        confirmLabel: '以本地为准，推过去',
      })
      if (!ok) return
    }
    onBusy(true)
    try {
      const r = await window.kestrel.sync.push()
      notify(`推过去了：${r.entries} 篇 · ${(r.ms / 1000).toFixed(2)} 秒`)
      await 取()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      onBusy(false)
    }
  }

  async function 拉(): Promise<void> {
    setErr(null)
    const ok = await askConfirm({
      title: '从那个夹换回来？',
      body:
        `那一份有 ${st?.remote?.entries ?? '?'} 篇、最后改动 ${时(st?.remote?.updatedAt)}。` +
        (st?.verdict === 'unknown'
          ? '\n这台机器上没有同步记录，判不出谁更新——所以要你自己认这一份。'
          : st?.verdict === 'conflict'
            ? '\n本地这边也动过（' + String(st?.local.entries ?? '?') + ' 篇，最后改动 ' + 时(st?.local.updatedAt) + '），换回来就把本地这些改动从当前库里换走。'
            : '') +
        '\n换之前会先把当前库存成 kestrel-before-restore-… 放在 backups/ 里，退得回去。' +
        '\n换完界面要整页重读一遍：编辑器里还没落盘的改动会丢。',
      confirmLabel: '换回来',
    })
    if (!ok) return
    onBusy(true)
    try {
      const r = await window.kestrel.sync.pull()
      setSwapped({ saved: r.savedAs ?? '', entries: r.entries })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      onBusy(false)
    }
  }

  async function 忘(): Promise<void> {
    const ok = await askConfirm({
      title: '忘掉这台机器上的同步记录？',
      body: '只清这里：那个夹的路径与"上次同步是什么样子"那一份记录。那个夹里的两份文件一个字节都不动。',
      confirmLabel: '忘掉',
    })
    if (!ok) return
    try {
      await window.kestrel.sync.forget()
      await patchSettings({ syncDir: null })
      await 取()
      notify('忘了。下一次同步会当成第一次')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  // 换库之后**不能 flush**：渲染层手里那一份是旧库的内容，落一次盘就是把刚换进来的库改回旧样。
  // 与备份那一档同一收法（BackupPane.tsx:112 那条注释说的是同一件事）。
  if (swapped) {
    return (
      <div className="tr-body">
        <p className="tr-hint">
          换回来了：当前库是那一份的 {swapped.entries} 篇。原来的库存成了{' '}
          <code>{swapped.saved || 'kestrel-before-restore-…'}</code>，在备份那一档里换得回去。
        </p>
        <div className="set-actions">
          <button className="btn primary" onClick={() => window.location.reload()}>
            重读界面
          </button>
        </div>
      </div>
    )
  }

  // 那一行「注」在**没有那一份**的时候更要留：三方比对的第三行如果整行空掉，人就看不出
  // 「这台机器没有同步记录」这一件最要紧的事（实机第一跑就是这里空的）
  const 面 = (标: string, 一: { entries?: number | null; updatedAt?: string | null; schema?: number; libId?: string } | null, 注: string) => (
    <div className="sync-face">
      <span className="k">{标}</span>
      <span className="v">{一 ? `${一.entries ?? '?'} 篇 · 最后改动 ${时(一.updatedAt)}` : '没有那一份'}</span>
      <span className="n">{一 ? `库 ${一.libId ?? '—'} · 结构 v${一.schema ?? '?'} · ${注}` : 注}</span>
    </div>
  )

  return (
    <div className="tr-body">
      {err && <div className="tr-err">{err}</div>}

      <p className="tr-hint">
        同步 = <strong>一个你挑的文件夹</strong>。Kestrel 只往里放两份文件（<code>kestrel.db</code> 与{' '}
        <code>kestrel-meta.json</code>），<strong>应用自己不联网</strong>——把那个夹放进 Dropbox / OneDrive /
        Syncthing，是你在同步，不是应用在发请求。
      </p>

      <div className="set-path">
        那个夹：{syncDir ? <code>{syncDir}</code> : <em>还没挑过</em>}
      </div>
      <div className="set-actions">
        <button className="btn" onClick={() => void 挑()}>
          {syncDir ? '换一个夹' : '挑一个夹'}
        </button>
        <button className="btn" onClick={() => void 取()}>
          重新看一遍
        </button>
        {syncDir && (
          <button className="btn" onClick={() => void 忘()}>
            忘掉这台机器的同步记录
          </button>
        )}
      </div>

      {!syncDir && <p className="set-note">挑一个夹之后，那三方的数才摆得出来。</p>}

      {syncDir && !st?.hasDir && (
        <p className="tr-err">那个夹现在不在这台机器上：{syncDir ?? ''}（移动硬盘没插？云盘还没同步出来？）</p>
      )}

      {st && syncDir && st.hasDir && (
        <>
          <div className="sync-state" data-verdict={st.verdict}>
            {st.line}
          </div>
          {st.mismatch && <div className="tr-err">{st.mismatch}</div>}

          {面('那个夹里那一份', st.remote, st.dbBytes !== null ? `${(st.dbBytes / MB).toFixed(2)} MB` : '那个夹里还没有 kestrel.db')}
          {面('这台机器上的当前库', st.local, '就是你现在在写的')}
          {面('上次同步完那两边长什么样', st.baseline, st.baseline ? `记于 ${时(st.baseline.at)}` : '这台机器没有同步记录')}

          <div className="set-actions">
            <button className="btn" disabled={!st.canPush} onClick={() => void 推()}>
              推过去（换出到那个夹）
            </button>
            <button className="btn" disabled={!st.canPull} onClick={() => void 拉()}>
              换回来（从那个夹拉）
            </button>
          </div>
          {st.needChoice && (
            <p className="set-note">
              这两颗现在都能按，是因为判不出该往哪边走——<strong>这一档不猜哪边算数</strong>。
              按下去之前都会再问一次，而被换掉那一边都会先自保一份。
            </p>
          )}
          {st.verdict === 'clean' && <p className="set-note">两边一致，两颗都按不动。</p>}
          {(st.verdict === 'other-lib' || st.verdict === 'newer-schema') && (
            <p className="set-note">这一档不换库：要换整部库请走设置 · 数据那一格。</p>
          )}

          <p className="set-note">
            那个夹里是一份<strong>能读的完整日记</strong>（明文 SQLite）。它在谁的云盘账号里，你的日记就在谁那儿。
            除了那两份文件，那个夹里出现的别的 <code>.db</code>（比如同步盘的冲突副本）Kestrel{' '}
            <strong>一概不读、不删</strong>。
          </p>
        </>
      )}
    </div>
  )
}
