import { keepClamp } from '../../shared/backupFormat'
import { DEFAULT_SETTINGS, type Settings, type ThemeName } from '../../shared/types'
import { getDatabase } from './index'

/** 设置存成 key/value，value 是 JSON。
 *  加一个设置项不需要改表结构，也不需要迁移。 */

const THEMES: ThemeName[] = ['cloud', 'paper', 'midnight', 'terminal']

/** 从磁盘读回来的值一律当不可信处理：库可能被手改过、被旧版本写过。
 *  一个非法的 theme 会让整套 CSS 变量找不到定义，界面直接塌掉。 */
function coerce(raw: Partial<Settings>): Settings {
  const theme = THEMES.includes(raw.theme as ThemeName)
    ? (raw.theme as ThemeName)
    : DEFAULT_SETTINGS.theme

  const accent =
    typeof raw.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.accent) ? raw.accent : null

  const blur =
    typeof raw.blur === 'number' && Number.isFinite(raw.blur)
      ? Math.min(40, Math.max(0, Math.round(raw.blur)))
      : DEFAULT_SETTINGS.blur

  const sat =
    typeof raw.sat === 'number' && Number.isFinite(raw.sat)
      ? Math.min(2.2, Math.max(1, raw.sat))
      : DEFAULT_SETTINGS.sat

  return {
    theme,
    accent,
    blur,
    sat,
    glass: typeof raw.glass === 'boolean' ? raw.glass : DEFAULT_SETTINGS.glass,
    followSystem:
      typeof raw.followSystem === 'boolean' ? raw.followSystem : DEFAULT_SETTINGS.followSystem,
    // 路径只当字符串存着，不校验存不存在：上一次导到的目录可能在移动硬盘上，
    // 今天没插——那也要能告诉用户「上次是这儿」
    exportLastDir: typeof raw.exportLastDir === 'string' ? raw.exportLastDir : null,
    importLastDir: typeof raw.importLastDir === 'string' ? raw.importLastDir : null,
    backupEnabled:
      typeof raw.backupEnabled === 'boolean' ? raw.backupEnabled : DEFAULT_SETTINGS.backupEnabled,
    // 0 或负数不当「一份都别留」用：那一档留的是「删错了还能回哪去」，宁可贴到下限
    backupKeep: keepClamp(raw.backupKeep),
  }
}

export function all(): Settings {
  const rows = getDatabase().prepare('select key, value from Setting').all() as unknown as {
    key: string
    value: string
  }[]

  const raw: Record<string, unknown> = {}
  for (const row of rows) {
    try {
      raw[row.key] = JSON.parse(row.value)
    } catch {
      // 单个键坏了不该拖垮整个设置
    }
  }
  return coerce(raw as Partial<Settings>)
}

export function patch(next: Partial<Settings>): Settings {
  const merged = coerce({ ...all(), ...next })
  const stmt = getDatabase().prepare(
    'insert into Setting(key, value) values(?, ?) on conflict(key) do update set value = excluded.value'
  )

  const conn = getDatabase()
  conn.exec('begin')
  try {
    for (const [key, value] of Object.entries(merged)) {
      // 读写都走 JSON，null 才不会撞上列的 not null 约束（bindable 会把 null 原样传下去）
      stmt.run(key, JSON.stringify(value ?? null))
    }
    conn.exec('commit')
  } catch (err) {
    conn.exec('rollback')
    throw err
  }
  return merged
}