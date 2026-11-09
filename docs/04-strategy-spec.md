# 二段规则规格

## 规则定位

规则版本为 `second-leg-v0-proposed`。以下数值是为了让首版可实现、可测试而设定的研究基线，**没有被本次研究证明有效，也不是从上游回测中得到的最优参数**。参数初稿见 [policy-v0.proposed.json](../spec/policy-v0.proposed.json)。

v0 只使用同一个 Alpha USDT 交易对的已闭合 5m K 线。1h 上下文用于展示，不参与硬性触发。输出是研究事件，不是下单指令。VCP、多因子评分、回踩买点均不加入 v0，以便明确判断究竟哪条规则造成结果。

## 输入与纯函数契约

建议接口：`step(previousState, input, policy) -> { nextState, events }`。输入包含规范行情、可知时间、质量状态、显式时刻和历史窗口；函数不读取网络、文件、数据库、系统时间或随机数。

同一 instrument 的 input_journal 使用递增序号。所有窗口只能截至当前输入，包含关系按下文明确规定。只有数据已实际可知时，在线引擎才消费它；历史补算的事件不得伪装成按时到达。

## 状态与数据质量

| 状态 | 含义 |
| --- | --- |
| WARMUP | 连续有效数据不足，不能构造完整基准 |
| IDLE | 可以判断，但没有正在跟踪的 setup |
| IMPULSE | 已识别一次上涨，持续观察其高点和回撤 |
| PULLBACK | 回撤达到下限，冻结这一轮上涨的基准与高点 |
| BASE | 已出现收缩区间，冻结突破位和失效线 |
| BREAKOUT | 已发出二段突破研究事件，等待后续确认 |
| CONFIRMED | 突破后达到确认规则；该 setup 结束 |
| INVALIDATED | 价格结构破坏或数据修订使原判断不可继续；该 setup 结束 |
| EXPIRED | 生命周期或确认窗口结束；该 setup 结束 |

每个 instrument 同时只允许一个活跃 setup。终态之后冷却 24 根有效 5m K 线，再回到 IDLE；期间仍收集结果数据。终态不能改变之前已经记录的 BREAKOUT 事件。

`dataQuality` 独立于上述状态，取 OK、GAP、STALE、CLOCK_UNCERTAIN、IDENTITY_CONFLICT 等。缺数据保留原状态并暂停推进；到期时钟仍可触发 EXPIRED。暂停不是新的筑底证据。

## 参数和通用记号

`C[t]、H[t]、L[t]、V[t]、Q[t]` 分别为收盘、最高、最低、基础资产成交量和 USDT 成交额。所有窗口为闭区间，`max` 和 `median` 均只访问所列下标。样本中位数按排序后中间值定义，偶数长度取中间两值的均值。

| 参数 | v0 默认值 | 用途 |
| --- | --- | --- |
| timeframe | 5m | 唯一触发周期 |
| warmupBars | 300 | 包含当前根的最少连续历史 |
| impulseBars | 12 | 上涨观察窗口 1 小时 |
| baselineBars | 288 | 触发窗口之前的 24 小时成交基准 |
| minQuoteVolume24h | 100000 USDT | 进入 IMPULSE 和发出 BREAKOUT 前的成交额门槛 |
| minPositiveVolumeFraction | 0.80 | 最近 288 根至少 231 根基础成交量大于零 |
| impulseReturnMin | 0.20 | 首轮窗口涨幅至少 20% |
| impulseVolumeRatioMin | 3.0 | 首轮平均成交量相对先前基准至少 3 倍 |
| pullbackMin / pullbackMax | 0.25 / 0.65 | 相对首轮涨幅回撤 25% 至 65% |
| baseBars | 6 | 筑底观察窗口 30 分钟 |
| baseRangeMax | 0.08 | 筑底窗口高低区间最多 8% |
| baseVolumeRatioMax | 0.50 | 筑底中位成交量最多为首轮平均量的一半 |
| breakoutBuffer | 0.003 | 收盘价超过冻结突破位 0.3% |
| breakoutVolumeRatioMin | 2.0 | 突破根成交量至少为冻结筑底中位量的 2 倍 |
| breakoutExtensionMax | 0.08 | 突破收盘最多高于突破位 8% |
| baseStopBuffer | 0.02 | 筑底低点下方 2% 的结构失效缓冲 |
| confirmationBars / confirmationWindowBars | 2 / 6 | 后续 6 根内有连续 2 根收盘不低于突破位 |
| setupTtlHours | 72 | 自 IMPULSE 触发根 closeAt 起的总寿命 |
| cooldownBars | 24 | 终态后的有效 K 线冷却数 |
| freshnessMaxMs | 600000 | 在线事件的新鲜度标签门槛 |

