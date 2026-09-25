import type { JSX } from 'react'
import type { Backlink, EntryKind, MentionHit, MentionList } from '../../../shared/types'

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

const 那串字是哪来的: Record<MentionHit['经'], string> = {
  title: '标题',
  date: '日期',
  alias: '别名',
}

/** 未链接提及那一组（期-05e §十三）。
 *
 *  三条界面上的硬规矩：
 *  1. **它算过一次才算第二次**：`mentions === null` 是"还没算过"，那时候不闪一个空态骗人；
 *  2. 空态要说**找了哪几个词**，只说"没有"没人信（真库里今天就是这一种情形）；
 *  3. 「连上」只动那一处。整组标题把代价写明白，用户才知道点下去会发生什么。 */
function Mentions({
  列,
  onOpen,
  onLink,
}: {
  列: MentionList | null
  onOpen: (key: string) => void
  onLink: (问: MentionHit) => void
}): JSX.Element | null {
  if (!列) return null
  const 针句 = 列.针.map((r) => `「${r.串}」`).join('、')
  const 总数 = 列.命中.length + 列.还有
  return (
    <div className="mt-group">
      <div className="bl-sub mt-sub">
        <span>未链接提及 · {总数}</span>
        <span className="mt-cost" title="这一组不落库：开这一篇现算一次，写完就扔">
          {列.ms < 1 ? '<1' : Math.round(列.ms)} ms 现算
        </span>
      </div>
      {列.命中.length === 0 ? (
        <p className="bl-empty">
          别处没有把 {针句} 平写出来过
          <span className="bl-hint">
            {' '}
            · 找的就是这几个词（标题与别名各算一遍），连一个都算上了也不会藏
          </span>
        </p>
      ) : (
        列.命中.map((h) => {
          const 后 = h.行内位 + h.串.length
          const 对得上 = h.行.slice(h.行内位, 后) === h.串
          const 跳 = () => onOpen(h.点)
          return (
            <div key={`${h.id}:${h.绝对位}`} className="mt-row">
              {/* 两行两行地摆，而不是"一行两栏"：那颗「连上」压在右边一栏会把下面那行
                  上下文挤掉四十来像素——正好挤掉加亮的那一截（实机截图里看得见）。
                  所以名字与按钮占第一行，上下文自己占满第二行 */}
              <div className="mt-top">
                <button type="button" className="bl mt-name" onClick={跳} title={`跳到「${h.名字}」`}>
                  <span className="bl-top">
                    <span className={`bl-dot ${DOT_CLASS[h.种类 ?? 'topic']}`} />
                    <span className="bl-h">{h.名字}</span>
                    <span className="mt-via">{那串字是哪来的[h.经]}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="chip mt-link"
                  onClick={() => onLink(h)}
                  title={`只把这一处写成 [[${h.串}]]，别处不动`}
                >
                  连上
                </button>
              </div>
              <button type="button" className="bl mt-ctx" onClick={跳} title={`跳到「${h.名字}」`}>
                <span className="bl-ctx">
                  {对得上 ? (
                    <>
                      {h.行.slice(0, h.行内位)}
                      <mark className="mt-hit">{h.串}</mark>
                      {h.行.slice(后)}
                    </>
                  ) : (
                    h.行
                  )}
                </span>
              </button>
            </div>
          )
        })
      )}
      {列.还有 > 0 && <p className="bl-empty">另有 {列.还有} 处没列出来（一次最多列 20 处）</p>}
    </div>
  )
}

export function Backlinks({
  backlinks,
  mentions,
  onOpen,
  onLink,
}: {
  backlinks: Backlink[]
  mentions: MentionList | null
  onOpen: (key: string) => void
  onLink: (问: MentionHit) => void
}): JSX.Element {
  return (
    <>
      {backlinks.length === 0 ? (
        <>
          <p className="bl-empty">还没有别的记录指向这里</p>
          <p className="bl-empty bl-hint">
            在别处写 <code>[[这一篇的标题]]</code>，或者写 <code>[[昨天]]</code> 这样的日期，就会连过来。
          </p>
        </>
      ) : (
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
      )}
      <Mentions 列={mentions} onOpen={onOpen} onLink={onLink} />
    </>
  )
}