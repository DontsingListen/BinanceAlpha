# BinanceAlpha 二段扫描项目交接包

本项目拟建立独立的 Binance Alpha 行情扫描与研究系统，持续识别首轮拉升后的回撤、缩量筑底和再次突破，并保留可回放、可人工审核的证据。工程基础选择性借鉴 `aleks-ent/pump-dump-crypto-screener`；二段判断引擎重新实现。

**交付日期：2026-11-05（方案包）；2026-11-06 起 `src/` 下有可运行的首版实现，覆盖发现 → 采集 → 二段判断 → 本地告警。** 用户明确排除 HertzFlow，暂不接入 Freqtrade。本包可脱离原对话阅读，不需要旧项目的账户、数据库或运行环境。

## 阅读顺序

| 文件 | 解决的问题 |
| --- | --- |
| [背景与范围](docs/01-background-and-scope.md) | 为什么另建项目，哪些是用户要求，首版交付什么 |
| [已有研究与选型](docs/02-research-and-selection.md) | 为什么选择底本，源码发现了什么，可以复用哪些模块 |
| [架构与数据契约](docs/03-architecture-and-data.md) | 数据来源、模块边界、身份与时间语义、存储和运行方式 |
| [二段规则规格](docs/04-strategy-spec.md) | 可直接实现的状态机、公式、阈值、失效与确认规则 |
| [分阶段执行计划](docs/05-execution-plan.md) | 工作包、依赖、产物、验收门槛及粗略工作量 |
| [验证与接手指南](docs/06-verification-and-handoff.md) | 第三方从哪里开始，如何审核结果，何时可以验收 |
| [基础架构决策](docs/adr/0001-project-foundation.md) | 选择及取舍；明确哪些设计仍是建议 |
| [社交来源监控](docs/adr/0003-social-signal-sources.md) | X（xAI Grok `x_search`）与 Telegram 用户会话如何接入、隔离与计费 |
| [研究证据目录](evidence/README.md) | 固定提交、许可证快照、源码校验值、来源和文件清单 |

## 当前状态

| 项目 | 状态 |
| --- | --- |
| 独立项目、目标目录、排除 HertzFlow、暂缓 Freqtrade | 用户已明确 |
| 上游提交、许可证、关键源码问题 | 已检查并记录 |
| Alpha 官方接口 | 2026-11-06 本机实测通过，契约差异见 [reports/m0/alpha-data.md](reports/m0/alpha-data.md) |
| TypeScript、SQLite、规则 v0 | 已实现：Node 26 内置 SQLite/TS，零运行依赖，见 [ADR 0002](docs/adr/0002-implementation-stack-and-alerts.md) |
| 应用代码、真实 API 样本采集 | 已有：`src/` 与 `test/fixtures/`；29 个单元/集成测试通过 |
| 上游测试执行（M0.1）、R01/R02 复现（M0.4）、人工复盘界面（M4） | 未开始 |
| 连续运行（M3/M5 门槛）、信号有效性、模拟收益 | 未验证 |
| 自动下单、外部通知 | 不属于本版；告警只落本地，下单作为未来 AlertSink 接入 |
| X/Telegram 来源监控 | 已实现（ADR 0003）：`alpha:social`，20 个 X 账号经 xAI `x_search` 轮询，Telegram 经独立只读会话；提及 → MENTION 告警并钉入采集范围 |

## 接手后的第一步

先完成执行计划中的 **M0 数据与底本可用性检查**：核对固定提交，隔离运行上游测试，采集少量 Alpha 公共行情样本，确认身份映射和分页语义。M0 未通过时，应先解决具体数据或依赖问题，不能以普通 Binance 现货扫描代替 Alpha 验收。

## 运行

要求 Node ≥ 24，`npm install` 只装 typecheck 用的开发依赖。所有命令经 `npm run`，脚本已带 `--use-env-proxy`（需要代理时通过环境变量配置）。