阈值取等号时按公式中的 ≥、≤、>、< 实现；不自行添加隐含 epsilon。除法分母为零、字段缺失或结果非有限数值时，返回明确原因，不能替换成 0。

## G0 数据与活跃度门槛

需要连续 300 根有效闭合 K 线，身份和报价一致。进入 IMPULSE 或从 BASE 发出 BREAKOUT 时，另要求最近 288 根的 Q 总和 ≥100000、V 大于零的比例 ≥0.80。

成交额门槛失败是“不满足活跃度”，不是缺数据。已有候选仍检查结构失效和到期；只有新触发受此门槛拦截。相关排除也写入运行统计，避免只保留成功样本。

## G1 识别首轮上涨

IDLE 状态在 t 根闭合后，定义：

- B = C[t−12]。
- r = C[t] / B − 1。
- baselineVolume = median(V[t−299…t−12])，共 288 根。
- impulseMeanVolume = mean(V[t−11…t])，共 12 根。
- volumeRatio = impulseMeanVolume / baselineVolume。

同时满足 G0、r ≥0.20、volumeRatio ≥3，以及 C[t] > max(H[t−12…t−1])，进入 IMPULSE。保存 B、初始上涨窗口、固定 impulseMeanVolume 和 activationCloseAt；P 初始化为 max(H[t−11…t])。

“首轮”仅指当前观察窗口内首次满足规则的上涨，不宣称是代币上市以来第一波或全历史 ATH。

## G2 跟踪与冻结回撤

IMPULSE 状态每根更新 P = max(P, H[t])，高点相等保留较早时间。计算 d = (P − C[t]) / (P − B)。B 不变。

- d >0.65：INVALIDATED，原因 `IMPULSE_RETRACEMENT_TOO_DEEP`。
- 0.25 ≤d ≤0.65：进入 PULLBACK，冻结 P 和 B；记录 pullbackCloseAt。
- d <0.25：继续 IMPULSE。

冻结后的原始支撑线为 B + 0.35 × (P − B)。PULLBACK 阶段收盘低于它则失效；收盘高于冻结 P 则结束为 INVALIDATED，原因 `NEW_IMPULSE_WITHOUT_BASE`。它表示当前二段定义未成立，不表示市场一定转坏。

## G3 形成筑底

从进入 PULLBACK 后的下一根开始计数，至少有 6 根连续有效 K 线。最近 6 根必须全部处于冻结后阶段，同时满足：

- 所有收盘均位于原始支撑线与冻结 P 之间，端点允许相等。
- (max(H) − min(L)) / min(L) ≤0.08。
- median(V) / impulseMeanVolume ≤0.50，且 median(V) >0。

满足后进入 BASE，冻结 pivot = max(H)、baseLow = min(L)、baseMedianVolume = median(V)。冻结 invalidationPrice = max(原始支撑线, baseLow ×0.98)。冻结后的 pivot 和 invalidationPrice 不随新 K 线追涨移动。

形成 BASE 的同一根 K 线不得发 BREAKOUT；每根最多发生一次形态状态迁移。

## G4 二段突破事件

BASE 状态先检查失效与到期。随后要求 C[t−1] ≤ pivot ×1.003 且 C[t] > pivot ×1.003，构成首次或重新越过门槛。

