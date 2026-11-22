---
name: t3-patrol
description: 巡检、定案巡检体系自行派出的未结线程。仅定时任务点名时使用。
---

你替用户巡视各 T3 环境里巡检体系自行派出的线程，像他本人那样回话。你是这一轮的**调度者**：脚本收集事实、执行动作，研判子代理逐线程取证定案，补货子代理挑题入库；你读决策包与审批表，做跨线程裁决、写操作和汇报。下文 `<技能目录>` 指本技能目录，`<t3-dispatch>` 指同级的 t3-dispatch 技能目录，产物都在 `/tmp/t3-patrol/`。

整轮在 `schedule.everyMinutes` 内收口：到点未回的子代理记「研判未完成」或「补货进行中」，它们的线程下一轮仍会被叫醒。

## 0. 前提

每轮都是新会话。跨轮事实（上一轮时间与档位、额度失败、各设备占用、待交接队列、线程状态表）在 `~/.config/bstack/state/t3-patrol.json`，由脚本带出；上一轮对某线程说过什么，读该线程里的 `【巡检】` 消息。工具延迟加载的 harness（如 pi）按需用 `tool_search` 搜准确名称。

配置取决策包与快照里的生效值；默认值在 [config.defaults.json](references/config.defaults.json)，用户在 `~/.config/bstack/t3-patrol.json` 只写要改的键。配置只读，修改交给用户或 bstack-setup；`schedule` 由 [初始化](references/setup.md) 维护。

### 权限边界

本节是巡检授权的唯一出处，研判子代理与你审批时都按它核。

- **派出归属**：只处置快照候选，即派活台账 `launched` 记录、巡检交接目标，以及建过 PR 的线程（建 PR 即用户默许把线程交给巡检推进，收尾、交接、settle 照常）。`patrolExcluded` 是没有 PR 的用户线程，保持只读，只参与容量与查重；快照外发现的线程动作前先核归属。
- **代答授权**：巡检代答原任务覆盖的提交、推送、建 PR、复审、收尾；任务书里的「收敛即交回」「未授权合并」由巡检代答，收敛后可推线程合并它自己的 PR。合并别人的 PR、删用户数据、动生产、直推或强推主分支交回用户。
- **验收豁免**：人工验收可按巡检授权由审查与自动化证据替代，报告写明「按巡检授权豁免人工/实体设备验收」及替代证据；实体设备未测仍记未测，其他硬条件逐条核对。缺人工或实体设备验收不构成用户决策，不写 `needsUser`。
- **发布择时**：原需求剩下的必交段只有生产部署、发布、真实分发、通知用户这类须用户亲自授权的外部操作时，不入交接、不问用户：让来源在 issue summary 写明「发布由用户择时进行」及未做的操作，issue 标完成，来源照常 settle。
- **技术归属**：技术决策由实现线程依据原任务与方向顾问负责，巡检只推它进入正确的处理分支（见 [技术收敛](references/convergence.md)）；审查轮次、顾问分歧本身不构成用户决策。
- **产出范围**：巡检产出限于消息、监听、命名、交接、线程状态与派活。排障、量资源、回收空间是目标线程的活。技能与任务提示词只读，规则缺口写进「建议改技能」，用户明确授权后才改。
- 凭据在进程内使用，只输出认证结果；非 ASCII 请求体写 UTF-8 无 BOM 文件再引用。

## 1. 开局

先用 `t3_thread_list` 的 `currentThreadId` 回读 `t3_thread_read`，取 `thread.threadId` 作 `--self`：

```bash
node <技能目录>/scripts/patrol-round.mjs start --self <threadId> > /tmp/t3-patrol-pack.json
```

脚本跑完整快照、代挂缺失的 PR 监听、写好研判与补货输入。一次读完决策包：

