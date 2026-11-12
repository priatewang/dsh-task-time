# 任务计时（Task Time）需求与实现规格

> 版本：1.0 ｜ 状态：已在 DeepSeek Harness Web UI 落地并经多轮修正 ｜ 用途：交给其他 Agent / 开发工具照此实现
>
> 本文档只描述**行为契约与数据契约**，不绑定具体框架。文末附一份 DSH 的参考实现映射，仅供对照。

---

## 1. 目标与范围

### 1.1 一句话目标

按"任务（会话/对话）"统计**人的投入时间**：把用户打字、阅读/浏览的行为折算成时长，支持空闲自动停表、切走自动停表，并可按**标签**归类汇总，形成可回看的投入统计。

### 1.2 要解决的问题

- 想知道「这个任务我投入了多久」，而不是「AI 跑了多久」。
- 想把投入按类型归类（工作 / 某项目 / 娱乐 / 学习……）。
- 不希望把"挂机、去开会、看别的东西"的时间算进来。

### 1.3 范围

| 在范围内 | 不在范围内 |
|---|---|
| 应用内的输入时长、阅读时长 | 其他应用/外部浏览器/PDF 阅读器的时长 |
| 任务级、标签级、项目级汇总 | 团队/多人统计、云端同步 |
| 本机持久化、CSV 导出 | 计费、绩效、自动截图或内容采集 |

### 1.4 术语

| 术语 | 含义 |
|---|---|
| 任务 / Task | 一次对话会话（session）。一个任务有唯一 id |
| 项目 / Project | 任务所属的工作区或目录名 |
| 通道 / Channel | `input`（输入）或 `read`（阅读） |
| 段 / Segment | 一段连续计时的区间 `[start, end)`，带任务 id 与通道 |
| 空闲阈值 / Idle | 超过该时长无对应活动即停表 |
| 待认领 / Pending | 新任务尚未创建（还没发出第一条消息）时产生的输入时长 |

---

## 2. 功能需求

### FR-1 输入计时（input）

- 在**输入框内第一次按键 / 输入法上屏 / 粘贴**时开始一段输入计时。
- 之后**连续计时**：段内两次按键之间的停顿**计入**（写作思考时间算投入）。
- 段起点固定为第一次输入的时刻；段终点随每次输入后移。
- 只在输入框内产生输入才算；点击输入框本身**不**开始计时。

### FR-2 阅读计时（read）

- 在**输入框之外的滚轮、点击、触摸**时开始一段阅读计时。
- 阅读段由**滚动、鼠标移动、选中文字**延长。
- 阅读开始也需要一个"明确动作"（滚轮/点击/触摸），单纯的光标漂移不新建段。

### FR-3 空闲中断（阶梯阈值）

| 通道 | 空闲阈值 | 说明 |
|---|---|---|
| 输入 | **60 秒**（可配） | 超时即停表 |
| 阅读 | **120 秒**（可配） | 超时即停表 |

- **停表时的结束点 = 最后一次活动时刻**，即最后那段空转**不计入**。
- 因此：连续打字时数字持续增长（含中间停顿）；一旦空转超过阈值，数字会回退到最后一次活动的真实时长。
- 两个通道阈值不同，这就是"分阶梯"的含义。

### FR-4 上下文中断（立即停表）

以下任一情况立即结算当前段，不做等待：

1. 切换到其他任务（会话）
2. 切换到其他主面板/页面（如统计页）
3. 窗口失焦（切到别的应用）
4. 页面不可见（切标签、最小化）
5. 页面关闭 / 刷新

### FR-5 通道互斥与切换

- 同一时刻**只有一个**活动段。
- 输入 → 阅读切换：滚轮/点击（输入框外）立即结束输入段（终点=最后一次按键），并从该动作开始阅读段。**中间空白两边都不算**。
- 阅读 → 输入切换：点击输入框内**结束阅读段**，但**不开始输入段**；真正开始打字才开新段。

### FR-6 新任务草稿计时（待认领）

- 新建任务但**还没创建会话**（hero 空态）时，在输入框里的输入仍然计时。
- 会话一旦创建（发出第一条消息），**最近 10 分钟内**的待认领输入时长归入该会话。
- 超过 10 分钟未发出的草稿时长丢弃。
- 待认领只记输入，不记阅读。

> 已知副作用：放弃草稿后 10 分钟内打开了别的会话，草稿时长会算到那个会话；可将窗口缩短到 3 分钟以减小影响。

### FR-7 标签

