/** 右栏的属性面板（期-02-设计 §3.2）。
 *
 *  一行 = 属性名 + 按类型的控件 + 删除。名字与类型的绑定是**全局**的（`PropKey`），
 *  所以这里选的「是什么类型」管的是所有条目，改之前先弹确认（`PropConvertCard`）。
 *
 *  写完一次落一次库：属性不跟着正文那条 500ms 防抖走，它是一次独立的
 *  `update(id, { props })`。好处是「改完就没了/有了」当场见分晓，也绕开了
 *  整块替换时把防抖里那份正文一起写坏的风险。 */

import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { PROP_TYPES, PROP_TYPE_LABEL, normalizePropKey, stringifyPropValue } from '../../../shared/props'
import type { PropValue } from '../../../shared/props'
import type { PropType } from '../../../shared/types'
import { useStore } from '@/store'
import { RailBlock } from '@/components/RailBlock'

export function PropsPanel(): JSX.Element | null {
  const entry = useStore((s) => s.entry)
  const propKeys = useStore((s) => s.propKeys)
  const setProp = useStore((s) => s.setProp)
  const putPropKey = useStore((s) => s.putPropKey)
  const setPropConvert = useStore((s) => s.setPropConvert)
  const refreshPropKeys = useStore((s) => s.refreshPropKeys)
  const openPropSide = useStore((s) => s.openPropSide)

  /** 刚加出来、还没落值的那一行。空值不落库（§3.2），所以它只能活在这一刻：
   *  一旦有了值就并进 `entry.props`，切了文档就作废 */
  const [pending, setPending] = useState<{ name: string; type: PropType } | null>(null)
  const [adding, setAdding] = useState(false)

  // 挂载时读一次登记表：主进程正是在这一次读里把 props 里没登记过的名字补上的（§4.3）
  useEffect(() => {
    void refreshPropKeys()
  }, [refreshPropKeys])

  useEffect(() => {
    setPending(null)
    setAdding(false)
  }, [entry?.id])

  if (!entry) return null

  const ordinalOf = (name: string): number =>
    propKeys.find((k) => k.name === name)?.ordinal ?? Number.MAX_SAFE_INTEGER
  const typeOf = (name: string): PropType =>
    propKeys.find((k) => k.name === name)?.type ?? 'text'

  const names = Object.keys(entry.props).sort(
    (a, b) => ordinalOf(a) - ordinalOf(b) || a.localeCompare(b, 'zh-Hans')
  )
  // 新加的那个还没有值，所以它不在 names 里——但行要在，否则「添加」按完什么都没发生
  const shown = pending && !(pending.name in entry.props) ? [...names, pending.name] : names

  return (
    <RailBlock title="属性" count={shown.length} foldable defaultOpen resetKey={entry.id}>
      <div className="kv">
        {shown.length === 0 && !adding && (
          <div className="empty-hint">这一篇还没有属性。 mood、done、评分这类可以按类型存下来，下面加一个。</div>
        )}
        {shown.map((name) => (
          <PropRow
            key={name}
            name={name}
            type={typeOf(name)}
            raw={entry.props[name]}
            onSet={setProp}
            onView={openPropSide}
          />
        ))}

        {adding ? (
          <AddRow
            registered={propKeys}
            own={names}
            onAdd={async (name, type) => {
              const known = propKeys.find((k) => k.name === name)
              if (known && known.type !== type) {
                // 同名已经在别的条目上定了类型：这一改过的是全库，必须再问一遍
                setPropConvert({ name, to: type })
              } else {
                if (!known) await putPropKey(name, type)
                setPending({ name, type: known?.type ?? type })
              }
              setAdding(false)
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button className="prop-add" onClick={() => setAdding(true)}>
            ＋ 添加属性
          </button>
        )}
      </div>
    </RailBlock>
  )
}

function PropRow({
  name,
  type,
  raw,
  onSet,
  onView,
}: {
  name: string
  type: PropType
  raw: unknown
  onSet: (name: string, value: PropValue | null) => Promise<void>
  /** 跳到侧栏「属性」格，落在这个属性的值分组上（§3.2 末段、§10 第 8 项） */
  onView: (name: string) => void
}): JSX.Element {
  const remove = (): void => void onSet(name, null)

  return (
    <div className={`prop-row ${type === 'list' ? 'stack' : ''}`}>
      <span className="prop-name" title={`${name} · ${PROP_TYPE_LABEL[type]}`}>
        {name}
      </span>
      <div className="prop-val">
        {type === 'checkbox' ? (
          <input
            type="checkbox"
            checked={raw === true}
            onChange={(e) => void onSet(name, e.target.checked)}
          />
        ) : type === 'list' ? (
          <ListInput raw={raw} onCommit={(v) => onSet(name, v)} />
        ) : (
          <ValueInput type={type} raw={raw} onCommit={(v) => onSet(name, v)} />
        )}
        {/* 与删除同一条「悬停/焦点进到这一行才现形」的规矩，见 app.css 的 .mini-x, .prop-drill。
            放在值这一侧而不是紧挨属性名：list 那行是竖排的（名字在上、值在下），
            夹在中间会多出一行只有它自己的空隙 */}
        <button
          className="prop-drill"
          onClick={() => onView(name)}
          aria-label={`在侧栏按 ${name} 看全库`}
          title={`按 ${name} 看全库`}
        >
          ↳
        </button>
        <button className="mini-x" onClick={remove} aria-label={`删掉 ${name}`} title="删掉这个属性">
          ×
        </button>
      </div>
    </div>
  )
}

/** 标量那一档：文本 / 数字 / 日期 / 日期时间。
 *
 *  草稿留在本地，敲完（失焦或回车）才落库——`number` 输入框里半截的 `'-'`、
 *  `date` 里选了一半的 `2026-0` 都过不了主进程那道严格校验（§4.4），
 *  一边敲一边发只会让状态栏一直红着。 */
function ValueInput({
  type,
  raw,
  onCommit,
}: {
  type: PropType
  raw: unknown
  onCommit: (value: string) => Promise<void>
}): JSX.Element {
  const seed = raw === undefined || raw === null ? '' : stringifyPropValue(raw)
  const [draft, setDraft] = useState(seed)
  const [bad, setBad] = useState(false)
  const box = useRef<HTMLInputElement>(null)
  // 库里那份变了才跟过去：包括主进程把 `' 平静 '` 收成 `'平静'`、
  // 把 `'2026-09-19 08:30:00'` 规范成 `'2026-09-19T08:30'` 这两种「你写的没被原样存下」
  useEffect(() => setDraft(seed), [seed])

  const commit = (): void => {
    // 数字框会把 `'1e999'`、日期框会把选了一半的值吞成空串（`validity.badInput`），
    // 这时提交等于删键——用户以为存了个非法值，实际那一行整个没了。拦在本地，别去撞主进程那道
    if (box.current?.validity.badInput) {
      setBad(true)
      return
    }
    setBad(false)
    if (draft !== seed) void onCommit(draft)
  }

  return (
    <>
      <input
        ref={box}
        className={`prop-input ${bad ? 'bad' : ''}`}
        aria-invalid={bad || undefined}
        type={type === 'number' ? 'number' : type === 'date' ? 'date' : type === 'datetime' ? 'datetime-local' : 'text'}
        step={type === 'number' ? 'any' : undefined}
        value={draft}
        placeholder={type === 'number' ? '数字' : '填一个值'}
        onChange={(e) => {
          setDraft(e.target.value)
          setBad(false)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
      />
      {bad && <span className="prop-flag">这个值存不进{PROP_TYPE_LABEL[type]}，没有改动</span>}
    </>
  )
}

function ListInput({
  raw,
  onCommit,
}: {
  raw: unknown
  onCommit: (value: string[]) => Promise<void>
}): JSX.Element {
  const items = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  const [draft, setDraft] = useState('')

  const add = (): void => {
    const v = draft.trim()
    setDraft('')
    if (!v || items.includes(v)) return
    void onCommit([...items, v])
  }

  return (
    <div className="prop-list">
      {items.length > 0 && (
        <div className="tag-list">
          {items.map((v) => (
            <span className="tag" key={v}>
              {v}
              <button
                className="mini-x"
                aria-label={`去掉 ${v}`}
                onClick={() => void onCommit(items.filter((x) => x !== v))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className="prop-input"
        value={draft}
        placeholder="打完回车成为一项"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={add}
      />
    </div>
  )
}

/** 「＋ 添加属性」那两行：名字 + 类型。
 *
 *  三件事共用这一个入口，分开看：
 *  - 名字没见过 → **添加**（登记 + 给这一篇开一行）
 *  - 名字见过、这一篇还没有它 → **添加**（只开行，类型跟着登记表走）
 *  - 名字见过、选的类型与登记的不一样 → **改类型**（过的是全库，走 `PropConvertCard` 确认） */
function AddRow({
  registered,
  own,
  onAdd,
  onCancel,
}: {
  registered: { name: string; type: PropType }[]
  /** 当前这一篇已经有值的属性名 */
  own: string[]
  onAdd: (name: string, type: PropType) => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [type, setType] = useState<PropType>('text')

  const key = normalizePropKey(name)
  const known = key === null ? undefined : registered.find((k) => k.name === key)
  const sameType = known !== undefined && known.type === type
  const dup = sameType && key !== null && own.includes(key)
  const ready = key !== null && !dup

  return (
    <div className="prop-row stack">
      <input
        className="prop-input"
        autoFocus
        value={name}
        placeholder="属性名（如 mood）"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (key !== null && ready) void onAdd(key, type)
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="prop-add-line">
        <select className="prop-select" value={type} onChange={(e) => setType(e.target.value as PropType)}>
          {PROP_TYPES.map((t) => (
            <option key={t} value={t}>
              {PROP_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <button
          className="chip primary"
          disabled={!ready}
          onClick={() => key !== null && void onAdd(key, type)}
        >
          {known && !sameType ? '改类型' : '添加'}
        </button>
      </div>
      {key === null && name.trim() !== '' && (
        <div className="empty-hint">这个名字不能含 . " 或反斜杠</div>
      )}
      {dup && <div className="empty-hint">这一篇已经有它了</div>}
    </div>
  )
}
