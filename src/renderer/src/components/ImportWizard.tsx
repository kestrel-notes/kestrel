/** 反向导入向导（期-08 §三、§九）。四档：选目录 → 看账 → 写进库 → 回话。
 *
 *  这一档真正要说清的是**「哪几篇会被盖掉」**：写进去是改库，改错了不能靠记忆回退。
 *  所以账面上「新建 / 覆盖 / 原样不动」是三个分开的数，覆盖那一档额外说明
 *  「盖之前先存一版历史」——它就在右栏「历史版本」里，回退的路是通的。
 *
 *  「认不出来的」也要当场报：那多半是选错了目录。设计稿口径 ⑥ 是不做任何猜测式导入，
 *  所以这里只有「这些文件一个字都不读」，没有「要不要试着按文件名猜一猜」。 */

import { useEffect, useRef, useState, type JSX } from 'react'
import { useStore } from '@/store'
import type { ImportPlan, ImportResult } from '../../../shared/types'

type Step = 'pick' | 'plan' | 'run' | 'done'

export function ImportWizard({
  open,
  onBusy,
}: {
  open: boolean
  /** 告诉外层「我正在写库」——那时候 Esc 不该把面板关掉（见 `Transfer.tsx`） */
  onBusy(busy: boolean): void
}): JSX.Element | null {
  const setOpen = useStore((s) => s.setTransferOpen)
  const notify = useStore((s) => s.notify)
  const flush = useStore((s) => s.flush)
  const lastDir = useStore((s) => s.settings.importLastDir)
  const patchSettings = useStore((s) => s.patchSettings)

  const [step, setStep] = useState<Step>('pick')
  const [dir, setDir] = useState<string | null>(null)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [done, setDone] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const timer = useRef<number | null>(null)

  // 面板关了就整套重来：留着上一次的目录，下次打开会以为「还要再导一遍」
  useEffect(() => {
    if (open) return
    setStep('pick')
    setDir(null)
    setPlan(null)
    setResult(null)
    setDone(0)
    setErr(null)
    setBusy(false)
    setStopping(false)
  }, [open])

  useEffect(() => onBusy(step === 'run'), [step, onBusy])
  useEffect(() => () => void (timer.current && window.clearInterval(timer.current)), [])

  async function choose(to?: string): Promise<void> {
    setErr(null)
    const picked = to ?? (await window.kestrel.transfer.pickDirectory('import'))
    if (!picked) return
    setDir(picked)
    setStep('plan')
    setPlan(null)
    setBusy(true)
    try {
      // 「覆盖 0」是按库现在的样子算的。防抖里最后一次编辑还没落库，算出来的账就是上一版
      await flush()
      setPlan(await window.kestrel.transfer.importPlan(picked))
    } catch (e) {
      setErr(m(e))
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
    // 进度是拉的：run 每 100 篇让出一次事件循环，所以这个定时器拿得到中间值
    timer.current = window.setInterval(() => {
      void window.kestrel.transfer
        .importProgress()
        .then((p) => setDone(p.done))
        .catch(() => undefined)
    }, 240)
    try {
      const r = await window.kestrel.transfer.importRun(dir)
      setResult(r)
      setStep('done')
      setStopping(false)
      // 中止那一次不记：库只写进去一半，「上次从这儿导的」会指着半截
      if (!r.aborted) void patchSettings({ importLastDir: dir })
      notify(
        r.aborted
          ? `已中止：写进库 ${r.created + r.updated} 篇，界面还没刷新`
          : `已导回 ${r.created + r.updated} 篇，跳过 ${r.skipped} 篇`
      )
    } catch (e) {
      setErr(m(e))
      setStep('plan')
    } finally {
      if (timer.current) window.clearInterval(timer.current)
      timer.current = null
    }
  }

  // 导入直接改了库，而左栏/右栏/编辑器里全是导入前读进来的那一份。
  // 逐块刷新要动的地方比这一句多，而且漏一块就是「界面说瞎话」——所以整页重读。
  function reload(): void {
    setOpen(false)
    void flush().finally(() => window.location.reload())
  }

  if (!open) return null

  const total = plan?.ours ?? 0
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0
  const writes = (plan?.creates ?? 0) + (plan?.updates ?? 0)

  return (
    <div className="tr-body">
      {err && <div className="tr-err">{err}</div>}

      {step === 'pick' && (
        <>
          <p className="tr-hint">
            选一个 Kestrel 导出的目录。认人的是包头里的 <code>kestrel-id</code>
            ：旁人不认——不是 Kestrel 导出的东西一个字都不读，也不拿文件名猜日期、猜标题。
            库里已有的、文件里更旧的那些原样不动；要盖掉的每一篇，盖之前先存一版历史。
          </p>
          <div className="tr-foot">
            {lastDir && (
              <button className="chip" title={lastDir} onClick={() => void choose(lastDir)}>
                还是从上次那个目录
              </button>
            )}
            <button className="chip primary" disabled={busy} onClick={() => void choose()}>
              {busy ? '正在数…' : '选一个目录'}
            </button>
          </div>
          {lastDir && (
            <div className="tr-path" title={lastDir}>
              {lastDir}
            </div>
          )}
        </>
      )}

      {(step === 'plan' || step === 'run') && plan && (
        <>
          <div className="tr-path" title={plan.dir}>
            {plan.dir}
          </div>
          <div className="tr-grid">
            <div>
              <span>扫到的 md</span>
              <b>{plan.files}</b>
            </div>
            <div>
              <span>认得出是自家的</span>
              <b>{plan.ours}</b>
            </div>
            <div>
              <span>新建</span>
              <b>{plan.creates}</b>
            </div>
            <div>
              <span>覆盖（先存一版历史）</span>
              <b>{plan.updates}</b>
            </div>
            <div>
              <span>原样不动</span>
              <b>{plan.skips}</b>
            </div>
            <div>
              <span>认不出来的</span>
              <b>{plan.foreign}</b>
            </div>
            <div>
              <span>附件（引用 / 在盘 / 缺）</span>
              <b>
                {plan.assets.referenced} / {plan.assets.present} / {plan.assets.missing}
              </b>
            </div>
            <div>
              <span>库里带的（主题 / 存查询 / 模板）</span>
              <b>
                {plan.library.topics} / {plan.library.savedQueries} / {plan.library.templates}
              </b>
            </div>
          </div>

          <p className="tr-hint">
            「原样不动」有三种：库里那一版比文件新、id 对不上但那天已有一篇日记，以及同一个 id
            在这个目录里出现了两次（一个目录放了两份导出物）——
            前两种让文件去盖，等于拿旧内容毁掉新的，所以不盖。
            {' '}
            还有：这一档的正路是导进<b>空库</b>（或先清空）。包头里的 <code>kestrel-id</code>
            就是库里的行号，往一个已经有内容的库里导，两边历史不一样就会错号——
            被认成「覆盖」的那几篇盖之前都会先存一版历史，退得回去，但那不是「恢复备份」。
            {plan.foreign > 0 &&
              ` 认不出的 ${plan.foreign} 个（${plan.foreignNames.join('、')}${plan.foreign > plan.foreignNames.length ? '…' : ''}）会整个跳过。`}
          </p>

          {plan.newTopics.length > 0 && (
            <p className="tr-hint">
              会新建 {plan.newTopics.length} 个主题：{plan.newTopics.slice(0, 8).join('、')}
              {plan.newTopics.length > 8 && `…`}
            </p>
          )}
          {plan.newPropKeys.length > 0 && (
            <p className="tr-hint">
              会登记 {plan.newPropKeys.length} 个新属性名：{plan.newPropKeys.slice(0, 8).join('、')}
              {plan.newPropKeys.length > 8 && `…`}
              （类型优先照 _kestrel/MANIFEST.json 里那份登记表，没有才按值猜）
            </p>
          )}

          {plan.errorCount > 0 && (
            <>
              <p className="tr-hint">
                有 {plan.errorCount} 处不照它写，那些不进库，剩下的照导：
              </p>
              <ul className="tr-list">
                {plan.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </>
          )}

          {step === 'run' ? (
            <>
              <div className="tr-progress">
                <i style={{ width: `${pct}%` }} />
              </div>
              <div className="tr-foot tr-done">
                <span className="tr-hint">
                  已读 {done} / {total} 篇
                </span>
                <button
                  className="chip"
                  onClick={() => {
                    setStopping(true)
                    void window.kestrel.transfer.importCancel()
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
              <button
                className="chip primary"
                disabled={busy || writes === 0}
                title={writes === 0 ? '没有要写的：库里已经是这些内容了' : undefined}
                onClick={() => void start()}
              >
                {writes === 0 ? '没有要写的' : `导回 ${writes} 篇`}
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
              ? `读到一半停了：新建 ${result.created} 篇、覆盖 ${result.updated} 篇，用了 ${(result.ms / 1000).toFixed(1)} 秒。`
              : `新建 ${result.created} 篇、覆盖 ${result.updated} 篇、跳过 ${result.skipped} 篇，用了 ${(result.ms / 1000).toFixed(1)} 秒。`}
          </p>
          <p className="tr-hint">
            顺手回来的还有 {result.assets} 个附件、{result.topics} 个主题、{result.propKeys} 个属性名。
            {result.aborted
              ? ' 停住的那一处不会留下半篇：每一篇各走一遍正常的保存通道。'
              : ' 导出物里没有的条目，库里照旧留着——导入只增不改删。'}
          </p>
          {result.errors.length > 0 && (
            <>
              <p className="tr-hint">这 {result.errors.length} 处没照原样回来，都是逐条报出来的：</p>
              <ul className="tr-list">
                {result.errors.slice(0, 40).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </>
          )}
          <div className="tr-path" title={result.dir}>
            {result.dir}
          </div>
          <div className="tr-foot tr-done">
            <button className="chip" onClick={() => setStep('pick')}>
              再导一次
            </button>
            <button className="chip primary" onClick={reload}>
              好了（重新读一遍库）
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function m(e: unknown): string {
  const t = e instanceof Error ? e.message : String(e)
  // IPC 的拒绝自带一层「Error invoking remote method 'import:plan': Error: 」，
  // 而主进程抛出来的那一句本来就是给人看的整句人话——那一层前缀只会把它切断
  return t.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}
