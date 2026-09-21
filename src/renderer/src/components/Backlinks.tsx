import type { JSX } from 'react'
import type { Backlink, EntryKind } from '../../../shared/types'

/** 分组的顺序与名字。主题暂时不会有作为来源的链接（主题没有正文可写），
 *  但分组先留着——升格与提及进来时会用到。 */
const GROUPS: { kind: EntryKind | null; title: string }[] = [
  { kind: 'diary', title: '日记' },
  { kind: 'article', title: '文章' },
  { kind: null, title: '主题' },
]

const DOT_CLASS: Record<string, string> = {
  diary: 'tip-diary',
  article: 'tip-article',
  topic: 'tip-topic',
}

const KIND_NAME: Record<string, string> = {
  wiki: '双链',
  promotion: '升格',
  mention: '提及',
  embed: '嵌入',
  block: '块引用',
}

export function Backlinks({
  backlinks,
  onOpen,
}: {
  backlinks: Backlink[]
  onOpen: (key: string) => void
}): JSX.Element {
  if (backlinks.length === 0) {
    return (
      <>
        <p className="bl-empty">还没有别的记录指向这里</p>
        <p className="bl-empty bl-hint">
          在别处写 <code>[[这一篇的标题]]</code>，或者写 <code>[[昨天]]</code> 这样的日期，就会连过来。
        </p>
      </>
    )
  }

  return (
    <div className="bl-list">
      {GROUPS.map((group) => {
        const rows = backlinks
          .filter((b) => (group.kind === null ? b.sourceKind === null : b.sourceKind === group.kind))
          .sort((a, b) => (b.sourceDate ?? '').localeCompare(a.sourceDate ?? ''))
        if (rows.length === 0) return null

        return (
          <div key={group.title}>
            <div className="bl-sub">
              {group.title} · {rows.length}
            </div>
            {rows.map((b) => (
              <button
                key={b.linkId}
                type="button"
                className="bl"
                onClick={() => onOpen(b.sourceKey)}
                title={`跳到「${b.sourceLabel}」`}
              >
                <span className="bl-top">
                  <span className={`bl-dot ${DOT_CLASS[group.kind ?? 'topic']}`} />
                  <span className="bl-h">{b.sourceLabel}</span>
                  <span className={`bl-m k-${b.kind}`}>{KIND_NAME[b.kind] ?? '链接'}</span>
                </span>
                {b.context && <span className="bl-ctx">{b.context}</span>}
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}