# 已有研究与选型

## 研究范围与证据强度

检索方向覆盖 meme、二段、second leg、breakout retest、VCP、bull flag、pump dump、Binance Alpha、妖币、持仓量与市值。结果按实际代码、许可证、测试、数据依赖和目标适配度筛选。

2026-11-05 核对了主要候选的 GitHub 元数据、固定提交、关键源码和测试文件结构。**没有运行上游测试，没有复现仓库作者的交易表现，也没有完成全面安全审计。** 文件存在和测试通过是两种不同证据。

完整提交和来源校验值见 [上游快照](../evidence/upstream-snapshot.json) 与 [源码检查记录](../evidence/source-checks.json)。星数只作为当日社区规模快照，不作为策略质量证明。

## 主要候选

| 仓库 | 固定提交缩写 | 本次判断 | 用途 |
| --- | --- | --- | --- |
| [aleks-ent/pump-dump-crypto-screener](https://github.com/aleks-ent/pump-dump-crypto-screener/tree/ec14f855b2fdd65b2c9b039d1b7661d4da6ef26b) | ec14f855b2fd | MIT；6 stars；有测试文件，固定树中未见 GitHub Actions 工作流 | 采集、存储、复盘的工程参考与移植来源 |
| [tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills/tree/d8e71ce2f0b069eb5b6fca352857c168c35e6c46) | d8e71ce2f0b0 | MIT；3644 stars；有测试和 CI；主要面向股票 | VCP 逻辑参考，首版不安装整套 skills |
| [Zikichips/momentum-scanner](https://github.com/Zikichips/momentum-scanner/tree/4017b69509f0986479756f1c7245bc0ace1898b3) | 4017b69509f0 | 二段主题贴近；本次未找到明确许可证 | 流程研究，不作为移植来源 |
| [ChengenH/contract-moniter](https://github.com/ChengenH/contract-moniter/tree/e901d69ec5df79a43052d6c427bbb31455fa222e) | e901d69ec5df | Alpha、OI/市值方向贴近；本次未找到明确许可证 | 需求与失败场景参考，不作为移植来源 |

HertzFlow 是此前研究过的候选，现已按用户要求排除。Freqtrade 暂缓；两者均不进入本方案的依赖、工作包和验收要求。

## 工程底本的可复用部分

底本已有 Binance/Bybit 的公开历史行情与增量采集、事件记录及人工复盘界面。其人工标注与原始检测记录分离，适合借鉴。现有部署依赖 Turso 和 Telegram，需要在新项目中解除；Alpha 接入并非其已具备的能力。[固定版本 README](https://github.com/aleks-ent/pump-dump-crypto-screener/blob/ec14f855b2fdd65b2c9b039d1b7661d4da6ef26b/README.md)

| 上游位置 | 处理方式 | 新项目落点 |
| --- | --- | --- |
| `packages/core` | 检查 HTTP、有限并发、窗口计算等工具；只移植需要且测试可独立运行的部分 | `src/adapters`、`src/application` |
| `packages/archive`、`packages/exchanges` | 参考分页、增量、缓存、失败处理；Alpha 协议独立实现 | `src/adapters/binance-alpha` |
| `packages/db/src/pump-review` | 借鉴机器事件和人工标注分开保存的模式；适配本地 SQLite | `src/storage` |
| 上游 Web reviewer | 先建立页面/依赖清单，再选择性移植图表与标注交互 | `src/web` |
| `packages/pump-detector` | 不直接用于新项目实时信号；其测试场景可指导独立测试设计 | `src/domain` 自行实现 |
| Telegram、订阅者表、PM2 部署、Turso 配置 | 不进入首版依赖 | 无 |

固定树中实际存在的代表性路径列在上游快照的 `selected_paths`。新项目落点为计划目录，当前尚不存在。

每个移植提交必须列出上游路径、完整 commit、改动原因、保留的版权说明及相应测试。若某工具解耦成本高于小范围重写，允许重写并说明理由；不为“基于某项目”保留无用模块。

## 关键源码发现

以下发现固定到 `ec14f855b2fdd65b2c9b039d1b7661d4da6ef26b`，不应无条件套用到未来版本。

| 编号 | 源码证据 | 影响 | 新项目处理 |
| --- | --- | --- | --- |
| R01 | [evaluate.ts 117–129](https://github.com/aleks-ent/pump-dump-crypto-screener/blob/ec14f855b2fdd65b2c9b039d1b7661d4da6ef26b/packages/pump-detector/src/features/evaluate.ts#L117-L129)：`detectSpike` 检查 i 后一至两根收盘价 | 历史 spike 标签可能依赖未来；不等于 i 时刻可知的信号 | 后续确认生成新事件，不能回填更早的可知时间 |
| R02 | [evaluate.ts 87–115](https://github.com/aleks-ent/pump-dump-crypto-screener/blob/ec14f855b2fdd65b2c9b039d1b7661d4da6ef26b/packages/pump-detector/src/features/evaluate.ts#L87-L115)：比较基准遍历整个 supplied series | 历史位置的判断可能随后续数据改变 | 每次计算只接收截至判断时刻的窗口 |
| R03 | [scan-coin.ts 192–225](https://github.com/aleks-ent/pump-dump-crypto-screener/blob/ec14f855b2fdd65b2c9b039d1b7661d4da6ef26b/packages/pump-detector/src/scan-coin.ts#L192-L225)：遍历历史索引，候选使用 openTimeMs；[60 行](https://github.com/aleks-ent/pump-dump-crypto-screener/blob/ec14f855b2fdd65b2c9b039d1b7661d4da6ef26b/packages/pump-detector/src/scan-coin.ts#L60) 将其保存为 timestamp | 开盘时间不能代表基于整根 K 线判断的可用时间 | 分开保存 open、close、observed、emitted 四类时间 |

这些结论针对“将事后分类直接当实时交易信号”的用途，不表示事后分类本身没有价值。M0 应通过最小复现核实影响范围；本包给出的证据是静态源码分析，不是已执行的失败测试。

## VCP 参考的边界

[固定版本 VCP 计算器](https://github.com/tradermonty/claude-trading-skills/blob/d8e71ce2f0b069eb5b6fca352857c168c35e6c46/skills/vcp-screener/scripts/calculators/vcp_pattern_calculator.py) 包含波动收敛、ATR 摆动点和 pivot 等计算。源码参数以股票日线为背景，例如 120 天回看和至少两次收敛。

本方案首版采用更容易审计的固定窗口筑底规则。VCP 作为后续对照实验，不能简单把“天”改成“5 分钟”沿用参数；摆动点的确认时间也必须显式记录。若移植 Python 算法，优先移成纯 TypeScript 函数并保存固定输入输出对照，不新增常驻 Python 服务。

## 其他已检索线索

下列结论来自前轮检查，本包未逐一重新固定提交；实施方若考虑采用，须重新核验。它们不影响当前关键路径。

| 线索 | 未优先采用的原因 |
| --- | --- |
| [Penguin-Life/meme-terminal](https://github.com/Penguin-Life/meme-terminal) | Alpha 展示可参考；此前检查的列表路由只请求前 20 条，不能视为完整资产发现 |
| [CyberPunkMetalHead/Binance-volatility-trading-bot](https://github.com/CyberPunkMetalHead/Binance-volatility-trading-bot) | 异动扫描方向相关，但此前记录的最近推送为 2023 年；不作为新工程主干 |
| [minigoubai/binance-alpha-monitor](https://github.com/minigoubai/binance-alpha-monitor) | 此前看到大型单文件、环境路径耦合，未找到许可证和测试 |
| [juriok/chart-pattern-backtester](https://github.com/juriok/chart-pattern-backtester) | 可研究形态；许可证和表现复现证据不足 |

## 官方 Alpha 数据来源

官方文档已提供公共 REST 行情接口和 WebSocket 行情流。首版采用 REST，以简化持久化和故障复现；实时流保留为后续容量优化方向。准确链接见 [官方来源记录](../evidence/official-sources.json)。

在 2026-11-05 检查中，旧 `/docs/alpha/...` 文档地址不可用，应从当前 `products/alpha` 和 `catalog/advanced-trading-alpha-trading` 页面进入。文档存在不证明部署地区可访问、历史足够长或可以承受目标负载；这些由 M0 采样和 M5 连续运行分别验证。
