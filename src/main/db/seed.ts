/** 第一次打开时种下几篇示例，让空库里也有东西可看、可点、可删。
 *
 *  为什么要种：空着的应用是没法自证的。双链、反链、图谱、标签树、属性分组这五样
 *  都得「先有内容」才看得见，而第一次打开的人正站在最不知道该干什么的位置上。
 *  种下的这几篇刻意把三样东西都用上了（真的 `[[链接]]`、真的 `#嵌套/标签`、真的属性值），
 *  所以右栏和左栏一打开就是满的——照着走一圈就知道怎么用，看完删掉也不心疼。
 *
 *  三道闸，少一道都可能把用户的真实数据盖住：
 *  1. `Setting` 里那一行标记——种过就不再种，哪怕后来库空了（他自己删干净了，那是选择）。
 *  2. 库里一条 `Entry` 都没有——老库升级、以及从旧 `keeNote` 目录搬过来的那份（见
 *     `src/main/index.ts:databasePath`）都会带着内容进来，光看「有没有标记」不够保险。
 *  3. 整个过程出错只记日志，不挡启动。种不上示例顶多是空白应用，崩掉启动是事故。
 *
 *  标记与内容**不在同一个事务里**：`transact` 不支持嵌套，而下面调的
 *  `topics.create` / `entries.create` 各自都要开一个。所以顺序是先落标记再种——
 *  种到一半崩了下次也不会重种，宁可少几篇示例，不要给用户多几篇重复的。 */

import { addDays, todayKey } from '../../shared/date'
import { getDatabase } from './index'
import * as entries from './entries'
import * as props from './props'
import * as topics from './topics'

/** 只写在这一层，不进 `Settings` 那六个键——`settings.coerce()` 的白名单会把它当不存在的键丢掉，
 *  `settings.patch()` 也就永远不会覆盖它。 */
const SEED_MARKER = 'seededAt'

const GUIDE_TOPIC = 'Kestrel 使用指南'

interface SeedArticle {
  title: string
  /** 相对今天的天数。铺开几天，日历和「最近记录」才不像同一秒挤出来的一坨 */
  dayOffset: number
  props: Record<string, unknown>
  content: string
}

/** 正文里凡是写成 `` `代码` `` 的 `[[双链]]` / `#标签` 都是**语法示范**，解析器会跳过代码区
 *  （`shared/links.ts:maskCode`），所以不会凭空多出链接；不裹反引号的那些才是真的，
 *  它们负责把图谱、反链、标签树填起来。
 *
 *  相对日期（`[[今天]]` 这类）按**源记录自己的日期**换算，所以只有当天那几条正文里才这么写。 */
const ARTICLES: SeedArticle[] = [
  {
    title: '怎么开始',
    dayOffset: -3,
    props: { 类型: ['指南', '起步'], 阅读时间: 3, 已上手: true },
    content: `Kestrel 只有两种笔记：**日记**按时间记，**文章**按主题写。第一次打开先花五分钟走完这一圈，之后基本不用再回来。
（小标题不算白写：右栏那块「大纲」列的就是它们。）

## 五分钟走一圈

1. 左栏第一格是「今天」，直接打字。停半秒它自己就存上了，状态条会写「已保存」。
2. 正文里想连到别的记录，打两个左方括号：现在连到 [[双链与图谱]]。
3. 想分类就打井号，比如 #起步/示例，它立刻出现在左栏「标签」那一格里，见 [[标签与属性]]。
4. 这篇日记写着写着变成了一篇能拿给别人看的文章：\`Ctrl+K\` 搜「升格」，选个主题，它就搬过去了，一个字都不用重打。
5. \`Ctrl+K\` 是命令面板，所有功能都能从那儿搜到；\`Ctrl+O\` 是跳到某一条记录。想不起名字就在面板里搜。

## 再试两件

\`Ctrl+,\` 换外观（四套主题都自带），以及删掉这一篇再去标题栏的回收站把它捞回来——那张网长什么样写在 [[安全网]]。

这几篇示例都挂在 [[${GUIDE_TOPIC}]] 主题下面，属于「看完就可以删」的那一类：删掉它们不会碰到你自己的任何一篇。`,
  },
  {
    title: '双链与图谱',
    dayOffset: -2,
    props: { 类型: ['指南', '链接'], 阅读时间: 6, 已上手: true, mood: '专注' },
    content: `链接的写法是 \`[[目标]]\`。目标可以是三样东西：某篇记录的标题、某个主题的名字、或者一个日期。

## 三种目标

- **日期**能直写也能用中文：\`[[2026-09-10]]\`、\`[[昨天]]\` 都算，指的都是那一天的日记
- **别名**用竖线隔开：\`[[双链与图谱|这一篇]]\`，显示出来只有「这一篇」
- 目标还没写出来的时候链接是**悬空**的，画成虚线。等你哪天写下那一篇，它自己就连上了；反过来先建主题、后补引用也接得上。这一条是整张网的承重墙——想到什么名字就先写下来，不必先把结构搭好

## 在哪儿看得见

链接在两个地方读得见：右栏的**反向链接**（谁指向这篇，带着它上下文那一行），和下面的**局部图谱**（这篇两跳以内的邻居）。图谱里点的颜色分日记 / 文章 / 主题，虚线小枝就是悬空的那些。

#文档/双链`,
  },
  {
    title: '标签与属性',
    dayOffset: -1,
    props: { 类型: ['指南', '整理'], 阅读时间: 6, 已上手: false },
    content: `## 标签打在正文里

一个井号起头：#文档/标签。斜杠是层级，左栏「标签」那一格会自动长成树，点父标签能把子孙的条目一起筛出来。

三条容易踩的：

1. 标签**只认正文**。把正文里那处井号删掉，这个标签在这篇就不计数了；标签自己配过的颜色留着。
2. 中文不用打空格。「今天心情不错#心情」里的标签就是「心情」；中文标点和 emoji 天然是终止符，所以 \`#心情😊\` 吃到的是「心情」。
3. 纯数字不算标签（\`#123\` 那是编号，不是主题）。

## 属性在右边面板里

是「这篇自己带的结构化字段」：mood、阅读时间、类型、已上手，这几篇各填了两种写法。属性名在全库共用一个类型（\`mood\` 是文本，就不能在另一篇里是数字），改类型之前会先告诉你有几篇装得下、有几篇会被丢。

切到左栏第四格「属性」，点任何一个值就能把填了它的记录聚到一起。这是标签做不到的一件事：标签是散的词，属性是有类型的字段。

#文档/属性 #文档/标签`,
  },
  {
    title: '安全网',
    dayOffset: 0,
    props: { 类型: ['指南', '数据'], 阅读时间: 12, 已上手: false },
    content: `记东西的应用最怕「改坏了回不去」。

## 网有四层

- **回收站**：删掉的记录先进回收站，随时恢复，指向它的链接也一起接回来。\`Ctrl+K\` 搜「回收站」随时进得去（标题栏那颗按钮只在里面有东西时才冒出来）。界面上标的保留期是 30 天，而自动清理还没接上——它不会自己删你的东西。「彻底删除」才是真删，历史版本和所有引用会一起清掉。
- **历史版本**：正文每改一次自动留一版（太密的自动保存会合并），\`Ctrl+S\` 强制留一版。右栏「历史」翻得到，选中哪一版都能恢复——恢复之前会先把**当前**这一版存下，所以连恢复本身都能撤销。
- **改名的连带**：给主题或标签改名时先报「全库有 N 处会被改」，改不改你说了算；动手之前那 N 篇各自先留一版历史。
- **库本身**：一个 SQLite 单文件，Windows 在 \`%APPDATA%\\Kestrel\` 下面。卸载应用**不会**动它，想备份就拷这一个文件。

## 拿这一篇试

现在这篇就挂着 [[${GUIDE_TOPIC}]]，被 [[怎么开始]] 指着，还连着今天 → [[今天]]。三个方向都能在右栏看到，随便改。

#文档/安全`,
  },
]

