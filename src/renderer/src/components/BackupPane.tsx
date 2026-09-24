/** 备份与恢复那一档（期-08 §四）。
 *
 *  这一档要回答的是两个平时想不起来、出事时唯一的问题：「最近的一份是哪天」和
 *  「换回去之后我现在这些改动去哪了」。所以：
 *  - 每一份都数过篇数摆在行上（只读打开那一份，见 `db/backup.ts` 的 `数一份`）——
 *    光有日期没人敢按，能对上周几篇才算数；
 *  - 换库之前先把当前库存成 `kestrel-before-restore-*`，并把那个文件名当场报出来。
 *    它是「换错了还能回哪去」的唯一答案，藏在建表语句里等于没有。
 *
 *  30 天那一刀（#76 的账）在这里是**看得见的数**：待砍多少版、回收站里待删多少篇。
 *  原先它只是回收站与历史版本上的一行显示，主进程里没有清理路径——那是这一档存在的理由。 */

import { useCallback, useEffect, useState, type JSX } from 'react'
import { useStore } from '@/store'
import type { BackupInfo, BackupStatus } from '../../../shared/types'

const MB = 1024 * 1024

export function BackupPane({ open }: { open: boolean }): JSX.Element | null {
  const setOpen = useStore((s) => s.setTransferOpen)
  const notify = useStore((s) => s.notify)
  const askConfirm = useStore((s) => s.askConfirm)
  const patchSettings = useStore((s) => s.patchSettings)
  // 那颗勾的真相源是 store 里那份设置（`patchSettings` 先改本地再落库），不是这里 fetch 回来的
  // `st.enabled`。用后者会在点一下之后把勾又弹回原地——第二下怎么按都没反应，
  // 与 #77 那次「失焦后那一秒显示的是库里没有的那一份」是同一族错。
  const enabled = useStore((s) => s.settings.backupEnabled)

  const [st, setSt] = useState<BackupStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [swapped, setSwapped] = useState<{ from: string; saved: string } | null>(null)

  const 取 = useCallback(async () => {
    try {
      setSt(await window.kestrel.backup.status())
    } catch (e) {
      setErr(m(e))
    }
  }, [])

  useEffect(() => {
    if (open) void 取()
  }, [open, 取])

  if (!open) return null

  async function now(): Promise<void> {
    setErr(null)
    setBusy(true)
    try {
      const r = await window.kestrel.backup.now()
      notify(
        `备好了 ${r.name}（${r.ms} 毫秒）` +
          (r.pruned.length ? `，超出名额删掉 ${r.pruned.length} 份` : '')
      )
      await 取()
    } catch (e) {
      setErr(m(e))
    } finally {
      setBusy(false)
    }
  }

  async function cut(): Promise<void> {
    const ok = await askConfirm({
      title: '现在跑一次 30 天那一刀？',
      body: `历史版本删掉 ${st?.pending.revisions ?? 0} 版、回收站里彻底删掉 ${
        st?.pending.entries ?? 0
      } 篇。跑之前先备一份，那一版就是这一刀的回退路径。`,
      confirmLabel: '先备一份，再砍',
    })
    if (!ok) return
    setErr(null)
    setBusy(true)
    try {
      await window.kestrel.backup.now()
      const r = await window.kestrel.backup.prune()
      notify(`30 天那一刀：删了 ${r.revisions} 版历史、${r.entries} 篇回收站里的`)
      await 取()
    } catch (e) {
      setErr(m(e))
    } finally {
      setBusy(false)
    }
  }

  async function to(snap: BackupInfo): Promise<void> {
    const ok = await askConfirm({
      title: `换到 ${snap.name}？`,
      body:
        `那一份里有 ${snap.entries === null ? '数不出来的篇数' : `${snap.entries} 篇`}、` +
        `${(snap.size / MB).toFixed(2)} MB。换之前会先把当前库存成 ` +
        'kestrel-before-restore-… 放在同一个目录里，退得回去。\n' +
        '换完界面要整页重读一遍：编辑器里还没落盘的改动会丢——那本来是要写进另一部库的。',
      confirmLabel: '换过去',
    })
    if (!ok) return
    setErr(null)
    setBusy(true)
    try {
      const r = await window.kestrel.backup.restore(snap.name)
      setSwapped({ from: r.from, saved: r.saved })
      notify(`已换到 ${r.from}`)
    } catch (e) {
      setErr(m(e))
    } finally {
      setBusy(false)
    }
  }

  // 换库之后**不能 flush**：渲染层手里那份是旧库的内容，落一次盘就是把刚换进来的库改回旧样。
  // 直接重读——待处理的防抖保存随页面一起销毁，这正是我们要的。
  function 重读(): void {
    setOpen(false)
    window.location.reload()
  }

  const 今天 = st?.today ?? ''
  const 托管 = (st?.snapshots ?? []).filter((s) => s.kind !== 'before')
  const 自保 = (st?.snapshots ?? []).filter((s) => s.kind === 'before')

  return (
    <div className="tr-body">
      {err && <div className="tr-err">{err}</div>}

      {swapped ? (
        <>
          <p className="tr-hint">
            已经换成 <code>{swapped.from}</code> 那一份了。换之前当前库存成了{' '}
            <code>{swapped.saved}</code>，想退回去就再换一次那一档。
          </p>
          <p className="tr-hint">
            库里现在的内容与刚才看到的不一样了，整页要重读一遍才对得上。
          </p>
          <div className="tr-foot">
            <button className="chip primary" onClick={重读}>
              重读一遍界面
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="tr-path" title={st?.dir}>
            {st?.dir ?? '在读备份目录…'}
          </div>
          <div className="tr-grid">
            <div>
              <span>今天（{今天}）</span>
              <b>{st?.hasToday ? '已经备过一份' : '还没备'}</b>
            </div>
            <div>
              <span>保留名额</span>
              <b>{st?.keep ?? 7} 份</b>
            </div>
            <div>
              <span>目录里的快照</span>
              <b>{托管.length} 份</b>
            </div>
            <div>
              <span>满 30 天待砍的</span>
              <b>
                {st?.pending.revisions ?? 0} 版 / {st?.pending.entries ?? 0} 篇
              </b>
            </div>
          </div>

          <p className="tr-hint">
            一份 = 一天：开应用时如果当天还没有那一份，就用 <code>VACUUM INTO</code>{' '}
            落一份，然后把超出名额的最旧的删掉。走的是连接自己，所以{' '}
            <code>-wal</code> 里那些还没回写主文件的改动也在里面。
            {!enabled && ' 自动那一跑现在是关着的，只有下面那颗按钮会落份。'}
          </p>
          <p className="tr-hint">
            「满 30 天待砍的」指的是历史版本与回收站：超过 30 天的那一些会在开应用时自动清掉，
            但只在<strong>当天那一份已经在目录里</strong>的时候动手——那一刀的回退路径就是它，
            所以自动备份关着、或那一份没落成的时候它就跟着不跑。界面上「跑一次那一刀」
            这颗按钮不受这一条管，那是你当场下的令。彻底删除一直是同一把刀。
          </p>

          <ul className="tr-list bk-list">
            {托管.map((s) => (
              <li key={s.name} className="bk-row">
                <span className="bk-name" title={s.name}>
                  {s.name}
                </span>
                <span className="bk-meta">
                  {s.kind === 'manual' ? '手动 · ' : ''}
                  {s.at}
                </span>
                <span className="bk-meta">
                  {s.entries === null ? '数不出来' : `${s.entries} 篇`}
                </span>
                <span className="bk-meta">{(s.size / MB).toFixed(2)} MB</span>
                <button className="chip" disabled={busy} onClick={() => void to(s)}>
                  换到这一份
                </button>
              </li>
            ))}
            {托管.length === 0 && <li className="bk-row">一份都还没有。</li>}
            {自保.map((s) => (
              <li key={s.name} className="bk-row bk-before">
                <span className="bk-name" title={s.name}>
                  {s.name}
                </span>
                <span className="bk-meta">换库之前的自保 · {s.at}</span>
                <span className="bk-meta">
                  {s.entries === null ? '数不出来' : `${s.entries} 篇`}
                </span>
                <span className="bk-meta">{(s.size / MB).toFixed(2)} MB</span>
                <button className="chip" disabled={busy} onClick={() => void to(s)}>
                  换到这一份
                </button>
              </li>
            ))}
          </ul>
          {自保.length > 0 && (
            <p className="tr-hint">
              上面那几份 <code>before-restore</code> 不参与滚动保留：它们是「换错了」那一档的退路，
              自动删掉它等于把恢复变成单向门。要腾地方请自己动手。
            </p>
          )}

          <div className="tr-foot">
            <label className="bk-switch" title="关掉之后开应用不再自动落份">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  void patchSettings({ backupEnabled: e.target.checked }).then(() => void 取())
                }}
              />
              每天自动备份
            </label>
            <button className="chip" disabled={busy} onClick={() => void cut()}>
              跑一次 30 天那一刀
            </button>
            <button className="chip primary" disabled={busy} onClick={() => void now()}>
              {busy ? '正在写…' : '立即备份一份'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function m(e: unknown): string {
  const t = e instanceof Error ? e.message : String(e)
  return t.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}