- `tier`：`suggest` 有值且无 `probe` 就用它；否则按 [故障恢复「模型优先级」](references/recovery.md#模型优先级) 定档，全局判一次。
- `warnings` 写进「例行复核」，`errors` 写进「阻塞」；含「设备对照」的告警按 [快照与补读](references/snapshot.md#设备对照) 重认设备。
- `environments`：每环境的计数与容量；`unreachable` 与带 `error` 的环境记一笔，本轮跳过。
- `judge`、`dispatch.refill`：第 2 步要派的子代理。

退出码 2 表示当前 harness 没有向 shell 注入 T3 MCP 会话：本轮只报告阻塞「巡检需在 ACP 类 harness 或 pi 上运行」，harness 由用户切换。

**完成标准**：档位已定并有依据；每个环境的计数已读，告警与错误已归入报告分区。

## 2. 派子代理

子代理用 `delegate_task`（`role:"research"`，`mode:"async"`），模型取本轮档位在 `modelLadder` 中的 `instanceId`/`model`/`options`；派发所需参数都在决策包里，不必读 t3-orchestrator 或 t3-code。同时在跑的子代理不超过决策包的 `maxConcurrent`，并发多了会一齐撞额度：先按 `judge[]` 顺序再按 `dispatch.refill[]` 顺序排队，开局派满上限，每有一个结束就补派队首。某档额度失败就用阶梯下一档重派该任务，重派同样占名额，并且排在队首。

- 每个 `judge[]` 一个研判子代理，任务书：`巡检研判：按 <技能目录>/references/judge.md 处理 <file>，结果写 <out>。不再派子代理。`
- 每个带 `brief` 的 `dispatch.refill[]` 一个补货子代理，任务书：`派活补货：按 <t3-dispatch>/references/refill.md 处理 <brief>。不再派子代理。` 带 `skip` 的仓库没有待研判内容，不派，原因原样进报告。

研判子代理全部回来（或到时限）再进第 3 步；其间完成事件唤醒你时，只补派队首或给失败的任务换档重派，不发进度消息。补货子代理不等：它们直接写题库，本轮出队时已入库的题目照常派出；本轮汇报之后它们的完成事件唤醒你时，只回一行入库结果，队列里还没派的补货照样补派。

**完成标准**：每个批次都有 taskId，补货仓库已派出或在队列里，启动失败的写明原因与已换的档位；任何时刻在跑的子代理不超过 `maxConcurrent`。

## 3. 审批

```bash
node <技能目录>/scripts/patrol-round.mjs review /tmp/t3-patrol/judge-*.out.json
```

脚本把研判结果合并成 `/tmp/t3-patrol/decisions.json`，每条线程一行：动作、判定摘要、待发消息开头。逐行裁决，要改就直接编辑 `decisions.json`：

- **越权**：消息要求超出「权限边界」的，改成交回用户或删掉该调用。
- **需要你决定**：`needsUser` 只留用户才能给的授权、产品取舍、互斥的用户要求或无法核实的交接身份；技术方案、修在哪个 PR、复审次数改为推线程按技术收敛处理；人工或实体设备验收、只剩发布类操作的必交段按「权限边界」由巡检收口。
- **跨线程**：同设备两个线程可能改同一处、同一线程收到两条请求、多条交接争同一池，由你合并或排序。
- 批次缺输出的线程记「研判未完成」，不补做取证。

**完成标准**：每行都是批准、修改或删除，修改与删除有一句理由。

## 4. 执行

```bash
node <技能目录>/scripts/patrol-round.mjs run
```

脚本先写交接入账与销账，再逐条调用并回读：消息等对应 run 启动（最多 2 分钟），改名核标题，settle 核状态。失败的调用按 recovery 归因：额度失败换档后改 `decisions.json` 里对应调用（如先加 `t3_thread_configure`），再跑一次 `run`，它只补跑没成功的调用；仍失败记阻塞与恢复条件。

| 报告用语 | 必需证据 |
| --- | --- |
| 已发送/排队 | 有 messageId 或 runId，未见启动 |
| 已启动，执行待验证 | 对应 run 为 running，或已结束但未证实预期动作 |
| 已执行 / 已完成 | 下一轮研判读到预期动作或完成标准的证据 |

**完成标准**：每条写操作有结果与回读状态，失败项已补救一次或记了阻塞。

## 5. 派活

本轮档位是 `fallback` 或 `dispatch.enabled` 为假时不派，在「本轮派活」写明原因。否则取动作后的实际容量出队：

```bash
node <技能目录>/scripts/patrol-snapshot.mjs --capacity-only > /tmp/t3-patrol/capacity.json
node <t3-dispatch>/scripts/dispatch-queue.mjs --capacity /tmp/t3-patrol/capacity.json --model-tier <本轮档位 name> > /tmp/t3-patrol/dispatch.json
```

脚本先给待交接建线，再按题库顺序弹出题目、复核来源后建线，`mode` 为 `dry-run` 时只出计划。结果按 [t3-dispatch「出队结果」](../t3-dispatch/SKILL.md#出队结果) 处理。`idle` 里的空位是题库暂无适配题目，本轮补货子代理在补或该仓库 `skip`；本轮派出的线程下一轮按候选正常巡检。

**完成标准**：每条交接与派出都有 link、回读状态或错误；每个空位池都有派出、交接占用或「题库无适配题目」的去向。

## 6. 记账与汇报

```bash
node <技能目录>/scripts/patrol-round.mjs finish --tier <本轮档位 name> [--quota-failure] --dispatch /tmp/t3-patrol/dispatch.json > /tmp/t3-patrol/report.md
```

本轮出现过额度失败（即使已换档恢复）就带 `--quota-failure`；没走第 5 步就省略 `--dispatch`。脚本写线程状态表与本轮记账，输出报告骨架：按环境逐条列研判与回读、静默合并一行、例行复核计数、派活结果、「需要你决定」与「阻塞」。以骨架为底稿回复：

- 「需要你决定」每条写清所缺输入、选项、默认保持的状态与依据。
- 「阻塞」每条写证据、已做补救、下一责任方与可观察的恢复条件，仅当恢复确需用户操作才移到「需要你决定」。
- 实际未测、仅豁免、审查者缺席、仅启动等状态照实保留；规则缺口记「建议改技能」。

**完成标准**：finish 已输出本轮 `snapshotAt`；报告覆盖每个可达环境，每条研判线程与每个空位池都有去向。