在越过门槛的这一根，G0 活跃度通过、V[t] / baseMedianVolume ≥2 且 C[t] / pivot −1 ≤0.08，进入 BREAKOUT 并记录 `SECOND_LEG_BREAKOUT`。

越过门槛但量能不足或涨幅过大，记录 `BREAKOUT_REJECTED` 及原因，仍保留 BASE。价格必须先回到门槛以内，再重新越过，才重新评价突破；不能在持续高于门槛时每天重发信号。

事件保存冻结 pivot、失效线、上涨和筑底区间、每项实测值、数据版本及可知时间。实时迟到超过 10 分钟仍保留事件，但 `isFresh=false`，展示为历史补算。

## G5 后续确认与失效

BREAKOUT 后从下一根开始，6 根有效 5m K 线内若有连续 2 根 C ≥ pivot，进入 CONFIRMED。确认是新的事件；BREAKOUT 的原始时刻与内容不改变。

在 PULLBACK、BASE、BREAKOUT 阶段，收盘严格低于对应冻结失效线即 INVALIDATED。影线触及但收盘未破，不触发这一条；报告必须说明 v0 是收盘失效口径。任何活动状态自 activationCloseAt 起达到 72 小时即 EXPIRED。BREAKOUT 第 6 根仍未确认时 EXPIRED，原因 `CONFIRMATION_TIMEOUT`。

同一输入优先级：身份/数据修订事件 → 总寿命到期 → 有效数据检查 → 结构失效 → 本状态的正常迁移。BREAKOUT 第 6 根可先满足确认，再判断确认窗口超时。结构失效优先于确认，所有边界都有专门测试。

## 必需原因码

至少包含 `WARMUP_INCOMPLETE`、`CANDLE_GAP`、`STALE_INPUT`、`IDENTITY_CONFLICT`、`CLOCK_UNCERTAIN`、`LOW_ACTIVITY`、`ZERO_VOLUME_BASELINE`、`IMPULSE_DETECTED`、`PULLBACK_CONFIRMED`、`BASE_FORMED`、`SECOND_LEG_BREAKOUT`、`BREAKOUT_LOW_VOLUME`、`BREAKOUT_OVEREXTENDED`、`SUPPORT_BROKEN`、`CONFIRMATION_TIMEOUT`、`SETUP_EXPIRED`、`DATA_REVISED`。

实现可增加细分原因，但不能只输出一个分数而丢掉实际触发值。

## 参数实验和未来表现

v0 先冻结再采样。任何阈值搜索只使用开发区间，另留按时间隔离的验证区间；间隔至少覆盖 72 小时 setup 寿命加 24 小时结果窗口，即 96 小时，防止重叠事件跨区间泄漏。

近 7 天只是首次采集目标，不是完整实验长度要求。扣除暖机和区间隔离后若样本不足，应继续前向采集或获取更长的可验证历史，不能缩短隔离期来凑结果。

默认分别报告突破后 1h、4h、24h 的期末变化、最大有利波动 MFE、最大不利波动 MAE。先报告原始形态结果；若计算模拟交易收益，另写入场、退出、费用、滑点、成交能力和同根触发顺序假设，不能把 MFE 当作可实现收益。

原始形态统计以触发根 C[t] 为参照，窗口从 decisionBarCloseAt 起算，只纳入在窗口内完整闭合的后续 K 线。MFE = max(后续 H) / C[t] −1，MAE = min(后续 L) / C[t] −1，MAE 保留正负号；期末变化用窗口最后一根收盘计算。没有完整窗口则标记删失。迟到信号单独分组，不能列入“及时在线信号”的表现。

真实事件的假设入场只能采用 openAt ≥ emittedAt 的第一根 K 线开盘，并记录额外等待；历史模拟采用模拟 availableAt 之后同样口径。这种入场后统计与上述触发价统计分开。结果数据不足时标记右删失，不以零收益或失败补齐。对固定失效线与目标位同根触及而无法确定先后者，使用更细数据或报告保守/乐观边界，不能挑选有利顺序。
