import type { JSX } from 'react'
import { countChars, formatDateZh, relativeTime } from '../../../shared/date'
import { outlineLines } from '@/outline'
import { useStore } from '@/store'
import { GraphView } from '@/components/GraphView'
import { Backlinks } from '@/components/Backlinks'
import { RailBlock } from '@/components/RailBlock'
import { PropsPanel } from '@/components/PropsPanel'

export function Rail(): JSX.Element {
  const entry = useStore((s) => s.entry)
  const content = useStore((s) => s.content)
  const title = useStore((s) => s.title)
  const topics = useStore((s) => s.topics)
  const savedAt = useStore((s) => s.savedAt)
  const dirty = useStore((s) => s.dirty)
  const backlinks = useStore((s) => s.backlinks)
  const graph = useStore((s) => s.graph)
  const openNode = useStore((s) => s.openNode)
  const setGraphOpen = useStore((s) => s.setGraphOpen)
  const activeHeading = useStore((s) => s.activeHeading)
  const jumpToHeading = useStore((s) => s.jumpToHeading)
  const versions = useStore((s) => s.versions)
  const previewVersion = useStore((s) => s.previewVersion)

  if (!entry) {
    return (
      <aside className="rail glass">
        <RailBlock title="说明">
          <div className="empty-hint">右栏显示当前这篇的大纲与元信息。</div>
        </RailBlock>
      </aside>
    )
  }

  const isDiary = entry.kind === 'diary'
  const topic = topics.find((t) => t.id === entry.topicId)
  const outline = outlineLines(content)

  return (
    <aside className="rail glass">
      <RailBlock title="大纲">
        {outline.length === 0 ? (
          <div className="empty-hint">正文里写了 # 标题，这里会自动列出来。</div>
        ) : (
          <div className="outline">
            {outline.map((h, i) => (
              <button
                key={`${h.text}-${i}`}
                className={`ol-item ${h.level >= 2 ? 'lv2' : ''} ${i === activeHeading ? 'on' : ''}`}
                onClick={() => jumpToHeading(i)}
              >
                {h.text}
              </button>
            ))}
          </div>
        )}
      </RailBlock>

      <RailBlock
        title={
          <>
            局部图谱
            {graph && <em className="net-cur">{graph.center.label}</em>}
          </>
        }
        action={
          <button
            className="rail-btn"
            onClick={() => setGraphOpen(true)}
            title="看全库的图 · Ctrl+G"
            aria-label="打开全局图谱"
          >
            ⤢
          </button>
        }
      >
        {graph ? (
          <GraphView graph={graph} onOpen={(key) => void openNode(key)} />
        ) : (
          <div className="empty-hint">正在读这篇的关系…</div>
        )}
      </RailBlock>

      <RailBlock title="反向链接" count={backlinks.length}>
        <Backlinks backlinks={backlinks} onOpen={(key) => void openNode(key)} />
      </RailBlock>

      <PropsPanel />

      {/* 默认折叠：这是偶尔才翻的东西，天天摊着会把它下面那块「当日信息」挤下去 */}
      <RailBlock title="历史版本" count={versions.length} foldable defaultOpen={false} resetKey={entry.id}>
        {versions.length === 0 ? (
          <div className="empty-hint">还没有历史版本。写满 5 分钟才会记下上一版。</div>
        ) : (
          <div className="versions">
            {versions.map((v) => (
              <button key={v.id} className="ver-row" onClick={() => void previewVersion(v.id)}>
                <b>{relativeTime(v.createdAt)}</b>
                <span className="ver-reason">
                  {v.reason === 'manual' ? '手动' : v.reason === 'restore' ? '恢复前' : '自动'}
                  {' · '}
                  {v.charCount} 字
                </span>
              </button>
            ))}
          </div>
        )}
      </RailBlock>

      <RailBlock title={isDiary ? '当日信息' : '文章信息'}>
        <div className="kv">
          <div className="kv-row">
            <span>类型</span>
            <b>{isDiary ? '日记' : '文章'}</b>
          </div>
          <div className="kv-row">
            <span>日期</span>
            <b className="mono">{formatDateZh(entry.entryDate)}</b>
          </div>
          {!isDiary && (
            <div className="kv-row">
              <span>所属主题</span>
              <b>{topic?.name ?? '未归主题'}</b>
            </div>
          )}
          {!isDiary && (
            <div className="kv-row">
              <span>状态</span>
              <b>{entry.status === 'draft' ? '草稿' : '已发布'}</b>
            </div>
          )}
          <div className="kv-row">
            <span>字数</span>
            <b className="mono">{countChars(content)}</b>
          </div>
          <div className="kv-row">
            <span>最近保存</span>
            <b>{dirty ? '有未保存改动' : relativeTime(savedAt ?? entry.updatedAt)}</b>
          </div>
        </div>
      </RailBlock>

      <RailBlock title="本文">
        <div className="kv">
          <div className="kv-row">
            <span>标题</span>
            <b>{isDiary ? '（日记无标题）' : title || '未命名'}</b>
          </div>
          <div className="kv-row">
            <span>创建</span>
            <b className="mono">{entry.entryDate}</b>
          </div>
        </div>
      </RailBlock>
    </aside>
  )
}