- 每个任务可打**多个标签**（建议上限 12 个、单个 ≤32 字符）。
- 标签存于服务端 `tags.json`，**跨范围、跨重启持久化**。
- 维护一个**全局标签库**：所有任务用过的标签去重后一直可复用，不随所选时间范围消失（接口 `/state` 里以 `knownTags` 返回，按使用次数排序）。
- 标签编辑是一个弹层：已用过的标签以胶囊列出，**点选即切换**；同时可输入新标签回车加入；保存/取消。
- `/state` 的 `allTags` 仅表示"当前范围内出现过的标签"，用于文案；`knownTags` 才是选择器数据源。
- "按标签分组"时使用**第一个标签**作为主标签；统计汇总时**多标签任务在每个标签下各计一次**。

### FR-8 统计面板

**汇总卡片**：总投入、输入、阅读、任务数。

**标签统计表**（新增）：

| 列 | 说明 |
|---|---|
| 标签 | 标签名；无标签归入「未分类」 |
| 任务数 | 该标签下的任务数 |
| 输入 / 阅读 | 累加值 |
| 合计 | 加粗 |
| 占比 | 进度条 + 百分比；按标签表内部归一，各标签合计 = 100% |

- 按合计降序；跟随当前时间范围。
- 表头需注明"多标签任务在每个标签下各计一次"。

**明细表**（按 标签 / 任务 / 项目 三种分组）：

| 列 | 说明 |
|---|---|
| 任务 | 标题（单行省略，悬停显示完整标题 + 任务 id）+ 项目名小字 |
| 标签 | 胶囊标签 + 「编辑」 |
| 输入 / 阅读 / 合计 | 右对齐等宽数字，合计加粗 |
| 占比 | 组内占比（组内归一）+ 进度条 |
| 最后活动 | `MM-DD HH:mm`，次级色 |

**范围切换**：今天 / 近 7 天 / 近 30 天 / 全部。**刷新频率**：15 秒自动刷新 + 手动刷新。

**空态**：无数据时显示引导文案（"在对话里打字、滚动或翻看内容就会开始计时"）。

### FR-9 会话头部实时胶囊

- 位置：会话标题栏右侧。
- 内容：`⏱ 输入 1m 05s · 阅读 12m 30s`，表示**该任务今天**的累计。
- 实时性：已落库数据 + **当前未闭合段**（本地每秒递增）合并显示；每 5 秒同步一次服务端；有段结束时 0.7 秒后追加一次同步。
- 有活动段时在数字前显示一个圆点 `●`。
- 总计不足 30 秒时不显示，避免新任务噪音。
- 点击胶囊 → 打开统计面板；悬停提示"今日合计 XX"。

### FR-10 时长格式化

一律**精确到秒**，不足 1 分钟显示秒：

| 时长 | 显示 |
|---|---|
| 29s | `29s` |
| 65s | `1m 05s` |
| 750s | `12m 30s` |
| 7500s | `2h 05m` |

禁止用"四舍五入到分钟"（60–89 秒全显示成 `1m` 会被用户判定为不准）。

### FR-10 使用记录（时间线）

统计面板顶部提供 **统计 / 使用记录** 视图切换。

- 使用记录 = 一次"坐下来使用这个任务"的连续块，展示**开始时间与结束时间**。
- 合并规则：同一任务的相邻段，间隔 ≤ **5 分钟**合并成一条；超过则拆成两条（可配置 `gap`）。
- 按日期分组（今天 / 昨天 / MM-DD），组头显示当天合计时长。
- 每条记录展示：`HH:mm – HH:mm`、**实际投入时长**、任务名（+项目）、标签、输入、阅读。
- **时长口径**：取合并后各段输入 + 阅读的实测之和，**不按首末时间跨度计算**（中间的空闲不计入）。
- 按开始时间倒序；跟随当前时间范围；15 秒自动刷新。
- 跨天的时间段按开始日期归组，结束时间照实显示。

### FR-11 导出

- `GET /export.csv?from&to`，UTF-8 BOM，列：`session_id,title,project,tags,input_ms,read_ms,total_ms,last_active_iso`。
- 标签用 `|` 连接。

---

## 3. 事件 → 状态机（核心契约）

### 3.1 状态

```
activeSession : string | null     // 当前任务 id；null = 处于待认领状态
segment       : { sid, channel, start, end } | null   // 最多一个
pending[]     : segment[]          // 待认领的已关闭段
idleTimer     : timer
```

### 3.2 事件表（输入通道）