| 命令 | 作用 |
| --- | --- |
| `npm test` / `npm run typecheck` | 单元与集成测试（合成行情、契约、存储、runner） |
| `npm run alpha:probe` | M0 契约探测，写 `reports/m0/probe-*.json` |
| `npm run alpha:discover` | 保存代币/交易对快照，按 alphaId 映射身份，选出采集范围并记录排除原因 |
| `npm run alpha:collect` | 对选中范围做一轮采集（增量 + 有界回填，默认近 7 天）并推进引擎 |
| `npm run alpha:scan` | 只对已存 K 线推进引擎、发本地告警（不联网） |
| `npm run alpha:watch` | 在线循环：每个 5m 收盘后采集 → 判断 → 告警；`-- --once` 只跑一轮 |
| `npm run alpha:simulate` | 对已存历史做 historical-simulation（新 run，显式可得延迟） |
| `npm run alpha:status` / `alpha:alerts` / `alpha:events` | 覆盖、状态机阶段、最近事件与告警（status 含社交段） |
| `npm run alpha:social-plan` | 社交监控干跑：计划中的 `x_search` 请求、预算状态、密钥状态；不发起计费请求 |
| `npm run alpha:social` | 社交监控进程：按 `config/social.json` 的 `x.schedule`（示例每天 10:00、22:00 Etc/UTC）轮询 X 账号列表（需 `XAI_API_KEY` 环境变量）+ 持续消费 Telegram 交接目录；`-- --once` 只跑一轮，`-- --once --force-x [--lookback-hours h]` 不顾定时表立即轮询一次（计费；20 个账号分 5 批、批间隔 10 分钟，约 45 分钟） |
| `npm run alpha:mentions` | 最近被监控来源提及的标的（`-- --hours 48`） |

数据在 `data/alpha.sqlite`（原始响应、K 线版本、journal、事件、告警、租约），告警同时追加到 `data/alerts.jsonl`（在线）与 `data/alerts.historical-simulation.jsonl`。告警等级：DISCOVERY（首轮异动）→ TRACKING → SETUP（筑底、冻结 pivot/失效线）→ **ORDER**（二段突破，下单提醒）→ CONFIRM / EXIT；社交通道另有 MENTION（被监控来源提及）与 MENTION_SETUP（被提及标的正处于活动形态或 24 小时内出现 ORDER），写入 `data/alerts.social.jsonl`。所有告警标注“研究事件，非下单指令”。社交来源配置在 `config/social.json`；xAI 密钥只经环境变量提供；Telegram 登录与部署见 `deploy/README.md`。

交接文件完整性检查仍为：

```bash
python3 tools/verify_handoff.py
```

它只验证交接文件完整性、JSON 和相对链接，不连接交易所，也不验证策略。

## 文档维护约定

规则与参数以 [规则规格](docs/04-strategy-spec.md) 为唯一说明来源，机器可读初稿见 [policy-v0.proposed.json](spec/policy-v0.proposed.json)。参数变更同时更新这两处及规则版本。实现进度记录在执行计划中；只有附有可复现证据的条目才能改为完成。

仓库包含扫描器实现和研究文档。`evidence/` 中的第三方许可证快照仅说明参考项目的许可，不代表为本项目另行授予许可证。

## 私有配置与公开范围

公开版本不包含 API 凭据、Telegram 会话/手机号、私人关注名单、数据库、原始网络捕获或本地助手历史。`config/social.json` 为本地私有文件，已被 Git 忽略；示例默认关闭 X 和 Telegram：

```bash
cp config/social.example.json config/social.json
```

按需在本地填写关注账号、时区并启用来源；缺少私有配置时程序使用关闭来源的默认配置。凭据仅由环境变量或服务器上受限的 EnvironmentFile 提供。部署文档中的 `alpha-host` 是需自行配置的 SSH 别名。

发布前应检查 `git ls-files` 与暂存区，执行密钥扫描；不要强制添加被忽略的私有文件。公开测试使用合成账号；行情样本中的代币合约地址是公共市场标识，不是个人钱包。
