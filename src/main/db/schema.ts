/** 库结构。迁移只追加不改写——已发布的库里 user_version 是唯一可信的进度标记。 */

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial: Entry / Topic / Setting',
    sql: `
      create table Topic(
        id          integer primary key,
        name        text not null unique,
        slug        text not null unique,
        icon        text,
        color       text,
        parent_id   integer references Topic(id) on delete set null,
        sort_order  integer not null default 0,
        description text
      );

      create table Entry(
        id         integer primary key,
        kind       text not null check(kind in ('diary','article')),
        title      text,
        content    text not null default '',
        entry_date text not null,
        created_at text not null,
        updated_at text not null,
        props      text not null default '{}' check(json_valid(props)),
        topic_id   integer references Topic(id) on delete set null,
        status     text not null default 'draft' check(status in ('draft','published')),
        deleted_at text
      );

      -- 「一天一篇日记」是模型不变量，用部分唯一索引把它钉住，
      -- 这样 ensureDiary 可以放心用 insert or ignore，不会写出重复的今天
      create unique index idx_entry_diary_date
        on Entry(entry_date) where kind = 'diary' and deleted_at is null;

      create index idx_entry_kind_date on Entry(kind, entry_date);
      create index idx_entry_updated   on Entry(updated_at desc);
      create index idx_entry_topic     on Entry(topic_id, status);
      create index idx_entry_deleted   on Entry(deleted_at);
      -- 高频属性走表达式索引，属性本身留在 props JSON 里（加新属性不改表结构）
      create index idx_entry_mood      on Entry(json_extract(props, '$.mood'));

      create table Setting(
        key   text primary key,
        value text not null
      );
    `,
  },
  {
    version: 2,
    name: 'links: Link 表（双链 / 升格 / 提及统一入表）',
    sql: `
      -- 图谱要渲染所有边。双链若存在这里、升格若存在 Entry 字段上，查图谱就得取两处并集，
      -- 也没法统一着色排序。所以链接一律进这张表，Entry 上不再有 source_entry_id。
      --
      -- 没有 references：source/target 是「Entry 或 Topic」的多态引用，SQLite 的外键
      -- 表达不了。引用完整性靠 links.ts —— 删 Entry/Topic 时在同一事务里清链接。
      create table Link(
        id          integer primary key,
        source_id   integer not null,
        source_type text not null check(source_type in ('entry','topic')),
        target_id   integer,
        target_type text check(target_type in ('entry','topic','date')),
        target_raw  text not null,
        kind        text not null check(kind in ('wiki','embed','block','promotion','mention')),
        block_id    text,
        anchor      text,
        alias       text,
        created_at  text not null,
        -- 悬空链接（目标还没写）就是 target_id 为空。有 id 必有 type，反之亦然，
        -- 这个等价关系钉住「悬空」的定义，省得出现有 type 没 id 的半吊子行。
        check((target_id is null) = (target_type is null))
      );

      -- 正文里同一个目标写两遍只留一行（解析器按 target_raw 去重）。用索引把它变成硬约束：
      -- 解析器哪天写出重复行，insert 会当场抛错，而不是悄悄多出一条重复反链。
      create unique index idx_link_unique
        on Link(source_id, source_type, kind, target_raw);

      create index idx_link_source ON Link(source_id, source_type);
      create index idx_link_target ON Link(target_id, target_type);
      create index idx_link_raw    ON Link(target_raw);
      -- 新建/重命名 Entry、Topic 后要回头认领悬空的 [[链接]]。悬空行只占少数，
      -- 部分索引比全量 idx_link_raw 更小也更快。
      create index idx_link_dangling ON Link(target_raw) where target_id is null;
    `,
  },
  {
    version: 3,
    name: 'history: Revision 表 + Entry.promoted_at（升格来源）',
    sql: `
      -- 历史版本。**不是每次自动保存都写**：500ms 一次防抖保存，写一次 Revision 的话
      -- 打一段字就能产生几百行几乎相同的快照。写入门槛定在 revision.ts 里
      -- （auto 距上次 ≥5 分钟才写；manual / restore 总写）。
      --
      -- 正文没有内容哈希列：重复内容本来就是合法的历史（改回上一版也是一次编辑），
      -- 去重会在「恢复后又被自动保存」这种情形下吞掉本该留下的一条。
      --
      -- on delete cascade：回收站的「彻底删除」是这个表唯一的真删路径，
      -- 删掉 Entry 后它的历史没有留存意义，跟着走。
      create table Revision(
        id         integer primary key,
        entry_id   integer not null references Entry(id) on delete cascade,
        title      text,
        content    text not null,
        props      text not null default '{}' check(json_valid(props)),
        reason     text not null default 'auto' check(reason in ('auto','manual','restore')),
        created_at text not null
      );

      create index idx_revision_entry on Revision(entry_id, created_at desc);

      -- 升格来源。写这一列之前先试过「不写列，从 (kind, entry_date) 派生」——不成立：
      -- (kind='article', entry_date='2026-09-18') 同时命中「从今天日记升格来的文章」和
      -- 「今天在主题视图新建的文章」，日记页那条「这一天已升格为《X》」的横幅会对后者误报。
      -- promoted_at 记的是「这篇文章由一次升格动作产生、发生在什么时候」，
      -- 从任何现有列都推不出来，所以它该占一列。
      alter table Entry add column promoted_at text;

      -- 部分索引：升格是极少数，全量索引没必要。与 idx_entry_diary_date / idx_link_dangling 同风格。
      -- 与上面的 alter 同处一步是**实测可行**的（scratch/probe-alter.mjs：同事务里
      -- alter 完紧接着建带该列的部分索引，commit 正常，索引也在）。不必拆成两步迁移。
      create index idx_entry_promoted
        on Entry(entry_date) where promoted_at is not null;
    `,
  },
  {
    version: 4,
    name: 'organize: Tag / EntryTag / PropKey / Bookmark（标签、属性、收藏）',
    sql: `
      -- 标签。**存在性由正文决定**：这张表只存「标签自己的属性」（颜色、说明），
      -- 标签在不在某篇里，看 EntryTag。所以重解析时删的是 EntryTag，Tag 行留着——
      -- 把用户配的颜色跟着内容一起删掉，是最难查的那种丢数据。
      --
      -- name 存归一后的完整路径（'a/b/c'，ASCII 转小写），display 存首次见到的原始写法。
      -- 嵌套标签的父节点是**结构性的**：只出现过 #a/b/c 时 a、a/b 也要有行，否则树挂不上。
      create table Tag(
        id          integer primary key,
        name        text not null unique,
        display     text not null,
        color       integer check(color between 0 and 7),
        description text
      );

      -- 正文 ↔ 标签。派生表，每次保存整删整插，与 Link 走同一条路径（links.ts 的 reparseEntry）。
      -- 与 Link 的区别值得写明：EntryTag 不是多态引用，FK + cascade 用得上，
      -- 所以 purge() 不必为它手工清（Link 那边就得清两条，见 entries.ts）。
      -- 复合主键自带 (entry_id, tag_id) 索引，「这篇有哪些标签」直接走它；
      -- 反方向的「这个标签有哪些篇」靠下面那条。
      create table EntryTag(
        entry_id integer not null references Entry(id) on delete cascade,
        tag_id   integer not null references Tag(id)   on delete cascade,
        raw      text not null,
        primary key(entry_id, tag_id)
      );

      create index idx_entrytag_tag on EntryTag(tag_id, entry_id);

      -- 属性名 → 类型的全局绑定（照搬 Obsidian：同名属性在所有条目里同类型）。
      -- 存表而不是塞进 Setting 那坨 JSON 的理由：属性视图要按 key 分组、改名要跟着走，
      -- blob 每次读改整块写回，是给自己加活。
      --
      -- 值的真相在 Entry.props 这一列（v1 就有），不在正文 frontmatter——
      -- 与标签相反，理由见 docs/期-02-设计.md §2.1。类型没有 DB 约束（JSON 列管不了），
      -- 校验在主进程写入门口做（db/props.ts）。
      --
      -- 没有 'tag' 类型：那样正文的 #tag 与属性值会成标签的两个来源，
      -- 而 §2.2 定的是「标签只认正文」。
      create table PropKey(
        name    text primary key,
        type    text not null check(type in ('text','list','number','checkbox','date','datetime')),
        ordinal integer not null default 0
      );

      -- 收藏。ref 是多态的（entry / topic / tag 的 rowid），所以：没有 FK，
      -- 彻底删除条目时要手工清这一行（与 Link 同病），而 title 存的是**收藏那一刻**的名字，
      -- 条目回头改名也认得出当初收藏的是什么。
      --
      -- 不落 sort_order：本期不做拖拽排序（期-02-设计 §8-D2），created_at desc 就是顺序。
      create table Bookmark(
        id         integer primary key,
        kind       text not null check(kind in ('entry','topic','tag')),
        ref        integer not null,
        title      text not null,
        created_at text not null
      );

      create index idx_bookmark_ref on Bookmark(kind, ref);
    `,
  },
  {
    version: 5,
    name: 'search: EntryFts（FTS5 外部内容表），索引数据与触发器交给 db/fts.ts',
    sql: `
      -- 全文索引。**这一步只建表，不建数据、也不建触发器**。两件事都有实测出处：
      --
      -- 1. 不建数据：分批灌 6 万条 × 600 字（34 MiB 正文）要 33~39 秒，而迁移跑在
      --    createWindow() 之前（main/index.ts:233 vs :238），同步建 = 大库升级后
      --    窗口半分钟不出现。数据由 db/fts.ts 在首帧之后分批补（§2.6 / §5.2）。
      -- 2. 不建触发器：对**不在索引里**的 rowid 执行 FTS5 的 'delete' 命令，SQLite 不报
      --    「找不到」而是抛 database disk image is malformed；这条语句在触发器里的话
      --    **整条用户写操作回滚**（§2.7，probe12/13）。所以「索引不完整 + 触发器已装」
      --    = 回填窗口里用户改一篇还没索引的旧笔记，保存直接失败。这是内容损失，不能要。
      --    触发器一律等索引追平之后再装，装卸都归 fts.ts 那台状态机。
      --
      -- tokenize 用 trigram 而不是 unicode61：unicode61 把连续汉字切成整段，
      -- 中文查询实测七个词全 0 命中（§2.2）。trigram 是真子串语义，代价是只认
      -- ≥3 字符——1~2 字的查询由查询层打到同一张表的 LIKE 上，那条也有索引（§2.4）。
      --
      -- 外部内容表（content='Entry'）：正文不在索引里存第二份。代价是跨列取值要回表，
      -- 所以查询层禁止 join 流，见 §2.5 那条红线；另一条代价就是 'delete' 要按传进来的
      -- 旧值重算 token，于是有了上面第 2 点。
      create virtual table EntryFts using fts5(
        title, content,
        content='Entry', content_rowid='id',
        tokenize='trigram case_sensitive 0'
      );

      -- 回填状态位。Setting 是 key/value + JSON 值，而 settings.ts 的 coerce 只认它
      -- 自己那几个键（多出来的键读时忽略、写时不碰），所以这里直接插一条不影响设置。
      insert or replace into Setting(key, value) values('fts.backfill', '"pending"');
    `,
  },
  {
    version: 6,
    name: 'query: SavedQuery + Template（查询块与模板，期-07 §六）',
    sql: `
      -- 存下来的查询。**存的是语句，不是结果**：结果是查出来的，存下来就是一份过期副本。
      -- 用法是把 body 插进正文变成一个查询块（期-07 决策 D10）——如果存的是"引用"
      -- （\`{{query:名字}}\` 那种），导出的 md 在别人手里就是死链，
      -- 而"查询块写进正文"这条决策也白给了。
      --
      -- body 与正文里那截围栏逐字同源，所以它过的是同一套解析（shared/queryLang.ts）。
      create table SavedQuery(
        id         integer primary key,
        name       text not null unique,
        body       text not null,
        view       text not null check(view in ('table','list','cards','calendar','timeline')),
        created_at text not null,
        -- 只在"从命令面板插进正文"那一刻推到今天。给排序用，不做统计界面
        used_at    text
      );

      -- 模板。body 里是带 \`{{date:…}}\` 标记的**原文**：展开只发生在套用那一刻，
      -- 之后那就是普通正文（决策 D11）——不留"变量还活着"的状态机。
      --
      -- vars 这一列先占着不用（登记这条模板用到哪些变量，给界面做提示）。
      -- 现在能靠解析现场数出来，等真需要"缺哪个变量"的报错时再填。
      create table Template(
        id         integer primary key,
        name       text not null,
        scope      text not null check(scope in ('diary','article')),
        body       text not null,
        vars       text not null default '{}' check(json_valid(vars)),
        is_default integer not null default 0,
        created_at text not null,
        updated_at text not null
      );

      create index idx_template_scope on Template(scope, updated_at desc);

      -- 「每个 scope 最多一条默认模板」是模型不变量，用部分唯一索引钉住，
      -- 与 idx_entry_diary_date 同风格。实测（scratch/p7-cost.mjs）：违反时抛的是
      -- \`UNIQUE constraint failed: Template.scope\`——报**列名**而不是索引名，
      -- 断言别去匹配索引名。
      create unique index idx_template_default on Template(scope) where is_default = 1;
    `,
  },
]