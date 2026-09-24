import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { formatDateZh, relativeTime } from '../../../shared/date'
import { PROP_TYPE_LABEL, PROP_UNFILLED } from '../../../shared/props'
import type { EntrySummary, TagNode } from '../../../shared/types'
import { entryLabel, findTag, orderedTopics, topicColorVar, useStore } from '@/store'
import type { PropCrumb } from '@/store'
import { Heatmap } from '@/components/Heatmap'
import { IconManage, IconPlus, IconRename } from '@/components/Icons'

export function Sidebar(): JSX.Element {
  const mode = useStore((s) => s.mode)
  const box = useRef<HTMLElement>(null)

  // 滚到离底 240px 就把下一页取进来。判「还有更多」只能靠「这次取满了」：
  // 取回来不足一页说明库见底了，再滚也不该继续发请求
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onScroll = (): void => {
      const s = useStore.getState()
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 240) return
      if (s.mode === 'diary') {
        if (s.recent.length < s.recentLimit) return
        void s.loadMoreRecent()
      } else if (s.mode === 'tag') {
        if (s.activeTagId === null || s.tagRows.length < s.tagLimit) return
        void s.loadMoreTag()
      } else if (s.mode === 'prop') {
        // 属性格只有落到第三级才有分页可言
        if (s.propCrumb.length < 2 || s.propRows.length < s.propLimit) return
        void s.loadMoreProp()
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <aside className="sidebar glass" ref={box}>
      {mode === 'diary' && <DiarySide />}
      {mode === 'topic' && <TopicSide />}
      {mode === 'tag' && <TagSide />}
      {mode === 'prop' && <PropSide />}
    </aside>
  )
}

