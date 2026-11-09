# M0 Alpha 数据可用性检查（2026-11-06）

执行环境：macOS（Darwin 25.2），本机直连，Node v26.4.0，curl + python3 分析。所有请求均为公共接口，无认证。原始响应保存在本会话 scratchpad，脱敏样本写入 `test/fixtures/`。

## 接口与响应形态

| 接口 | HTTP | 响应 | 大小 | 耗时 |
| --- | --- | --- | --- | --- |
| token/list | 200 | `{code:"000000", message:null, messageDetail, data:[686 项], success:true}` | 864 KB | 2.4 s |
| get-exchange-info | 200 | `data:{timezone, assets:[{asset}], symbols:[1467 项], otoEnabled}` | 1.24 MB | 2.6 s |
| klines limit=1500 | 200 | `data:[1500 行]` | 235 KB | 2.3 s |
| klines limit=5 | 200 | `data:[5 行]` | 0.8 KB | 1.6 s |

业务错误码（HTTP 仍为 200）：`-1000 No records found`（远期区间空）、`-1121 Invalid symbol`、`-1130`（limit > 1500）。空数据是业务错误对象而不是空数组。

## K 线契约（实测）

- 每行 12 个字段，**全部为字符串**（包括 openTime 与 closeTime）：`[openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, "0"]`。
- openTime 5 分钟对齐；`closeTime = openTime + 299999`；页内升序、无重复、无缺口（1500 根 ≈ 125 小时）。
- **最后一行是尚未闭合的当前 K 线**，必须按 closeAt ≤ observedAt − 余量 过滤。
- `startTime` 向上对齐到下一个 5m 边界；`endTime` 按 openTime ≤ endTime 过滤；相邻两页首尾恰好相差 1 根，可用 endTime = 上页首根 openTime − 1 分页。
- 服务器 Date 头与本机时钟差 ≤ 1.6 s（Date 头秒级精度）。
- 低流动交易对存在大量零量 K 线（ALPHA_1005USDT 1500 根中 227 根零量）。OHLC 关系全部合法。

## 身份映射

- token list 686 项，alphaId 唯一，无重复；字段含 `tokenId`（opaque）、`chainId`、`contractAddress`、`listingCex`、`offline`、`fullyDelisted`、`listingTime`。
- exchange info 1467 个 symbol；`symbol == baseAsset + quoteAsset` 全部成立；quoteAsset 有 **USDT 564、USDC 586、U 317** 三种（文档只提到 USDT/USDC，`U` 为新发现）。
- status：TRADING 670 / DELISTED 797。USDT+TRADING 共 291 对，全部可通过 `baseAsset == alphaId` 映射到 token list；其中 token `offline=true` 的 10 对（排除）。
- 展示币名冲突真实存在（WARD、NES、UP、TAC、H、SLX、PLAY、AIA、PIGGY、TOWN 各 2 个 alphaId），印证 T01 要求：只按 alphaId 关联。

## 成交额语义差异（关键发现）

token list 的 `volume24h` 与 K 线 `quoteVolume` 24h 合计不是同一口径。对 token list 成交额前 70 的 USDT 对抽样（288 根已闭合 5m）：

| 指标 | 数量 |
| --- | --- |
| K 线 24h 成交额 ≥ 100 000 USDT | 37 / 70 |
| 有量 K 线 ≥ 231 / 288 | 23 / 70 |
| 同时满足 G0 两项门槛 | 22 / 70 |

极端例子：ALPHA_124USDT（quq）token list 24h 成交额 1.03 亿，K 线 24h 合计仅 2 440 USDT；ALPHA_1228USDT（CT）相反，K 线 9.78 亿 vs 列表 233 万。规则 G0 按规格使用 K 线自身的 Q 合计；token list 的 volume24h 只用于采集范围排序，不进入规则。

## 结论

- 数据路径可行：三个接口在本机可用，字段与文档一致，历史覆盖 ≥ 7 天（单页 125 小时，两页即可覆盖 300 根暖机与 7 天目标）。
- 适配器必须：把全字符串行转为校验后的数值；把 `-1000` 识别为"无记录"而非失败；过滤未闭合末行；限制 limit ≤ 1500；按 alphaId 关联身份。
- 采集范围默认按 token list `volume24h` 降序取前 N（默认 50），同时记录排除项及原因；实际活跃度由 G0 用 K 线判断。
- 未验证：长期运行下的限流行为、历史最早可得时间（仅验证了 ≥ 10 天）、WebSocket。M0.1（上游测试隔离运行）与 M0.4（R01/R02 最小复现）未在本次执行。