| 触发 | 条件 | 动作 |
|---|---|---|
| `keydown`（非 IME 组合中） | 目标在输入框内 | `stamp('input')` |
| `beforeinput` / `input` / `compositionupdate` / `paste` | 目标在输入框内 | `stamp('input')` |
| 同上，但目标不在输入框内 | — | `ambient()`（见 3.4） |
| `keydown` 目标不在输入框内 | — | `ambient()`（不得中断输入段） |

### 3.3 事件表（阅读通道与中断）

| 触发 | 条件 | 动作 |
|---|---|---|
| `wheel` | 任意 | `stamp('read')`（**中断**输入段） |
| `pointerdown` | 输入框**外** | `stamp('read')`（**中断**输入段） |
| `pointerdown` | 输入框**内** | 若当前是阅读段 → 关闭它；不开始输入段 |
| `touchstart` | 同 `pointerdown` | 同上 |
| `scroll` | 任意 | `ambient()`（**不得**中断输入段） |
| `selectionchange` | 选区锚点在输入框外 | `ambient()` |
| `selectionchange` | 选区锚点在输入框内（打字时光标移动） | **忽略** |
| `pointermove` | 节流 400ms | `ambient()` |
| `visibilitychange` → hidden | — | `close(at lastActivity)` + flush |
| `window.blur` | — | `close(at lastActivity)` + flush |
| `pagehide` | — | `close(at lastActivity)` + sendBeacon |

### 3.4 原语

```
stamp(channel):
  if !pageVisible(): return
  if activeSession == null and channel != 'input': return
  if segment != null and segment.channel != channel: closeSegment(segment.end)
  if segment == null: segment = {sid: activeSession, channel, start: now, end: now}
  else: segment.end = now
  scheduleIdle(segment.channel ? inputIdle : readIdle)

ambient():                       // 只延长阅读，不切换、不新建
  if activeSession == null or !pageVisible(): return
  if segment == null: return      // 不让程序化滚动凭空造出阅读时间
  if segment.channel != 'read': return
  segment.end = now
  scheduleIdle(readIdle)

closeSegment(endAt):
  end = clamp(endAt ?? segment.end, segment.start, segment.end)
  if end - start < (channel == 'input' ? 5000 : 30000) ms: 丢弃
  if segment.sid == null: pending.push(entry)      // 不发送无归属段
  else: queue.push(entry); flushAfter(500ms); notifyClosed()

pageVisible() := document.visibilityState === 'visible' && document.hasFocus()
```

### 3.5 任务切换

```
enter(sid):
  if activeSession != null and activeSession != sid:
     closeSegment(segment.end); flush(true)
  activeSession = sid
  if segment != null and segment.sid == null: segment.sid = sid      // 认领进行中的草稿段
  adopt(pending where end >= now - 10min) → 改写 sid 并入队

leave(sid):
  if activeSession != sid: return
  closeSegment(segment.end); flush(true); activeSession = null
```

### 3.6 实时值

```
live(sid):
  if segment == null or segment.sid != sid: return null
  return { channel, ms: now - segment.start }     // 连续增长，不做 3 秒冻结
```

> 说明：实时值连续增长，停止输入后仍会涨，直到空闲阈值触发时按"最后一次活动"回退。这是"含停顿、不含空转"的必然表现，需在 UI 文案或文档里说明，避免被当成 bug。

---

## 4. 数据契约

### 4.1 存储结构

```
<data_root>/
  intervals.jsonl   # 追加写，一行一个段
  tags.json         # { "<sessionId>": ["工作", "xx项目"] }
```

### 4.2 段记录

```jsonc
{ "s": "session-id", "c": "input|read", "a": 1712345678901, "b": 1712345685321, "w": "window-id" }
```

- `a`/`b`：起止毫秒时间戳，`b > a`。
- `w`：窗口/标签页标识，用于去重而非双算。

### 4.3 校验与去重

| 规则 | 值 |
|---|---|
| 输入最小段 | 5000 ms（低于即不入库、不聚合） |
| 阅读最小段 | 30000 ms（低于即不入库、不聚合） |
| 服务端最大段 | 6 小时 |
| 合法通道 | `input` / `read`，其余丢弃 |
| 去重键 | `sid|channel|start|end|window` |
| 聚合 | 按 `(session, channel)` 排序后**合并重叠区间**，再求和 |
| 范围查询 | 把段裁剪到 `[from, to]` 求交集，跨界的段只算交集 |

> 多窗口：每个标签页独立采样，服务端按区间并集合并，同一分钟不重复计。

