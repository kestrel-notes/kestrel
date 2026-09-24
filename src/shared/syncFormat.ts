/** 文件夹同步的形状与判定（期-10 §二）。
 *
 *  为什么单独一层：这一档里最贵的一刀是**换库**——拉那一下会把当前库整个换掉。
 *  「谁动过、该不该停、能不能换」这些判据放在纯函数里，才能离线一条一条问遍
 *  （`scratch/p10-fmt-test.mjs`），而不是等真机上碰运气。理由与 `backupFormat.ts` 同一件：
 *  **不可逆的判据不归实机验，归离线那套。**
 *
 *  三方比对的"三方"是：
 *   · 基线 —— 这台机器上一次同步完，两边各是什么（每端各留一份，放本地 userData）
 *   · 本地 —— 此刻库里的那三个数
 *   · 夹内 —— 那个文件夹里 `kestrel-meta.json` 记着的那三个数
 *  比的是「相对基线，谁动了」，不是「谁的时间戳新」。后者就是猜，而猜错一次的代价是
 *  「你上周在那台机器上写的那几篇没了」（设计稿 §一「冲突就停下，不猜」）。 */

/** 那三个数。`updatedAt` 是一篇都没有时的空串 */
export interface SyncFace {
  /** 库身份（`Setting` 里的 `lib-id`，随库走） */
  libId: string
  /** `pragma user_version` */
  schema: number
  /** 活着的篇数（`deleted_at is null`） */
  entries: number
  /** `max(updated_at)`，带毫秒的 ISO */
  updatedAt: string
}

/** 基线与夹内那两份都带一个"记录的时刻"：基线是上次同步，夹内是推出去 */
export interface SyncMark extends SyncFace {
  at: string
}

export type SyncVerdict =
  /** 那个夹里还没有那一份，本地也从没同步过 ⇒ 第一次，只能推 */
  | 'never'
  /** 两边相对基线都没动 ⇒ 无事可做 */
  | 'clean'
  /** 只有本地动了 ⇒ 推 */
  | 'push'
  /** 只有夹里动了 ⇒ 拉 */
  | 'pull'
  /** 两边都动了 ⇒ 停下，让人挑一边 */
  | 'conflict'
  /** 基线不在（换机器、清过 userData）而夹里有货 ⇒ 没有参照物，两向都要求人明确按一次 */
  | 'unknown'
  /** 夹里那一份是另一部库 ⇒ 拒绝，一个字节都不换 */
  | 'other-lib'
  /** 夹里那一份的库结构比这里新 ⇒ 拒绝（`MIGRATIONS` 只往上走，没有降级路径） */
  | 'newer-schema'

/** 那个夹里 Kestrel 只认这两个名字。别的 `.db`（同步盘的冲突副本之类）一概不读、不删、不计 */
export const 库名 = 'kestrel.db'
export const 记名 = 'kestrel-meta.json'
/** 推的第一步落这一份，成功后 rename 成 `库名`。半截的那一份永远不会叫 `库名` */
export const 临时名 = 'kestrel.db.tmp'

/** 基线那份文件的名字（放本地 userData，不进那个夹） */
export const 基线文件 = 'sync-baseline.json'

/** 比的是那三个数，不比 `at`：`at` 是"这一份记录于何时"，不是内容 */
export function 同面(a: SyncFace, b: SyncFace): boolean {
  return a.schema === b.schema && a.entries === b.entries && a.updatedAt === b.updatedAt
}

/** 那个夹里到底有没有"一份可拉的"：文件与那份记录都得在，缺一个就按没同步过算。
 *  只认死名字（`库名`），不认"夹里最新的那个 .db"——后者会把同步盘的冲突副本当成货。 */
export function 夹里有货(有库文件: boolean, 有记录: boolean): boolean {
  return 有库文件 && 有记录
}

/** 三方比对。判据的顺序是硬的：先身份、再结构、然后才轮到"谁动过"。
 *  身份排第一是因为它最贵——认不出是谁的库就换，换错了连"退回去"都是退到别人的那一部。 */
export function 判(基线: SyncMark | null, 本地: SyncFace, 夹内: SyncMark | null): SyncVerdict {
  if (!夹内) return 基线 ? 'push' : 'never'
  if (夹内.libId !== 本地.libId) return 'other-lib'
  if (夹内.schema > 本地.schema) return 'newer-schema'
  if (!基线) return 'unknown'
  if (基线.libId !== 本地.libId) return 'unknown'
  const 本地动 = !同面(基线, 本地)
  const 夹内动 = !同面(基线, 夹内)
  if (本地动 && 夹内动) return 'conflict'
  if (本地动) return 'push'
  if (夹内动) return 'pull'
  return 'clean'
}

/** 界面上那一句话。状态与措辞绑在这里，不散到组件里去——
 *  七种状态各有两句（一句状态、一句"那两颗按钮里该亮哪颗"），散着写必漏一种。 */
export function 那句话(判据: SyncVerdict): string {
  switch (判据) {
    case 'never':
      return '还没同步过：先把当前库推一份到那个夹里'
    case 'clean':
      return '两边一致，没什么要同步的'
    case 'push':
      return '这台机器上有改动，还没推过去'
    case 'pull':
      return '那个夹里有一份更新的，可以换回来'
    case 'conflict':
      return '两边都动过 —— 这一档不猜哪边算数，挑一边（被换掉那一边会先自保一份）'
    case 'unknown':
      return '这台机器上没有同步记录（换过机器、或清过数据），所以判不出谁更新：要哪一边请自己挑'
    case 'other-lib':
      return '那个夹里住着另一部库，不换'
    case 'newer-schema':
      return '那个夹里那一份的库结构更新，这个版本的 Kestrel 读不了'
  }
}

/** 只有这两态允许"人明确按一次"之后再动手。其余状态下按钮要么只有一颗，要么一颗都没有。 */
export function 要人挑(判据: SyncVerdict): boolean {
  return 判据 === 'conflict' || 判据 === 'unknown'
}

/** 那一颗该不该亮。推与拉各问一次——不亮的按钮点了也没用，界面上就别让它像能点 */
export function 能推(判据: SyncVerdict): boolean {
  return 判据 === 'never' || 判据 === 'push' || 判据 === 'conflict' || 判据 === 'unknown'
}
export function 能拉(判据: SyncVerdict): boolean {
  return 判据 === 'pull' || 判据 === 'conflict' || 判据 === 'unknown'
}

/** 记录文件读坏了（半截 JSON、被人手改过）怎么办：**当成没同步过**，不是当成"夹里那份是空的"。
 *  后者会让 `判()` 以为"只有本地动过"，于是下一次推会把对方那份直接盖掉。 */
export function 解析记录(原文: string): SyncMark | null {
  try {
    const o = JSON.parse(原文) as Partial<SyncMark>
    if (typeof o?.libId !== 'string' || typeof o?.schema !== 'number' || typeof o?.entries !== 'number')
      return null
    if (typeof o.updatedAt !== 'string' || typeof o.at !== 'string') return null
    return { libId: o.libId, schema: o.schema, entries: o.entries, updatedAt: o.updatedAt, at: o.at }
  } catch {
    return null
  }
}

/** 基线那份同理：读坏了按"没有同步记录"处理（走 `unknown` 那一态，要人挑）。 */
export const 解析基线 = 解析记录

/** 12 位 hex 的库身份。够认出一部库，又短到能整句印在报错里让人抄 */
export function 库身份形(值: unknown): boolean {
  return typeof 值 === 'string' && /^[0-9a-f]{12}$/.test(值)
}
