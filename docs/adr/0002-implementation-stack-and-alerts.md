# 首版实现技术栈与本地告警边界

日期：2026-11-06。状态：已实施（本 ADR 记录实际采用的选择及与 ADR 0001 建议的偏差）。

## 背景

ADR 0001 建议 TypeScript 单体 + SQLite，并把 pnpm 命令列为"待建立的接口"。实施机器为 macOS，Node v26.4.0，无 pnpm、无 tsx。M0 探测发现 Alpha 接口可用但数据语义与文档假设有差异（见 reports/m0/alpha-data.md）。用户要求把"发现异常代币 → 持续跟踪 → 指标判断 → 下单提醒"跑通，并说明下单功能后续再接。

## 决定

1. **运行时与依赖**：使用 Node ≥ 24 内置能力——`node:sqlite`（SQLite 3.53）、原生 TypeScript 类型擦除、全局 `fetch`、`node:test`。运行依赖为零；开发依赖仅 `typescript`（typecheck）与 `@types/node`。包管理用 npm。代价：TS 只能写可擦除语法（无 enum / 参数属性 / namespace），导入必须带 `.ts` 后缀。
2. **采集范围**：按 token list `volume24h` 降序取前 N（默认 50），`only`/`pinned` 可覆盖；选择策略哈希与全部排除项及原因写入 `universe_snapshots`。偏离文档"按首次见到时间、instrumentId 排序"的默认，原因是 instrumentId 排序会把多数名额用于无法通过 G0 的低活跃对。活跃度判断仍只用 K 线成交额。
3. **告警边界**：决策事件映射为本地告警等级 DISCOVERY / TRACKING / SETUP / ORDER / CONFIRM / EXIT / REJECTED / INFO，经 `AlertDispatcher` 投递到 stdout、`data/alerts.jsonl` 与 SQLite `alerts` 表。`ORDER` 级（SECOND_LEG_BREAKOUT）携带触发收盘、冻结 pivot、失效价（建议止损参考）与"入场只能用 emittedAt 之后第一根开盘"的说明，并标注"研究事件，非下单指令"。未来下单执行作为另一个 `AlertSink` 接入，需单独 ADR、风控与账户边界设计；本版不含任何外部推送或签名能力。
4. **状态机明确化**：每根最多一次 phase 变化；比例阈值用乘法形式比较；GAP 暂停活动 setup、IDLE 退回 WARMUP；已消费 K 线被修订时在同一 run 内发 `DATA_REVISED` 并终止 setup（文档建议的"新 run 重建"留待 M3）。
5. **运行标识**：online run 在 policyHash、schema 版本和源码哈希不变时跨重启复用：崩溃后从 head 继续，正常停止的 run 标记为 `paused` 并在下次启动时重新打开（2026-11-06 修正：此前 `paused` 被当作已结束，每次重启都新建 run 并全量重放历史）；任一变化即新 run，前一个仍打开的 run 标记 `superseded`；事件 id 由 run、instrument、seq、policyHash、种类与 setup 确定性生成，重启不重复。

## 取舍

零依赖换来可审计与易迁移，但 `node:sqlite` 仍标注为活跃开发中的 API，未来 Node 升级可能需要调整；若出现问题，`better-sqlite3` 是等价替代。按 volume24h 选范围会引入对当前热门代币的偏向，研究报告须按 docs/03 标注 CURRENT_UNIVERSE_RETROSPECTIVE。

## 重新评估的触发条件

- 需要 WebSocket 或超过约 120 对的实时覆盖（限速 1 req/s、单请求 ~1.5–2.5 s）。
- 接入真实下单：必须先定义账户、风控、幂等下单与回滚，并更新范围文档。
- `node:sqlite` 行为或 Node LTS 支持变化。
