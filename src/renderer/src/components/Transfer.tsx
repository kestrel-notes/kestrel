/** 导出向导（期-08 §一、§九）。三步：选目录 → 看计划 → 写出去。
 *
 *  「看计划」这一步不是仪式感：导出会**覆盖**目标目录里的同名文件，而会不会有文件被改名
 *  （NTFS 大小写不敏感，`Note.md` 与 `note.md` 撞）只有算过才知道。所以先把账摆出来，
 *  让人点确认，而不是点完再看日志。
 *
 *  属性名撞上 `kestrel-*` 那一档在这里是**红字 + 按钮禁用**：`export.ts` 会抛，
 *  但抛之前那份计划里已经列出了是哪一篇的哪个属性——与其等用户点确认才知道要改什么，
 *  不如当场说清（设计稿口径 ①：不自动改名）。 */

import { useEffect, useRef, useState, type JSX } from 'react'
import { useStore } from '@/store'
import type { ExportPlan, ExportResult } from '../../../shared/types'

type Step = 'pick' | 'plan' | 'run' | 'done'

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function Transfer(): JSX.Element | null {
  const open = useStore((s) => s.transferOpen)
  const setOpen = useStore((s) => s.setTransferOpen)
  const notify = useStore((s) => s.notify)
  const flush = useStore((s) => s.flush)
  const lastDir = useStore((s) => s.settings.exportLastDir)
  const patchSettings = useStore((s) => s.patchSettings)

  const [step, setStep] = useState<Step>('pick')
  const [dir, setDir] = useState<string | null>(null)
  const [plan, setPlan] = useState<ExportPlan | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [done, setDone] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const timer = useRef<number | null>(null)

  // 面板关了就整套重来：留着上一次的目录，下次打开会以为「还要再导一遍」
  useEffect(() => {
    if (!open) {
      setStep('pick')
      setDir(null)
      setPlan(null)
      setResult(null)
      setDone(0)
      setErr(null)
      setBusy(false)
      setStopping(false)
    }
  }, [open])

  useEffect(() => () => void (timer.current && window.clearInterval(timer.current)), [])

  async function choose(to?: string): Promise<void> {
    setErr(null)
    const picked = to ?? (await window.kestrel.transfer.pickDirectory())
    if (!picked) return
    setDir(picked)
    setStep('plan')
    setPlan(null)
    setBusy(true)
    try {
      // 防抖里最后一次编辑还没落库，导出来的就是上一版——先冲一次
      await flush()
      setPlan(await window.kestrel.transfer.exportPlan(picked))
    } catch (e) {
      setErr(msg(e))
      setStep('pick')
    } finally {
      setBusy(false)
    }
  }

  async function start(): Promise<void> {
    if (!dir) return
    setErr(null)
    setStep('run')
    setDone(0)
    setStopping(false)
    // 进度是拉的：run 每 200 篇让出一次事件循环，所以这个定时器拿得到中间值
    timer.current = window.setInterval(() => {
      void window.kestrel.transfer
        .exportProgress()
        .then((p) => setDone(p.done))
        .catch(() => undefined)
    }, 240)
    try {
      const r = await window.kestrel.transfer.exportRun(dir)
      setResult(r)
      setStep('done')
      setStopping(false)
      // 中止那一次不记：目录里是半成品，「上次导到这儿」会指着半成品
      if (!r.aborted) void patchSettings({ exportLastDir: dir })
      notify(
        r.aborted
          ? `已中止：写了 ${r.written} 篇，那个目录里是半成品`
          : `已导出 ${r.written} 篇到 ${r.dir}`
      )
    } catch (e) {
      setErr(msg(e))
      setStep('plan')
    } finally {
      if (timer.current) window.clearInterval(timer.current)
      timer.current = null
    }
  }

  if (!open) return null

  const total = plan?.entries ?? 0
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0
  const blocked = (plan?.reserved.length ?? 0) > 0

  return (
    <div className="sheet open" onClick={() => setOpen(false)}>
      <div
        className="sheet-card tr-card"
        role="dialog"
        aria-modal="true"
        aria-label="导出整库"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // 写盘写到一半关掉面板，用户会以为「导出取消了」——主进程其实还在往下写，
          // 只是进度看不见了。这一档宁可让人多按一次 Esc。
          if (e.code === 'Escape' && step === 'run') e.stopPropagation()
        }}
      >
        <div className="sheet-head">
          <div>
            <h3>导出为 Markdown</h3>
            <p>目录树 + front-matter，任何编辑器都能读</p>
          </div>
          <button className="close-x" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        <div className="tr-body">
          {err && <div className="tr-err">{err}</div>}

          {step === 'pick' && (
            <>
              <p className="tr-hint">
                选一个目录。导出物长成这样：「diary/2026/09/2026-09-16.md」「topics/主题/文章.md」
                「attachments/」「_kestrel/library.json」。同名的文件会被覆盖，库里的东西不动。
              </p>
              <div className="tr-foot">
                {lastDir && (
                  <button className="chip" title={lastDir} onClick={() => void choose(lastDir)}>
                    还是导到上次那里
                  </button>
                )}
                <button className="chip primary" onClick={() => void choose()}>
                  {busy ? '正在数…' : '选一个目录'}
                </button>
              </div>
              {lastDir && <div className="tr-path" title={lastDir}>{lastDir}</div>}
            </>
          )}

          {(step === 'plan' || step === 'run') && plan && (
            <>
              <div className="tr-path" title={plan.dir}>
                {plan.dir}
              </div>
              <div className="tr-grid">
                <div>
                  <span>条目</span>
                  <b>{plan.entries}</b>
                </div>
                <div>
                  <span>日记 / 文章</span>
                  <b>
                    {plan.diary} / {plan.articles}
                  </b>
                </div>
                <div>
                  <span>正文</span>
                  <b>{mb(plan.bytes)}</b>
                </div>
                <div>
                  <span>文件数</span>
                  <b>{plan.files}</b>
                </div>
                <div>
                  <span>附件（引用 / 在盘 / 缺）</span>
                  <b>
                    {plan.assets.referenced} / {plan.assets.onDisk} / {plan.assets.missing}
                  </b>
                </div>
                <div>
                  <span>外链图片</span>
                  <b>{plan.external}</b>
                </div>
              </div>
              <p className="tr-hint">
                附件这三个数不一样是正常的：「引用」是正文里出现过的，「在盘」是附件目录里的总数，
                「缺」是正文指着但文件已经不在了的。导出只拷被引用到的那些；缺的那几条在导出物里是死链，
                和库里现在一样，一个字都不编。
              </p>

              {plan.renamed.length > 0 && (
                <>
                  <p className="tr-hint">
                    {plan.renamed.length} 篇的名字在 Windows 上会撞车（大小写不算差别），已经改了名：
                  </p>
                  <ul className="tr-list">
                    {plan.renamed.slice(0, 8).map((r) => (
                      <li key={r.entryId} title={r.note}>
                        {r.path}
                      </li>
                    ))}
                    {plan.renamed.length > 8 && <li>…另 {plan.renamed.length - 8} 篇</li>}
                  </ul>
                </>
              )}

              {blocked && (
                <div className="tr-err">
                  {plan.reserved.length} 个属性名与 Kestrel 自己的字段撞了（
                  {[...new Set(plan.reserved.map((r) => r.name))].join('、')}
                  ）。导出会丢掉这些属性，所以直接不导。到属性面板里给它们改个名字再来。
                </div>
              )}

              {step === 'run' ? (
                <>
                  <div className="tr-progress">
                    <i style={{ width: `${pct}%` }} />
                  </div>
                  <div className="tr-foot tr-done">
                    <span className="tr-hint">
                      已写 {done} / {total} 篇
                    </span>
                    <button
                      className="chip"
                      onClick={() => {
                        setStopping(true)
                        void window.kestrel.transfer.exportCancel()
                      }}
                      disabled={stopping}
                    >
                      {stopping ? '正在停下…' : '中止'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="tr-foot">
                  <button className="chip" onClick={() => setStep('pick')}>
                    换个目录
                  </button>
                  <button className="chip primary" disabled={busy || blocked} onClick={() => void start()}>
                    导出 {plan.entries} 篇
                  </button>
                </div>
              )}
            </>
          )}

          {(step === 'plan' || step === 'run') && !plan && !busy && (
            <p className="tr-hint">这份计划还没拿到，重新选一次目录。</p>
          )}

          {step === 'done' && result && (
            <>
              <p className="tr-hint">
                {result.aborted
                  ? `写到 ${result.written} 篇的时候停了，用了 ${(result.ms / 1000).toFixed(1)} 秒。`
                  : `${result.written} 篇、${result.assets} 个附件，共 ${mb(result.bytes)}，用了 ${(result.ms / 1000).toFixed(1)} 秒。`}
              </p>
              <p className="tr-hint">
                {result.aborted
                  ? '那个目录里是半成品：没有 library.json 与 MANIFEST.json，剩下的文件是真的。再导一次会整份盖过去。'
                  : `导出去的那份是副本，库里的东西一个字没动。${result.renamed > 0 ? ` ${result.renamed} 篇被改了名，清单在 _kestrel/MANIFEST.json。` : ''}`}
              </p>
              <div className="tr-path" title={result.dir}>
                {result.dir}
              </div>
              <div className="tr-foot tr-done">
                <button className="chip" onClick={() => setStep('pick')}>
                  再导一次
                </button>
                <button className="chip primary" onClick={() => setOpen(false)}>
                  好了
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
