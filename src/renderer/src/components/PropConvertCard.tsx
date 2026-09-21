/** 「改属性类型」的确认弹层（期-02-设计 §3.2 末段）。
 *
 *  名字与类型的绑定是全局的，所以这一按改的不是当前这一篇，而是**全库所有条目**的
 *  同名属性：能转换的按新类型重写，不能转换的删键。动手前先把这两个数字和前三条
 *  样本摊开给人看——「按完发现少了一批值」是这一处唯一真正的坑。
 *
 *  被丢的那些值不是没了：动手前每一篇都先存了一版历史（`reason='manual'`），
 *  恢复那一版就回来（`restoreRevision` 走宽松校验，不会因为这个属性现在换了类型而失败）。 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { PROP_TYPE_LABEL } from '../../../shared/props'
import type { PropConversion } from '../../../shared/types'
import { useStore } from '@/store'

export function PropConvertCard(): JSX.Element | null {
  const target = useStore((s) => s.propConvert)
  const report = useStore((s) => s.propConvertReport)
  const close = useStore((s) => s.setPropConvert)
  const apply = useStore((s) => s.applyPropType)

  const [conv, setConv] = useState<PropConversion | null>(null)

  // 每点一个 (属性, 新类型) 都重数一遍代价。依赖只写这两个字段：
  // 跟着 propKeys 变的话，用户正在读数字时后台刷了登记表，数字会闪一下重算
  useEffect(() => {
    if (!target) return
    setConv(null)
    let alive = true
    void report(target.name, target.to).then((r) => {
      if (alive) setConv(r)
    })
    return () => {
      alive = false
    }
  }, [target?.name, target?.to, report])

  if (!target) return null

  return (
    <div className="sheet open" onClick={() => close(null)}>
      <div
        className="sheet-card rename-card"
        role="dialog"
        aria-modal="true"
        aria-label={`把 ${target.name} 改为${PROP_TYPE_LABEL[target.to]}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h3>
              {target.name} → {PROP_TYPE_LABEL[target.to]}
            </h3>
            <p>同名属性在所有条目里同一个类型，所以这一次过的是全库</p>
          </div>
          <button className="close-x" onClick={() => close(null)}>
            ×
          </button>
        </div>

        {conv === null ? (
          <div className="empty-hint">正在数会被改动的值…</div>
        ) : (
          <div className="kv">
            <div className="kv-row">
              <span>能转换</span>
              <b className="mono">{conv.convertible} 个</b>
            </div>
            <div className="kv-row">
              <span>会被丢掉</span>
              <b className="mono">{conv.dropped} 个</b>
            </div>
            {conv.samples.length > 0 && (
              <div className="empty-hint">
                会被丢的是这类写法：{conv.samples.join('、')}
              </div>
            )}
            <div className="empty-hint">
              丢掉的值仍然留在每一篇的历史版本里，恢复那一版就回来。
            </div>
          </div>
        )}

        <div className="card-actions">
          <button className="chip" onClick={() => close(null)}>
            取消
          </button>
          <button
            className="chip primary"
            disabled={conv === null}
            onClick={() => void apply(target.name, target.to)}
          >
            改类型
          </button>
        </div>
      </div>
    </div>
  )
}
