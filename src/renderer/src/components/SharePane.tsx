/** 分享那一档（期-11a §五）：当前这一篇 → 一个能双击打开的 .html。
 *
 *  界面上那三句不是装饰，是三条**做错了收不回来**的事，所以写在按钮旁边而不是设计稿里：
 *   · 「发给谁内容就归谁了」——这个应用不联网，也没有链接有效期与加密；文件一出这道门就完全在对面的地盘上。
 *   · 「没有一行 JavaScript」——它是只读的，交互式的东西（点链接、折叠、跑查询）一样都没有。
 *   · 「用的是系统字体」——不带走那 1 MB 的 KaTeX 字体与 920 KB 的 Maple Mono（M3 量的数），
 *     所以看起来与应用里会有差别。这一条宁可提前说，不要让人撞见。
 *
 *  落点与账都是**导完再报**：真正判「能不能写」的是主进程落盘前那一遍 `自检()`，
 *  这里提前算的那一份只是给人看的预估。 */

import { useState, type JSX } from 'react'
import { useStore } from '@/store'
import { 导出去, 会叫这个名字, 本地时刻, type 分享的账 } from '@/share'

const MB = 1024 * 1024

export function SharePane({ open, onBusy }: { open: boolean; onBusy: (b: boolean) => void }): JSX.Element | null {
  const notify = useStore((s) => s.notify)
  const patchSettings = useStore((s) => s.patchSettings)
  const 上次 = useStore((s) => s.settings.shareLastDir)
  const 标题 = useStore((s) => s.title)
  const 模式 = useStore((s) => s.editorMode)
  const entry = useStore((s) => s.entry)

  const [err, setErr] = useState<string | null>(null)
  const [账, set账] = useState<分享的账 | null>(null)

  if (!open) return null

  const 显示名 = (标题 || (entry ? 本地时刻(new Date(entry.entryDate)).slice(0, 10) : '未命名')).trim()

  async function 导到(dir: string): Promise<void> {
    setErr(null)
    onBusy(true)
    try {
      const r = await 导出去(dir)
      set账(r)
      // 先落这一格再报成功：下一次「还放那个夹」靠它，而「放哪儿了」这句话总得有个地方能查
      void patchSettings({ shareLastDir: dir })
      notify(`写好了：${r.file.split(/[\\/]/).pop()}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      onBusy(false)
    }
  }

  async function 导(): Promise<void> {
    setErr(null)
    const dir = await window.kestrel.transfer.pickDirectory('share')
    if (dir) await 导到(dir)
  }

  return (
    <div className="tr-body">
      {err && <div className="tr-err">{err}</div>}

      <p className="tr-hint">
        把<strong>屏幕上这一篇</strong>写成一个 <code>.html</code>：公式、图、Mermaid 那张图、代码的颜色、
        查询块那一刻的数，全在这一个文件里。<strong>没有旁边的 assets 夹，没有 JavaScript，不发任何请求</strong>
        ——断网、换台机器、发给谁都照样打开。
      </p>

      {账 ? (
        <>
          <div className="tr-path" title={账.file}>
            {账.file}
          </div>
          <div className="tr-grid">
            <div>
              <span>大小</span>
              <b>{账.bytes > MB ? `${(账.bytes / MB).toFixed(2)} MB` : `${(账.bytes / 1024).toFixed(1)} KB`}</b>
            </div>
            <div>
              <span>用时</span>
              <b>{账.ms} ms</b>
            </div>
            <div>
              <span>内联的图</span>
              <b>{账.内联} 张{账.缺图.length ? `（${账.缺图.length} 张没带出来）` : ''}</b>
            </div>
            <div>
              <span>公式</span>
              <b>{账.公式} 处（MathML）</b>
            </div>
            <div>
              <span>双链 / 标签</span>
              <b>
                {账.双链} 处落成文字{账.悬空 ? `，其中 ${账.悬空} 条在这个库里指不到` : ''}
              </b>
            </div>
            <div>
              <span>带走的样式</span>
              <b>
                {账.样式.规则数} 条 / {账.样式.KB} KB / {账.样式.变量数} 个变量
              </b>
            </div>
            <div>
              <span>清掉的编辑面</span>
              <b>{Object.entries(账.清掉的).map(([k, v]) => `${k} ${v}`).join(' · ') || '没什么可清'}</b>
            </div>
            <div>
              <span>查询块</span>
              <b>{账.查询块 ? `${账.查询块} 块，都标了「数截止于」` : '这一篇没有'}</b>
            </div>
          </div>
          {账.名字改了 && (
            <p className="set-note">那个夹里已经有一个同名的了 ⇒ 这一份落成了带 <code>·2</code> 的新名字，旧的那一份没动。</p>
          )}
          {账.缺图.length > 0 && (
            <p className="set-note">
              有几张图没带出来（字节不在这台机器上）。产物里那几处是<strong>一行说明</strong>，不是碎图——
              宁缺不烂。
            </p>
          )}
          <p className="set-note">
            再导一次就是再写一个文件。库里<strong>没有记「分享过什么」</strong>：这一档与导出同级，出去的东西不归库管。
          </p>
        </>
      ) : (
        <>
          <div className="set-path">
            会写成：<code>{会叫这个名字(显示名)}</code>
          </div>
          {模式 === 'source' && (
            <p className="tr-err">
              现在是源码模式，这一档要的是<strong>已经画好的那一棵树</strong>：先切回所见即所得（Ctrl+Shift+M）。
              公式、Mermaid、代码颜色、查询结果都是那一档才渲出来的，源码模式那一边根本没有它们。
            </p>
          )}
        </>
      )}

      <div className="set-actions">
        <button className="btn primary" disabled={模式 === 'source'} onClick={() => void 导()}>
          导出这一篇
        </button>
        {上次 && (
          <button className="btn" disabled={模式 === 'source'} onClick={() => void 导到(上次)}>
            还放那个夹
          </button>
        )}
      </div>
      {上次 && (
        <div className="set-path" title={上次}>
          上次放在：<code>{上次}</code>
        </div>
      )}

      <p className="set-note">
        导出的是<strong>屏幕上这一份</strong>——还没落盘的改动也在里面。
        <br />这个文件<strong>发给谁，内容就归谁了</strong>：这一档不联网，也就没有"链接有效期""撤销分享"那一说。
        <br />里面<strong>没有一行 JavaScript</strong>，所以也点不动：不能折叠、不能跳链、查询结果不会再刷新。
        <br />样式是从应用里现取的那一份，但<strong>不带走字体</strong>（那要 1 MB 多）——看起来与应用里会有差别。
      </p>
    </div>
  )
}