### 4.4 HTTP 接口

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/ingest` | `{ intervals: [{sid, ch, start, end, w}] }` | `{ ok, accepted }` |
| POST | `/tag` | `{ sid, tags: string[] }` | `{ ok, sid, tags }`（空数组 = 删除标签） |
| GET | `/state?from&to` | — | `{ now, from, to, rows[], allTags[], inputIdleMs, readIdleMs }` |
| GET | `/session?sid&from&to` | — | `{ sid, inputMs, readMs, totalMs, last }` |
| GET | `/log?from&to&gap` | — | `{ now, from, to, gapMs, visits[] }` |
| GET | `/export.csv?from&to` | — | CSV |

`rows[]` 元素：

```ts
{
  sid: string
  title: string        // 会话标题，取不到时为空串
  project: string      // 目录名
  tags: string[]
  inputMs: number
  readMs: number
  totalMs: number
  last: number         // 最后活动时间戳
}
```

- `/state` 需要为每个任务补标题与项目名；标题读取要**加 10 分钟缓存**，否则每次刷新都读会话日志会拖慢面板。
- `/session` 是轻量接口，**不要**做标题解析，只算该任务的聚合值（供头部胶囊 5 秒轮询）。
- `/log` 返回的 `visits[]` 元素：

```ts
{
  sid: string; title: string; project: string; tags: string[]
  start: number; end: number          // 这次使用的起止时间戳
  inputMs: number; readMs: number; totalMs: number
}
```
  `gap` 默认 300000（5 分钟），下限 60000；同一任务相邻段间隔不超过 `gap` 即并入同一次使用。

### 4.5 上报

- 段关闭后 500 ms 内批量 POST `/ingest`。
- 页面隐藏/关闭用 `navigator.sendBeacon`（`Blob` 且 `type: application/json`）兜底。
- 失败可丢弃（不必重试队列），避免无限增长。

---

## 5. 展示规范

### 5.1 数字与对齐

- 所有时长列**右对齐**，`font-variant-numeric: tabular-nums`。
- 合计列加粗；最后活动列用次级色、小一号。
- 表格 `table-layout: fixed`，列宽固定：标签 196px、输入/阅读 88px、合计 96px、占比 132–168px、最后活动 96px。
- 表头 sticky 吸顶，行 hover 高亮，分隔线用最弱的边框色。
- 名称单行省略（`text-overflow: ellipsis`），悬停 `title` 显示全名 + id。

### 5.2 配色（沿用宿主题变量，勿硬编码）

| 用途 | 语义 |
|---|---|
| 页面背景 | `bg-base` |
| 卡片/胶囊底 | `bg-layer-1` / `bg-layer-2` |
| 主文本 | `label-primary` |
| 次文本 | `label-secondary` |
| 进度条 | `brand-primary` |
| 弱边框 | `border-l1` / `border-l2` |

### 5.3 文案要求

- 面板底部固定说明三条：计时规则（含两个阈值）、标签规则、数据位置与隐私（只存时间与 id，不存文本）。
- 空态文案要告诉用户"怎么才会开始计时"。

---

## 6. 边界与已知取舍

| 情况 | 行为 / 取舍 |
|---|---|
| 盯着长文不动 | 超过阅读阈值不计；符合"不翻动就不算" |
| 打字中途长停顿 | 阈值内计入（含停顿），这是有意的 |
| 停表回退 | 空闲停表时按最后活动结算，数字会回退，属预期 |
| 输入法（中文） | 必须监听 `compositionupdate` / `beforeinput`，只监听 `keydown` 会严重低估 |
| 后台标签页 | 定时器被节流，必须用时间戳差值计算，不能用 `setInterval` 累加 |
| 程序化滚动（AI 输出自动滚屏） | 不得中断打字，也不得凭空开始阅读（`ambient` 规则） |
| 光标移动 / 选中文字 | 不得中断输入段（早期版本的 bug 就出在这里） |
| 外部应用阅读 | 不统计，属非目标 |
| 多窗口 | 区间并集，不重复计 |
| 草稿放弃 | 待认领段 10 分钟后丢弃；10 分钟内打开别的任务会被误挂 |

---

## 7. 验收用例（逐条可测）

1. 输入框连续打字 20 秒 → 胶囊"输入"约 20 秒，且每秒递增。
2. 打字后停 30 秒再继续 → 时间连续，不回退（30 秒 < 60 秒阈值）。
3. 打字后停 70 秒 → 停表，且按最后一次按键结算（回退到真实值）。
4. 打字中滚动页面/移动鼠标/选中文字 → 输入段**不中断**。
5. 打字中在聊天区点击 → 输入段立即结束（终点=最后一次按键），阅读段开始。
6. 点击输入框但不打字 → 不产生输入时长；若当时有阅读段则被关闭。
7. 阅读中连续滚动 → 阅读时间持续增长；停 130 秒 → 停表并按最后活动结算。
8. 切换到其他任务 → 当前段立即结束，新任务从零开始（各自归属正确）。
9. 切到别的应用 5 分钟再回来 → 这段时间不计。
10. 新任务空态打 30 秒草稿后发出 → 该任务带上这 30 秒。
11. 同一任务开两个标签页同时滚动 → 该分钟只算一次。
12. 时长跨过 60 秒 → 显示 `1m 05s`，不是 `1m`。
13. 给任务打「工作, xx项目」→ 标签统计表中两个标签各出现一次且各计一次。
14. 面板对齐：数字列右对齐、合计加粗、表头吸顶、hover 高亮。
15. 使用记录：同任务 3 分钟后再用 → 两条记录；间隔 1 分钟 → 合并为一条；每条都有正确的开始/结束时间；时长 = 实际输入+阅读之和，小于首末跨度。
16. 排除规则：只打 3 秒字的输入段不出现；只看了 20 秒的阅读段不出现；35 秒阅读正常计入。

---

## 8. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `inputIdleMs` | 60000 | 输入空闲阈值 |
| `readIdleMs` | 120000 | 阅读空闲阈值 |
| 输入最小段 | 5000 ms | 客户端与服务端同时生效 |
| 阅读最小段 | 30000 ms | 客户端与服务端同时生效 |
| 上报延迟 | 500 ms | 客户端常量 |
| 胶囊轮询 | 5000 ms | 客户端常量 |
| 面板刷新 | 15000 ms | 客户端常量 |
| 待认领窗口 | 10 min | 客户端常量 |
| 标题缓存 | 10 min | 服务端常量 |

---

## 9. 需要在目标平台确认的接入点（Adapter Checklist）

换到别的 Agent 工具时，先确认这些能力，再照本文档实现：

1. **当前任务标识**：能读到"当前会话/对话"的 id；能感知切换。
2. **输入框范围**：能判断一个事件是否发生在输入框内（DOM 容器选择器 / 焦点事件 / 输入框组件回调）。
3. **窗口状态**：`visibilitychange` + `focus/blur` 可用（桌面应用可用窗口焦点事件替代）。
4. **持久化**：能写本机文件或本地库（优先），或至少 `localStorage` + 导出。
5. **统计 UI 落点**：有可插入"主面板页面"和"会话头部小部件"的位置；否则退化为一个独立页面/命令。
6. **服务端聚合**：能在本地跑一个 HTTP 接口或等价的 RPC；否则把聚合放在客户端，但要注意跨窗口去重。

---

## 附录 A：DSH（DeepSeek Harness）参考实现映射

仅作对照，其他平台按第 9 节替换。

| 需求 | DSH 落点 |
|---|---|
| 当前任务 | 在 `conversation.session.header.utilities`（会话作用域 slot）挂一个渲染 `null` 的跟踪组件，挂载=进入任务，卸载=切走；`inject: (sessionId) => ({sessionId})` 拿 id |
| 输入框识别 | `closest('[data-slot="conversation.composer.bar"]')` 或 `textarea / [contenteditable]` |
| 窗口状态 | 浏览器 `visibilitychange` / `blur`（Electron 窗口同样适用） |
| 持久化 + 接口 | 宿主插件用 `ctx.webServer.register({kind:'prefix', path:'/task-time', handler})` 注册路由，落盘到 `$DSH_HOME/task-time/` |
| 统计页 | 注册 `main` keyed slot（key=`task-time`）+ `sidebar.panellist` 图标 |
| 头部胶囊 | 另一个 `conversation.session.header.utilities` 条目，注入 `sessionId` 后轮询 `/session` |
| 标题/项目 | 宿主侧 `ctx.get('sessionQuery').readTitleSnapshots(ids)` 与 `listSessions()`，带缓存 |
| 标签存储 | `tags.json`（也可用 `storageDomain` 域存储） |

## 附录 B：最小实现顺序

1. 客户端状态机 + 本地缓存（不落库，先验证规则是否正确）。
2. 落库接口 + 去重/并集聚合。
3. 会话头部胶囊（实时值 = 已落库 + 未闭合段）。
4. 统计面板：汇总卡 → 明细表 → 标签统计表 → 标签编辑。
5. CSV 导出与文案说明。
6. 按第 7 节逐条验收。