function DiarySide(): JSX.Element {
  const recent = useStore((s) => s.recent)
  const currentId = useStore((s) => s.currentId)
  const openEntry = useStore((s) => s.openEntry)

  const diaries = recent.filter((e) => e.kind === 'diary')

  return (
    <>
      <Heatmap />
      <div>
        <div className="sec-label">最近记录</div>
        <div className="stream">
          {diaries.length === 0 && <div className="empty-hint">还没有记录。右边直接写就行。</div>}
          {diaries.map((e) => (
            <button
              key={e.id}
              className={`entry-item ${e.id === currentId ? 'active' : ''}`}
              onClick={() => void openEntry(e.id)}
            >
              <div className="t">{formatDateZh(e.entryDate)}</div>
              <div className="d">
                <em>{e.charCount} 字</em>
                <span>{relativeTime(e.updatedAt)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function TopicSide(): JSX.Element {
  const topics = useStore((s) => s.topics)
  const activeTopicId = useStore((s) => s.activeTopicId)
  const articles = useStore((s) => s.articles)
  const currentId = useStore((s) => s.currentId)
  const selectTopic = useStore((s) => s.selectTopic)
  const createTopic = useStore((s) => s.createTopic)
  const newArticle = useStore((s) => s.newArticle)
  const openEntry = useStore((s) => s.openEntry)
  const setManageOpen = useStore((s) => s.setTopicSheetOpen)

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  function submit(): void {
    const trimmed = name.trim()
    if (!trimmed) {
      setAdding(false)
      return
    }
    void createTopic(trimmed)
    setName('')
    setAdding(false)
  }

  return (
    <>
      <div>
        <div className="sec-label">
          主题
          <div className="sec-acts">
            <button title="主题管理" onClick={() => setManageOpen(true)}>
              <IconManage />
            </button>
            <button title="新建主题" onClick={() => setAdding(true)}>
              <IconPlus />
            </button>
          </div>
        </div>

        {adding && (
          <input
            autoFocus
            value={name}
            placeholder="主题名，回车确认"
            onChange={(e) => setName(e.target.value)}
            onBlur={submit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') {
                setName('')
                setAdding(false)
              }
            }}
            style={{
              width: '100%',
              margin: '0 0 6px',
              padding: '7px 9px',
              borderRadius: 9,
              border: '1px solid var(--border-strong)',
              background: 'var(--hover)',
              fontSize: 13,
              outline: 'none',
            }}
          />
        )}

        <div className="topics">
          {topics.length === 0 && !adding && (
            <div className="empty-hint">
              还没有主题。点上面的 + 建一个，文章就归到主题下。
            </div>
          )}
          {/* orderedTopics 与主题管理那张表用同一个排序，两处「上下相邻」才是同一对主题 */}
          {orderedTopics(topics).map((t) => (
            <button
              key={t.id}
              className={`topic ${t.id === activeTopicId ? 'active' : ''} ${
                t.parentId === null ? '' : 'child'
              }`}
              title={t.description || t.name}
              onClick={() => void selectTopic(t.id)}
            >
              {/* 图标没填时退回色点：一个主题总得有个能认出来的记号。
                  两支都要包成元素——文本节点在 flex 里会跟后面的名字并成同一个匿名项，间距就没了 */}
              {t.icon ? (
                <span className="icn">{t.icon}</span>
              ) : (
                <span className="dot" style={{ background: topicColorVar(t.color) }} />
              )}
              <span className="topic-name">{t.name}</span>
              <span className="cnt">{t.articleCount}</span>
            </button>
          ))}
        </div>
      </div>

      {activeTopicId !== null && (
        <div>
          <div className="sec-label">
            文章
            <button title="新建文章" onClick={() => void newArticle()}>
              <IconPlus />
            </button>
          </div>
          <div className="articles">
            {articles.length === 0 && <div className="empty-hint">这个主题下还没有文章。</div>}
            {articles.map((a) => (
              <button
                key={a.id}
                className={`article-card ${a.id === currentId ? 'active' : ''}`}
                onClick={(e) => {
                  // Ctrl+单击 = 新标签（§三那一条通用规则）
                  if (e.ctrlKey || e.metaKey) void useStore.getState().openEntryInTab(a.id)
                  else void openEntry(a.id)
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    void useStore.getState().openEntryInTab(a.id)
                  }
                }}
              >
                <h4>
                  {a.title ?? '未命名文章'}
                  {a.status === 'draft' && <span className="badge draft">草稿</span>}
                </h4>
                {a.excerpt && <p>{a.excerpt}</p>}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

/** 标签树那一格的键盘浏览（§6「焦点给标签树，可用时方向键浏览」）。
 *  只在树内拦这几个键：↑↓ 在别处是滚动，Home/End 在编辑器里是跳行文首/行尾，抢了就是 bug。
 *  移动焦点不等于筛选——选中要按 Enter，那是按钮原生的事，不在这儿另写一套。 */
function onTagTreeKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('.tag')]
  if (buttons.length === 0) return
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const go = (n: number): void => {
    const i = Math.max(0, Math.min(buttons.length - 1, n))
    buttons[i].focus()
    buttons[i].scrollIntoView({ block: 'nearest' })
  }
  if (e.key === 'ArrowDown') go(at + 1)
  else if (e.key === 'ArrowUp') go(at - 1)
  else if (e.key === 'Home') go(0)
  else if (e.key === 'End') go(buttons.length - 1)
  else return
  e.preventDefault()
}

/** 命令推的计数要能跨挂载：TagSide 每换一次格就重建一次，「上次看到哪儿」存组件里
 *  会被重建抹平（切过来那一下必然多发一次焦点）。放模块作用域才分得清
 *  「刚点格子」和「命令刚把焦点要过去」。 */
let seenTagTreeFocus = 0

/** 标签视图（期-02-设计 §3.1）：上下两段，与 TopicSide 同构——上面树、下面选中后的条目列表。
 *  这里不做「多标签 AND 筛选」，侧栏本身就是筛选结果，主区仍然是编辑器。 */
function TagSide(): JSX.Element {
  const tags = useStore((s) => s.tags)
  const activeTagId = useStore((s) => s.activeTagId)
  const tagRows = useStore((s) => s.tagRows)
  const tagTreeFocus = useStore((s) => s.tagTreeFocus)
  const tree = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (tagTreeFocus === seenTagTreeFocus) return
    seenTagTreeFocus = tagTreeFocus
    const el = tree.current
    if (!el) return
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('.tag')]
    const cur =
      buttons.find((b) => b.closest('.tag-row')?.classList.contains('active')) ?? buttons[0]
    cur?.focus()
  }, [tagTreeFocus])

  const active = activeTagId === null ? null : findTag(tags, (n) => n.id === activeTagId)

  return (
    <>
      <div>
        <div className="sec-label">标签</div>
        {tags.length === 0 ? (
          <div className="empty-hint">
            还没有标签。在正文里写 #工作/项目A，保存后就出现在这里。
          </div>
        ) : (
          <div className="tag-tree" ref={tree} onKeyDown={onTagTreeKeyDown}>
            {tags.map((n) => (
              <TagBranch key={n.id} node={n} depth={0} />
            ))}
          </div>
        )}
      </div>

      {active !== null && (
        <div>
          <div className="sec-label">带 #{active.name} 的记录</div>
          <EntryStream rows={tagRows} empty="这个标签下现在没有记录。" />
        </div>
      )}
    </>
  )
}

/** 条目列表（§3.3 末段要求三处共用）。日记那一格没进来：它每行给的是日期 + 字数，
 *  与这两处的「标题 + 种类 + 相对时间」不是一张表。 */
function EntryStream({ rows, empty }: { rows: EntrySummary[]; empty: string }): JSX.Element {
  const currentId = useStore((s) => s.currentId)
  const openEntry = useStore((s) => s.openEntry)

  return (
    <div className="stream">
      {rows.length === 0 && <div className="empty-hint">{empty}</div>}
      {rows.map((e) => (
        <button
          key={e.id}
          className={`entry-item ${e.id === currentId ? 'active' : ''}`}
          onClick={() => void openEntry(e.id)}
        >
          <div className="t">{entryLabel(e)}</div>
          <div className="d">
            <em>{e.kind === 'diary' ? '日记' : '文章'}</em>
            <span>{relativeTime(e.updatedAt)}</span>
          </div>
        </button>
      ))}
    </div>
  )
}

/** 属性视图（§3.3）：文件浏览器形态。主体永远是一层列表，顶部一行面包屑负责回上一层——
 *  260px 宽的侧栏叠三层缩进会变成谁都不好点，所以用下钻代替嵌套。 */
function PropSide(): JSX.Element {
  const propKeys = useStore((s) => s.propKeys)
  const crumb = useStore((s) => s.propCrumb)
  const groups = useStore((s) => s.propGroups)
  const rows = useStore((s) => s.propRows)
  const setPropCrumb = useStore((s) => s.setPropCrumb)

  const name = crumb[0]?.name ?? null
  // crumb 只会长到两级（第三级是条目，不是属性），所以层数 = min(路径长, 2)
  const depth = Math.min(crumb.length, 2)

  return (
    <div>
      {/* 主体永远是一层列表（§3.3）：点一个列表项是**换掉整张列表**。
          标签那格是上下两段（树 + 选中后的条目），这里不跟——两段同屏等于把三层嵌套换了个写法，
          而「不叠三层缩进」正是四格方案能用的前提。回上一层只有面包屑一条路，不另设返回键 */}
      <div className="sec-label">{depth === 0 ? '属性' : depth === 1 ? '值' : '记录'}</div>
      <PropCrumbBar crumb={crumb} onGo={(c) => void setPropCrumb(c)} />

      {depth === 0 &&
        (propKeys.length === 0 ? (
          <div className="empty-hint">
            还没有属性。在右边那篇的属性面板里加一个（mood、done、评分这类）。
          </div>
        ) : (
          <div className="topics">
            {propKeys.map((k) => (
              <button
                key={k.name}
                className="topic"
                title={`${k.name} · ${PROP_TYPE_LABEL[k.type]}`}
                onClick={() => void setPropCrumb([{ name: k.name, value: null }])}
              >
                {k.name}
                {/* 「有几个不同值」数的是第二级的分组数，所以它不等于填过的条目数：
                    列表一条有两个值只算一个值、数字按桶计更是合并过的 */}
                <span className="cnt">{k.valueCount}</span>
              </button>
            ))}
          </div>
        ))}

      {depth === 1 && name !== null && (
        <div className="topics">
          {groups.length === 0 && <div className="empty-hint">还没有条目填过它。</div>}
          {groups.map((g) => (
            <button
              key={g.value ?? PROP_UNFILLED}
              className="topic"
              /* 下钻是**往路径上再挂一级**，不是把当前那级的 value 填上：
                 `propCrumb` 的读法是「长度 = 层数」（`[{name}]` 第二级、`[{name},{name,value}]` 第三级），
                 store 的 `refreshPropEntries` 就看这个长度决定要不要去取条目 */
              onClick={() => void setPropCrumb([{ name, value: null }, { name, value: g.value }])}
            >
              {g.value ?? PROP_UNFILLED}
              <span className="cnt">{g.count}</span>
            </button>
          ))}
        </div>
      )}

      {depth === 2 && <EntryStream rows={rows} empty="这一组现在没有记录。" />}
    </div>
  )
}

/** 面包屑：`全部 › mood › 平静`。除最后一级外每级都能点，点它就是回到那一级——
 *  与下面的列表共用同一次 `setPropCrumb`，所以不存在「列表走了、面包屑没走」的中间态。 */
function PropCrumbBar({
  crumb,
  onGo,
}: {
  crumb: PropCrumb[]
  onGo: (crumb: PropCrumb[]) => void
}): JSX.Element | null {
  if (crumb.length === 0) return null

  const levels: { label: string; crumb: PropCrumb[] }[] = [
    { label: '全部', crumb: [] },
    { label: crumb[0].name, crumb: crumb.slice(0, 1) },
  ]
  if (crumb.length >= 2) {
    levels.push({ label: crumb[1].value ?? PROP_UNFILLED, crumb: crumb.slice(0, 2) })
  }

  return (
    <div className="crumb">
      {levels.map((l, i) => (
        <span className="crumb-part" key={l.label}>
          {i > 0 && <span className="crumb-sep">›</span>}
          {i === levels.length - 1 ? (
            <span className="crumb-here">{l.label}</span>
          ) : (
            <button onClick={() => onGo(l.crumb)}>{l.label}</button>
          )}
        </span>
      ))}
    </div>
  )
}

/** 标签树的一行，连带它折叠起来的子树。
 *  折叠只记「用户动过的手势」（store.tagFold），没动过的按深度走默认：根展开、子折起。
 *  这样每次自动保存后重拉树，不会把用户刚展开的那一层收回去。 */
function TagBranch({ node, depth }: { node: TagNode; depth: number }): JSX.Element {
  const activeTagId = useStore((s) => s.activeTagId)
  const fold = useStore((s) => s.tagFold)
  const foldTag = useStore((s) => s.foldTag)
  const selectTag = useStore((s) => s.selectTag)
  const setTagRename = useStore((s) => s.setTagRename)

  const open = fold[node.name] ?? depth === 0
  const hasKids = node.children.length > 0

  return (
    <>
      <div className={`tag-row ${node.id === activeTagId ? 'active' : ''}`} style={{ paddingLeft: depth * 13 }}>
        {hasKids ? (
          <button
            className={`tag-fold ${open ? 'on' : ''}`}
            title={open ? '折叠' : '展开'}
            aria-expanded={open}
            onClick={() => foldTag(node.name, !open)}
          >
            ▸
          </button>
        ) : (
          /* 占位：没有子节点的行也要让 chip 与兄弟行对齐 */
          <span className="tag-fold" />
        )}

        <button
          className="tag"
          style={{ '--tc': `var(--tag-${node.color + 1})` } as CSSProperties}
          title={`#${node.name}`}
          onClick={() => void selectTag(node.id)}
        >
          {node.display}
        </button>

        {/* 父节点这个数是「自身 + 子孙」的合计：#a/b/c 会给 a、a/b、a/b/c 各插一行 */}
        <span className="cnt">{node.count}</span>

        <button
          className="tag-act"
          title={`重命名 #${node.name}`}
          aria-label={`重命名 #${node.name}`}
          onClick={() => setTagRename(node.name)}
        >
          <IconRename />
        </button>
      </div>

      {open && node.children.map((c) => <TagBranch key={c.id} node={c} depth={depth + 1} />)}
    </>
  )
}