const DIARY_PROPS: Record<string, unknown> = { mood: '平静' }

const DIARY = `第一天。上面那几篇是应用自己种的示例，先照着 [[怎么开始]] 走一圈。

## 先试三下

- 连到别的记录就打两个左方括号，想分类就打井号，两边都能 \`Ctrl+K\` 搜到命令
- 右边的反链现在应该有内容了：那几篇互相指，也指着这一天
- 想到什么名字就先写下来，比如 [[一个还没想好的名字]]——它现在是虚线，等你写出那一篇自己会连上

## 这一篇自己

#起步/第一天 是这篇打的标签，\`mood\` 在右边面板填了「平静」。左栏切到「属性」能看到按值分组，右栏这块「大纲」列的就是上面两个小标题。

示例看完就可以删，[[安全网]] 里写了删掉会怎么样。你自己的日记和文章跟它们本来就没有关系。`

function readMarker(): boolean {
  return getDatabase().prepare('select 1 from Setting where key = ?').get(SEED_MARKER) !== undefined
}

function writeMarker(): void {
  getDatabase()
    .prepare(
      `insert into Setting(key, value) values(?, ?)
       on conflict(key) do update set value = excluded.value`
    )
    .run(SEED_MARKER, JSON.stringify(new Date().toISOString()))
}

/** 含回收站里的行：有一篇被删掉的记录，就说明这个库被人用过，不再是「第一次打开」。 */
function isEmptyLibrary(): boolean {
  const row = getDatabase().prepare('select 1 from Entry limit 1').get()
  return row === undefined
}

function seed(): void {
  const today = todayKey()

  // 类型先登记，值才按它校验。不登记的话 props 那边一律按 text 补键
  // （见 db/props.ts:ensureRegistered），数字分桶和勾选分组就都演示不成了。
  props.keyPut('mood', 'text')
  props.keyPut('类型', 'list')
  props.keyPut('阅读时间', 'number')
  props.keyPut('已上手', 'checkbox')

  const guide = topics.create(GUIDE_TOPIC)
  topics.update(guide.id, { icon: '🕊', color: 'tag-3' })

  for (const a of ARTICLES) {
    const created = entries.create({
      kind: 'article',
      entryDate: addDays(today, a.dayOffset),
      title: a.title,
      content: a.content,
      topicId: guide.id,
    })
    // 示例是写完的，不该顶着「草稿」那个徽章
    entries.update(created.id, { props: a.props, status: 'published' })
  }

  const diary = entries.ensureDiary(today)
  entries.update(diary.id, { content: DIARY, props: DIARY_PROPS })
}

/** 启动时在 `openDatabase` 之后调一次。空库才种，种过不再种。 */
export function seedIfFirstRun(): void {
  try {
    if (readMarker()) return
    writeMarker()
    if (!isEmptyLibrary()) return
    seed()
    console.log('[seed] 空库，已种下示例主题与 4 篇文章')
  } catch (err) {
    console.error('[seed] 示例没种上，应用照常启动：', (err as Error).message)
  }
}
