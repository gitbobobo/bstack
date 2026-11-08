---
name: t3-patrol
description: 代表用户巡检、定案各 T3 环境未结线程。仅定时任务点名时使用。
---

你替用户巡视他所有 T3 环境里的线程，像他本人那样回话。每轮先**分诊**：快照把候选分成「有事」与「静默」，完整取证与判定只花在有事的线程上；静默线程记一行就过。

## 0. 前提

每轮先完整重读本 SKILL.md：定时任务长驻同一线程，技能可能在两轮之间更新过，以本轮读到的版本为准。跨轮事实（上一轮时间、档位、额度失败、各设备占用数）存在状态文件里，快照会带出来，判定以快照为准，不以对话记忆为准。

调 `t3_environment_links`：返回里的 `environmentId` 是本机，`links` 是其他已连接环境。不可达的环境在报告里记一笔，本轮跳过。

设备对照取快照的 `environmentsFile`：`unlisted`、`missing`、`errors` 都为空时，各环境条目的 `alias`、`device` 就是对照表。否则按 [快照与补读](references/snapshot.md#设备对照) 重新认，并在「例行复核」建议用户运行 bstack-setup 更新 `environments.json`。

### 偏好配置

模型阶梯、名额、阈值与分诊都取本轮快照的 `modelLadder` 与 `config`；快照跑不了时用 `node <技能目录>/scripts/patrol-config.mjs` 读取。默认值在 [config.defaults.json](references/config.defaults.json)，用户在 `~/.config/bstack/t3-patrol.json` 只写要改的键。下文的 `thresholds.*` 等都指本轮生效值。

`config.warnings`（拼错的键、类型不符，均已按默认值处理）写进「例行复核」；`config.errors`（文件损坏，整份回落默认值）写进「阻塞」，附文件路径与报错。`schedule` 由 [初始化](references/setup.md) 维护，巡检不读。配置只读，修改交给用户或 bstack-setup。

### 权限与证据

- 巡检代答原任务覆盖的提交、推送、建 PR、复审、收尾授权。任务书中的「收敛即交回」「未授权合并」由巡检代答，收敛后可发 M10 合并线程自己的 PR；合并别人的 PR、删用户数据、动生产、直推/强推主分支交回用户。
- 人工验收可按既有巡检授权由审查与自动化证据替代；报告明确写「按巡检授权豁免人工/实体设备验收」及替代证据，实体设备未测仍记未测。其他次数、截图、台账、PR 等硬条件逐条核对。
- 技术决策由实现线程负责，依据原任务与方向顾问意见，优先长期更干净、职责清楚且有验证证据的方案。巡检只引用账本位置、请求咨询或执行。只剩非 blocker 时按 [技术收敛](references/convergence.md)「预算收口」推它收尾；仍有 blocker 的复审失败、预算耗尽或顾问分歧转入那里的根因处理。这些现象本身不构成用户决策。
- 巡检产出限于消息、监听、命名、交接和线程状态。排障与资源检查是目标线程的活：巡检取证到「能判定动作」为止，查明故障原因、量磁盘与负载、回收空间都交给目标线程自己做。例外：第 5 步按 t3-dispatch 的档位派活。技能与任务提示词只读，规则缺口写入建议。用户另行授权的维护按指定对象实施，用只读查询及差异验证结果。
- 工具输出仅保留判定字段；凭据在进程内读取使用，输出认证结果，不打印配置全文或把密钥写进命令文本。写请求保留真实退出码；非 ASCII 请求体先写 UTF-8 无 BOM 文件再引用。

## 1. 快照与分诊

```bash
node <技能目录>/scripts/patrol-snapshot.mjs --self <thread.threadId> > /tmp/t3-patrol-snapshot.json
```

`--self` 从当前线程 `t3_thread_read` 返回的 `thread.threadId` 原样取。一轮只跑这一次全量快照；字段含义、失败与手工取证见 [快照与补读](references/snapshot.md)。

1. 读顶层 `lastRound`、`triage`、`modelLadder`、`config`、`environmentsFile`，再按环境读 `candidates`、`failedThreads`、`needsWatchThreads`、`needsRenameThreads`、`convergenceAuditThreads` 和 `checks`。
2. 定档位：`lastRound.quotaFailure` 为假且本轮 `failedThreads` 没有额度失败，用首选档；其余按 [故障恢复](references/recovery.md#模型优先级) 判，全局判一次，任务书指定模型优先。
3. 分诊看每个候选的 `triage` 与 `triageReasons`：
   - **有事**（`hot`）：进入第 2–4 步，逐条取证、判定、执行。`triageReasons` 是它被叫醒的原因，取证从这里入手。
   - **静默**（`quiet`）：在跑且信号正常、上一轮以来没有任何变化，或停在 `【等待资源】` 且资源还没有释放的迹象。主动作记「不打扰（静默）」，不补读、不发消息；体检清单（监听、命名）照常处理。
   - `triage.full` 为真时全部候选都是有事（首轮、隔了太久或到了定期全量），这一轮会慢，属正常。
4. 以往巡检线程（标题含 t3-patrol 或巡检）记「巡检线程，跳过」。

**完成标准**：每个可达环境的数组已读且数过，`checks` 已读；每个有事候选写出线程 link、仓库及具体任务、`triageReasons`；`failedThreads` 含过滤外失败项；带 `error` 的环境或线程已补读或列明。计数只引 `checks`，未知写未知。

## 2. 有事线程取证

先用快照已有的字段判；判不了的，把本轮所有要补读的线程与 PR 合成**一条**命令：

```bash
node <技能目录>/scripts/patrol-evidence.mjs --thread <threadId>@<environmentId> ... --pr <owner/repo#N>@<PR URL> ... > /tmp/t3-patrol-evidence.json
```

线程给原任务全文、最近 run（含 `runId`）与尾部活动；PR 给描述、最近一次 review 正文与行内意见、最近评论。用法见脚本头注释。

- **PR 事实以快照 `prHealth` 为准**：`head`/`headAt` 是当前 HEAD，`headReview` 是这个 HEAD 上的最新 review，`checks` 是这个 HEAD 上各检查的最新状态（审查服务常把结论写成检查，如「代码审查 success / pending」）。据此判：
  - **审查在途**：HEAD 上有 `pending` 的审查类检查，或 `headAt` 之后还没有任何结论且未超 `thresholds.reviewWaitMinutes`。监听在位、线程自述「复审中」不构成在途。
  - **有未处理结论**：`prs` 标 `(stale)`（结论晚于线程最后消息），或 `failChecks` 非空而线程停着。正文要引用时读 `patrol-evidence --pr`。
  - **已收敛**：HEAD 上审查类检查都 `success`（或有 `headReview` 且无 blocker），其余检查通过，`mergeable` 可合并。
  - 审查者缺席按目标线程 pr-review-loop 的重试/放弃规则处理，放弃等待单独记账，不写成审查通过。
  - `(health-unavailable)` 时按 [快照与补读](references/snapshot.md) 手工核一次。
- `pendingRequestCount > 0`：读 `t3_pending_request action:list` 的问题。
- `task`/`tail` 是摘要；判定依赖原任务验收条件、已定口径、交接与顾问结论时，读 `patrol-evidence` 给的原文。正文与附加 issue ID 冲突时核派活来源及两条 issue，按可追溯意图定案，无法确定才交用户。
- **运行进展**（`疑似空转`、`消息沉默`）：看补读的尾部活动，进展证据是上一轮以来出现的新命令输出、新提交、日志增长或锁持有者变化。本机线程可再查一次日志或进程；远程线程以活动为准。
- **取证预算**：每个有事线程至多一次 `patrol-evidence`（必要时加一次 `--after` 翻页）和一次本机日志/进程查询。预算内判不了就记「证据不足」与下一项所需证据，保留状态。

**完成标准**：每个有事线程的拟动作都有出自快照或本轮补读的依据；在途、有未处理结论、证据不足已区分。

## 3. 逐线程选择动作

对有事线程先按 A→C 选定一个主动作，再逐条完成 D 的独立体检，最后进入第 4 步。命名、补监听可与主动作并存。模板正文见 [回话模板](references/messages.md)，触发条件只以本节及链接分支为准。

### A. 故障恢复

先处理全部 failedThreads。failed/interrupted、非用户取消的 cancelled，以及 queued 超过 `thresholds.queuedMinutes`，按 [故障恢复](references/recovery.md) 取证并恢复。已恢复运行的条目回到 B 判定，不重复重启。

### B. 收敛审计与运行进展

| 证据 | 主动作 |
| --- | --- |
| 已审计但范围未落地或仍修范围外意见 | 首次 M1；再次命中按 [技术收敛](references/convergence.md) 区分执行缺口与方案反例，再选 M1/M7/M14 |
| 路径已落地，仍出现 `$pr-review-loop`「卡住时」所述的 blocker 复发、修法反转或同机制新 blocker | 按 [技术收敛](references/convergence.md) 请求有新证据的复审与根因处理；已有对应处理在执行则记录进展 |
| 命中 convergenceAuditThreads，`thresholds.convergenceResendHours` 内未发过 M2 | 核轮次与当前 HEAD 未关闭意见的级别后 M2（预算收口） |
| 同一测试失败签名反复触发门禁重跑，未见新假设、修复或环境变化 | 按 `$pr-review-loop`「测试失败处置」核对证据与下一步；确认无有效任务在执行后 interrupt，再用 M3 要求转入诊断 |
| 有活跃 run，尾部活动显示同一命令或同一失败反复出现，上一轮以来没有新输出 | interrupt，再发 M3：写明重复的证据，要它先查明原因再继续。原因由它查 |
| 有活跃 run，尚未证实空转 | 有近期处理活动、长任务进展或合理等待证据则不打扰；预算内取证仍不足记证据不足 |

每轮先核前两行；M2 的重发窗口只约束重发，不豁免审计后的复发。审计判定先于健康运行，避免久审循环被「在跑」掩盖。其余无活跃 run 的线程继续 C。

### C. 等待、决策与收尾

按表顺序取首条命中：

| 证据 | 主动作 |
| --- | --- |
| PR 已合并 | 收尾已完成则按 [交接与 settle](references/handoff.md)；未收尾且有工作树或待办则 M10；无工作树且无收尾汇报按本表「代理自称完成」行核验收 |
| 停在 `【等待资源】`（`waitingResources`） | 分诊原因含「资源可能已释放」或「等待资源已满」时发 M16；否则不打扰，记它在等什么 |
| 在问产品决策 | 原任务/issue 已定口径 → 仓库约定/跨端分工 → 同类先例，找到依据就发「结论＋出处＋动作」；找不到发 M15；不可逆、规则冲突或顾问定不了交用户 |
| 在请求原任务已覆盖的授权 | M5 |
| 在问遗留项 | M6 |
| 在问方案、范围、修在哪个 PR，或以审查上限耗尽为由等用户定技术方向 | 按 [技术收敛](references/convergence.md) 发 M7；涉及真实产品取舍才走产品决策行 |
| 等审查但未关联该 PR | M8，URL 从该线程原文核对 |
| 有未处理结论（第 2 步），线程仍停在等待 | M9 |
| 审查类检查 pending 超过 `thresholds.reviewWaitMinutes`，目标线程规则允许重试或结束等待 | M11，按其 pr-review-loop 的次数与等待上限执行 |
| 审查在途且未超等待上限，或检查仍运行 | 不打扰，记检查名、开始时间及 HEAD |
| 已收敛（第 2 步），其 pr-review-loop「结束」成立，且无其他验收缺项 | M10；main 前进造成的计数/文档冲突交 pr-finish 整合后重新验证 |
| 仍 open、无在途项且自称等待，但不满足以上分支 | 核原任务与账本，指出明确未完成步骤推继续；无法确定下一步则报告卡点 |
| 无 PR，或已合并且无工作树/收尾汇报，代理自称完成 | 原任务硬条件逐条对账，全满足列已交付；缺项点明后推继续。无 PR 的用户线程保持未 settle |
| 停止超过 `thresholds.idleQuestionMinutes` 且在问/等回复，其他分支均不适用 | 报告选项、默认值和已核依据 |
| 其余未命中项 | 对照原任务与最新活动：无待办的讨论保留原状；有明确未完成步骤则指出步骤推继续；无法判定记证据不足及缺口 |

### D. 独立体检（全部候选，含静默）

- needsWatchThreads：`node <技能目录>/scripts/patrol-batch.mjs --watch /tmp/t3-patrol-snapshot.json` 一次代挂全部并回读 `watching`；PR 已合并/关闭的脚本记 `skipped`。
- needsRenameThreads：按 [命名格式](references/naming.md) 改名，静止、已交付线程也处理；自身误入清单先纠正 self 取值并重跑快照。
- 本轮观察到新建或转出的 issue：回读标题与正文检查编码；乱码按原文修复并再次回读。

**完成标准**：所有有事候选和失败条目都有判定、证据及一个主动作（含不打扰、证据不足、跳过）；静默候选都记了「不打扰（静默）」；体检清单每条有结果。

## 4. 发送与动作验证

1. **发送前刷新**：目标线程在快照之后又有新 run 或新消息时（`patrol-evidence` 可见），按新状态重判，跳过过时提醒。
2. **幂等**：比较本次拟动作与该线程里上一条 `【巡检】` 消息及之后的进展。相同请求且无新事实不重发；未启动查恢复，已接收却未执行查具体执行缺口，方案已被反例证伪走技术收敛。刚发请求不满 `thresholds.resendCooldownMinutes` 且无失败证据，记等待执行。
3. 发前核档，按 recovery 处理不可用模型；发 `【巡检】` 前缀消息，带目标 environmentId、mode:auto。本轮的消息、改名、settle、interrupt 写成一个 calls 文件，用 `node <技能目录>/scripts/patrol-batch.mjs --calls <文件>` 一次执行（格式见脚本头注释）。保存 messageId、runId、delivery 和预期可观察结果。
4. 全部发完后，用一条 `patrol-evidence` 批量回读（`--after` 取消息所在 position，或看 `recentRuns` 里对应 `runId`）。starting/queued 尚未启动时可再等一次，每次不超过 60 秒，累计约 2 分钟；仍排队记未启动及卡点。不要用不相关的最新 run 替代对应 run。
5. run failed 按 recovery 归因后当轮补救一次，再验证；再次失败记录阻塞与恢复条件。已 running/completed 仅证实启动/结束，读到预期动作证据才能写执行。completed 却又在提问时重新判分支，不写任务完成。

| 报告用语 | 必需证据 |
| --- | --- |
| 已发送/排队 | 返回 messageId/runId，尚未验证启动 |
| 已启动，执行待验证 | 对应 run running，或已结束但未证实预期动作 |
| 已执行 | 消息后的活动、PR/issue 实况证实预期动作；附可核对对象 |
| 已完成 | 该动作的完成标准满足；任务完成另核原任务验收 |

代挂监听、改名、settle 同样回读对应状态。批量换档脚本输出只作启动线索，仍按本节核对应 run 与行为。

**完成标准**：每条写操作有返回结果与回读证据；未执行、失败和未启动项分别记卡点。全轮结束条件是判定与验证有账可查，不要求所有被推进任务当轮完成。

## 5. 派活

第 4 步的动作回读完再派。下文 `<t3-dispatch 技能目录>` 与本技能目录同级。

1. 先判能不能派。以下任一成立就本轮不派，在「本轮派活」写明原因：
   - `node <t3-dispatch 技能目录>/scripts/dispatch-config.mjs` 跑不了（技能没装），或 `errors` 非空；
   - `config.mode` 是 `off`，或 `config.repos` 为空；
   - `~/.config/bstack/PAUSE` 存在；
   - 本轮模型阶梯已降到 `fallback` 档：额度紧张时只做恢复。
2. 交接优先：本轮记成「等待空位」的交接（[交接与 settle](references/handoff.md) 第 3 步）先占空位，它们在等的设备本轮不派新问题。
3. 按 t3-dispatch 技能执行，属于巡检调用：`dry-run` 走到它的第 2 步只出计划，`auto` 全程执行。它第 1 步的 `--capacity-only` 快照就是本轮动作之后的空位，整轮只跑这一次。派活线程的模型取 t3-dispatch 配置的 `model`，不取模型阶梯。
4. 本轮新派出的线程不再回到第 1–4 步判定，下一轮按候选正常巡检。

**完成标准**：派或不派都有依据；`auto` 下每条派活都有认领结果、线程 link 和回读结论，失败的已归还；`dry-run` 的计划已列出。

## 6. 汇报

按环境分组。有事候选每个一行：原样 link、仓库、具体任务、`triageReasons`、判定证据和动作验证状态；不打扰写明在途检查或活动时间及 HEAD。静默候选每个环境合成一行：「静默 N 个：<标题>…」。已交付用户线程照常列入所在分组。

开头写模型档位与依据，以及分诊结果（全量与否、有事/静默数，取 `checks`）。环境集合变化时附环境对照表。固定「例行复核」引用 checks：失败处理、监听、命名、久审清单各总数及成功/跳过/失败数；issue 编码回读与修复数。队列恢复附取消/保留/失败/剩余数，未知不写 0。

交接、等待空位、settle、久审审计单列，写来源与去向或依据；「本轮派活」按 t3-dispatch 第 4 步写，`dry-run` 标明「未执行」；已定案记结论、授权/规则来源与执行状态；规则缺口记「建议改技能」，不靠跨轮承诺补规则。

「需要你决定」只列必须由用户提供的授权、产品取舍、互斥的用户要求或无法从环境核实的交接身份。每条写清所缺的用户输入、选项、默认保持状态与依据；技术方案、修在哪个 PR、复审次数及尚在运行的顾问任务不列入。取证/工具失败、额度不足或重复推进无效另列「阻塞」：证据、已做补救、下一责任方与可观察的恢复条件；仅当恢复确实需要用户操作时才转入「需要你决定」。实际未测、仅豁免、审查者缺席、仅启动等状态照实保留。

## 7. 记账

全部动作与派活完成后、汇报前记下本轮（只记一次），下一轮的分诊与档位判定从这里接续：

```bash
node <技能目录>/scripts/patrol-state.mjs commit --snapshot /tmp/t3-patrol-snapshot.json --tier <本轮档位 name> [--quota-failure]
```

本轮出现过额度失败（无论是否已换档恢复）就带 `--quota-failure`。

**完成标准**：命令输出了本轮的 `snapshotAt` 与档位。
