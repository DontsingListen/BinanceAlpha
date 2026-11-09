# 社交来源监控：X（xAI Grok）与 Telegram 用户会话

- 状态：已采纳（2026-11-06）
- 范围变更：docs/01 原将「X/社交、LLM 判断」列为不纳入；本 ADR 把它们作为**来源监控与证据采集**纳入，仍不改变规则 v0 的判断输入。

## 背景

用户要求：把 先前研究项目 中经 xAI API 访问 X 的能力移植到本项目，对 20 个 X 账号的喊单/提及进行监控；在服务器登录 Telegram 账号，监听指定频道/群组的提及与预警；被提及的标的需要持续跟踪，且可能与现有 Alpha 跟踪范围重合。

## 决定

1. **社交信号与 K 线规则分离**。`src/domain/step.ts` 的 G0–G5 只接收闭合 5m K 线，社交提及永远不进入规则输入。社交是并行的「发现与关注」通道：提及 → 解析成 Alpha instrument → (a) 钉入采集范围持续跟踪，(b) 本地告警 MENTION / MENTION_SETUP，(c) 在后续 K 线告警 payload 中附带社交上下文。规则结果的可复现性不受 LLM 不确定性影响。
2. **证据优先、可重放**。每次 xAI 请求保存请求哈希、模型、提示版本、原始响应（gzip）、用量与成本（`usage.cost_in_usd_ticks`）；每条帖子/消息保存原文与来源 ID；提取出的提及保存提取器版本（`regex-v1` / `grok-<model>-<promptVersion>`）、匹配方式、解析结果与候选。对已存帖子可离线重新提取，不需再调 API。
3. **X 访问方式**：xAI Responses API（`POST /v1/responses`）的服务器端工具 `x_search`，`allowed_x_handles` 限定 20 个账号（接口上限 20），`from_date`/`to_date` 为 UTC 日期、上界不含，输出用 `text.format = json_schema` 结构化。传输层（超时、2 MB 上限、密钥脱敏、`/v1/api-key` 预检、成本视图）移植自 先前研究项目 `x-research.mjs`；用途从单币研究改为按账号列表的定时轮询。成本控制：每次请求预算、每日预算（按 `cost_in_usd_ticks` 累计，超过即自动暂停到次日 UTC）、`max_turns` 上限。轮询节奏由 `x.schedule`（墙钟时间 + IANA 时区；示例为每天 10:00、22:00 Etc/UTC，即每天两次）决定，是否到点由已落库的轮询记录判定：每个时间槽只计费一次，进程重启不会追加请求；失败后 `retryDelayMs`（30 分钟）再试、每槽最多 `maxAttemptsPerSlot`（3）次；`lookbackMs` 必须覆盖相邻两次轮询的最长间隔（13 小时）。不配 `schedule` 时退回 `pollIntervalMs` 间隔模式。提示词（`x-handle-poll-v5`）与分批来自 2026-11-07 的线上验证：账号清单和当前时间必须写进正文（只靠工具的 `allowed_x_handles` 模型看不到账号，会以"未提供账号"直接返回空列表而不搜索）；查询里不能带 `since:`/`until:` 等时间算子（一律失败）；并行搜索一批会几乎全部失败（20 个里 19 个），连续顺序搜索约 15 次后（10～15 分钟内）也开始失败，因此一次轮询拆成 `batchSize`（4）个账号一请求、请求间隔 `batchDelayMs`（10 分钟），没有拿到证据的批在最后再排队一次，服务循环把各批与 Telegram 消费交错执行而不是阻塞（一轮约 45 分钟）；同一帖子同一代币只发一条 MENTION 告警（regex 与模型两条提及记录都保留）；请求内 `parallel_tool_calls=false` 逐个账号 `from:<handle>`、失败不重试也不提前停止（任何"失败就停止并返回空列表"的指令都会让模型丢掉已找到的帖子）；单次查询上限 10 条帖子；工具的 `from_date` 取窗口起点的前一天（取当天时，当天早些时候的帖子一条也不返回）。同一轮的各批共用 `windowTo`，调度上算一次尝试。手动验证用 `alpha:social -- --once --force-x --lookback-hours 13`（计费）。用量里 `num_server_side_tools_used = 0` 的回答记为 `XAI_NO_SEARCH`，搜索调用全部失败的记为 `XAI_SEARCH_FAILED`：都按真实成本入账、丢弃帖子、不算该槽完成，由重试策略（30 分钟后、每槽最多 3 次）再试。X 搜索按抓取条目计费（$5/1k 帖子、$10/1k 资料），单次请求可能超出预算，报告的成本是事后核对值。
4. **Telegram 访问方式**：MTProto 用户会话（Telethon），沿用 先前研究项目 的隔离模型：独立 Unix 用户 `binance-alpha-telegram` 持有 API ID/Hash、会话与游标（`/var/lib/binance-alpha-telegram/private`，0700）；只读取显式加入白名单的频道/群组，不枚举聊天、不发消息、不入群；精简后的消息（chat/消息 ID、时间、发送者 ID/用户名、正文、链接）写入交接目录 `/var/lib/binance-alpha/telegram-inbox`（2770），Node 进程读取、入库、确认并删除。登录只能由用户在终端交互完成（手机号、验证码、两步验证密码不经过本项目日志或聊天）。
5. **进程边界**：新增 `alpha social` 进程（systemd `binance-alpha-social.service`），持有 `social-writer` 租约，只写 social_* 表与 `alerts`；`watch` 仍是 K 线/引擎表的唯一写者；两者经同一 SQLite（WAL，busy timeout）松耦合。xAI 密钥经 systemd `EnvironmentFile`（`/etc/binance-alpha/social.env`，root:binance-alpha 0640）提供，不进仓库、不进日志。
6. **提及解析**：合约地址（唯一）> alphaId > `$cashtag`/显示符号 > 代币名。显示符号冲突（WARD、NES、UP 等）解析为 AMBIGUOUS 并列出候选；裸符号（无 `$`）长度 <3 或在停用词表内不计为提及；非 Alpha 标的记为 UNRESOLVED 但仍保留并告警，以便人工跟踪。
7. **告警边界不变**：仍只落 stdout / `data/alerts.social.jsonl` / SQLite，不推送、不下单。新增等级 MENTION（被监控来源提及）与 MENTION_SETUP（被提及的 Alpha 标的当前处于 IMPULSE/PULLBACK/BASE/BREAKOUT 或 24 小时内出现 ORDER）。
8. **范围钉入**：最近 `pinHours`（默认 24 h）内有 UNIQUE 解析提及的 instrument 进入采集范围，上限 `maxPinned`（默认 20），在 top-N 之外追加；selectionPolicy 记录该规则，快照 members 记录 `socialPinned`。这同时缓解 top-50 轮换丢标的的问题，但未覆盖「有活动 setup 的标的掉出范围」。

## 取舍

- LLM 抽取不可复现：用结构化输出 + 引文核对（`url_citation` 注解中出现的帖子标记为 API_CITATION，仅出现在正文的标记为 MODEL_TEXT）缓解，但不能证明帖子内容真实；告警注明「模型抽取，未独立核实」。
- Python 旁路进程打破 TypeScript 单栈：换取账号会话与主进程的硬隔离，且复用已在 先前研究项目 验证过的登录/冷却/游标逻辑。gramjs 可在 Node 内完成同样功能，但会把账号会话放进告警进程。
- 成本上限只能事后核对：xAI 无按密钥的花费上限，单次请求可能超出预算；每日预算是自动暂停阈值而非硬保证。
- 头部 20 个账号一次请求即可覆盖；更多账号需分批（每批 ≤20）并按批计费。

## 重新评估的触发条件

- xAI 调整 `x_search` 参数或计费口径；每日成本持续高于预算。
- 需要把社交提及作为规则输入（例如「仅在被提及后 N 小时内才允许 IMPULSE」）：须新版规则规格与 policy。
- Telegram 要求的频道数超过 10，或需要读取私聊/全局更新流。
- 告警需要外推（Telegram/邮件）或接入下单：另立 ADR。
