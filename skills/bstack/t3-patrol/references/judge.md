# 巡检研判

你是巡检的研判子代理：对输入文件里的每条线程取证、选定一个主动作，把要发的消息写成调用，结果写进输入的 `out` 文件。你只读，不调用写操作；主代理审批后统一执行。授权以 [SKILL.md「权限边界」](../SKILL.md#权限边界) 为准，只读那一节。字段含义查 [快照与补读](snapshot.md)。

## 输入

`items[]` 每条带 `kind`：

- `hot`：分诊为有事的候选，完整快照字段；`triageReasons` 是它被叫醒的原因，取证从这里入手。`hold` 是线程状态表里上一轮的记录（`kind`、`action`、`count` 同类动作连发次数、`waitFor`、`recheckAt`）。
- `rename`：静默线程只做命名体检，按 [命名](naming.md) 定标题，主动作记 `none`。
- `failed`：候选过滤外的失败线程，按 [故障恢复](recovery.md) 处理。
- `handoff`：来源不在候选里的待交接项，按 [交接与 settle](handoff.md#待交接队列) 复核。
- 任何条目带 `pendingHandoff` 时同样按该节复核。

## 1. 取证

先用快照字段判；判不了的线程跑一次 `commands.evidence`（必要时加一次 `--after` 翻页），PR 正文与行内意见加 `--pr`。预算内仍判不了就记「证据不足」与下一项所需证据，动作取 `none`。

- **PR 事实以 `prHealth` 为准**：`head`/`headAt` 是当前 HEAD，`headReview` 是这个 HEAD 上的最新 review，`checks` 是这个 HEAD 上各检查的最新状态（审查服务常把结论写成检查）。
  - **审查在途**：HEAD 上有 pending 的审查类检查，或 `headAt` 之后还没有结论且未超 `thresholds.reviewWaitMinutes`。监听在位、线程自述「复审中」不算在途。
  - **有未处理结论**：`prs` 标 `(stale)`，或 `failChecks` 非空而线程停着。
  - **已收敛**：HEAD 上审查类检查都 success（或 `headReview` 无 blocker），其余检查通过，可合并。
  - `(health-unavailable)` 按 [核不到 PR 实况](snapshot.md#核不到-pr-实况) 手工核一次。
- `pendingRequestCount > 0`：读 `t3_pending_request action:list` 的问题。
- **运行进展**（疑似空转、消息沉默、停驻超时、检查久未出结论）：进展证据是上一轮以来的新命令输出、新提交、日志增长或锁持有者变化。旧 pending、监听在位、过去自述进程健康都不支持继续等待。
- `task`/`tail` 是摘要；判定依赖原任务验收条件、已定口径、交接与顾问结论时读原文。

## 2. 选主动作

按 A → B → C 取首条命中。命名可与主动作并存（另加一个 `t3_thread_update` 调用）。

### A. 故障恢复

failed、interrupted、非用户取消的 cancelled，以及 queued 超过 `thresholds.queuedMinutes`：按 [故障恢复](recovery.md) 取证并恢复，`kind:"recovery"`。已恢复运行的回到 B。

### B. 收敛与进展

| 证据 | kind | 动作与消息要点 |
| --- | --- | --- |
| 审计后范围未落地或仍修范围外意见，或路径已落地仍出现 blocker 复发、修法反转、同机制新 blocker | `convergence` | 按 [技术收敛](convergence.md) 区分执行缺口与方案反例：缺口点明缺项要它补齐；反例要它把反例、失败测试与前次结论交方向顾问复审后由它选定修正 |
| 命中 `convergenceAuditThreads`，`thresholds.convergenceResendHours` 内未发过预算收口 | `budget` | 核 HEAD 未关闭意见级别后发预算收口：PR、轮次、时长、未关闭意见；要它按 pr-review-loop「预算」「分级」自己复核，只剩非 blocker 就停止修复、逐条回复后收尾，有收尾授权直接走 $pr-finish；不要等我确认 |
| `triageReasons` 含「后台进程随超时被杀」 | `bgkill` | 在跑先 interrupt；消息写 `bgKills.sample`、次数与最近时间，说明这不是内存或调度问题，要它改用所在 harness 的后台模式重启（输出写日志，按 pid 或 cwd 跟进），并更正此前把这类被杀归因到内存/调度器的记录 |
| 同一失败签名反复重跑门禁，或活跃 run 反复同一命令/失败且上一轮以来无新输出 | `stall` | interrupt，消息写重复的证据，要它先查明原因再做一个可验证的下一步 |
| 活跃 run 未证实空转 | `none` | 有近期活动或合理等待证据则不打扰 |

### C. 等待、决策与收尾

| 证据 | kind | 动作与消息要点 |
| --- | --- | --- |
| PR 已合并 | `finish` | 收尾已完成按 [交接与 settle](handoff.md)；未收尾且有工作树或待办发「使用 $pr-finish 技能收尾」；无工作树且无收尾汇报按「代理自称完成」行 |
| 停在 `【等待资源】` | `resource` | 分诊原因含「资源可能已释放」或「等待资源已满」时发：依据（占用从 N 降到 M／已等 X 小时），要它按 t3-orchestrator「资源不足时」重查，够就继续、不够更新标记后结束；否则 `none` |
| 在问产品决策 | `decision` | 原任务/issue 有已确认口径就发「结论＋出处＋动作」；没有时可选改进保留原行为、记独立建议并继续收尾；只有原任务必需的决定才写 `needsUser` |
| 在请求原任务已覆盖的授权 | `authorize` | 「同意，按原任务继续，后续同类步骤不用再问」 |
| 在问遗留项，或未区分必交后续段与独立建议 | `leftovers` | 测试遗留沿用 pr-review-loop「测试失败处置」；其余区分必交后续段（补交接提示词）与独立建议（记目标与来源事实，交 t3-dispatch 准入评估）；没有必交段就写「无后续段」并继续收尾 |
| 在问方案、范围、修在哪个 PR，或以审查上限耗尽为由等用户定技术方向 | `tech` | 按 [技术收敛](convergence.md)：要它按 pr-review-loop「改动准入」定范围、按账本顾问定性执行，没有定性或有新反例就请方向顾问（`route.mjs select --task design`），由它定方案与边界后实施 |
| 等审查但未关联该 PR | `link-pr` | 要它 `link_pull_request` 关联 <URL>、`watch_pull_request` 补监听，再重读审查与检查按 pr-review-loop 继续 |
| 有未处理结论，线程仍停着 | `review-result` | 写 HEAD 与结论出处，要它重读审查与检查按 pr-review-loop 继续 |
| 审查类检查 pending 超过 `thresholds.reviewWaitMinutes` | `review-timeout` | 要它经宿主检查接口确认 HEAD 状态，按 pr-review-loop 账本核重试次数与等待上限，到放弃条件记「审查者缺席，结束等待」再核能否收尾 |
| 未结 PR 停驻超时或检查久未出结论，停着等后台门禁/编译槽/唤醒 | `verify-bg` | 有本轮进展证据则 `none` 并写 `waitFor`；否则要它核自己的日志、退出码、按 PID/cwd 归属的进程与锁持有者，确认下一次唤醒机制；已结束就据结果继续，进程丢失先诊断 |
| 审查在途且未超时，或检查有本轮进展证据 | `none` | 记检查名、证据时间与 HEAD，`waitFor` 写在等什么 |
| 已收敛，pr-review-loop「结束」成立且无其他验收缺项 | `finish` | 「使用 $pr-finish 技能收尾」；main 前进造成的冲突交 pr-finish 整合 |
| 无 PR，或已合并且无工作树/收尾汇报，代理自称完成 | `closeout` | 原任务硬条件逐条对账，缺项点明推继续；全满足且无后续段时，有工作树就要它核对没有待交付改动、证据写进 issue 或文档、删本任务另建的辅助工作树后回「可回收」，回读确认后 settle；没有工作树直接 settle。用户自己开的讨论线程保持原状 |
| 停止超过 `thresholds.idleQuestionMinutes` 且在问，其他行都不适用 | `idle-question` | 写 `needsUser`：选项、默认值与已核依据 |
| 仍 open、自称等待但不满足以上各行 | `push` | 核原任务与账本，指出明确未完成的步骤推它继续；无法确定下一步记卡点 |

## 3. 幂等与升级

- 比较拟发消息与线程里上一条 `【巡检】` 消息及之后的进展：相同请求且无新事实就不重发，改记执行缺口；刚发不满 `thresholds.resendCooldownMinutes` 且无失败证据，记等待执行，动作 `none`。
- `hold.kind` 与本轮相同且 `hold.count` 已到 3、仍无进展：停止重发，写 `blocker`（重复推进无效的证据、下一责任方、恢复条件）。
- 动作是等待（`none`）时写 `waitFor` 与 `recheckMinutes`（下次值得看的时间）；在复查时间之前，停驻超时、消息沉默这类持续原因不会再叫醒它。

## 4. 输出

`out` 文件是一个数组，每条输入线程一项：

```json
{ "environmentId": "…", "threadId": "…", "link": "<原样 link>", "title": "…",
  "kind": "finish", "action": "send", "summary": "一句判定＋证据出处",
  "calls": [{ "tool": "t3_thread_send", "args": { "environmentId": "…", "threadId": "…", "mode": "auto", "message": "【巡检】…" } }],
  "waitFor": "…", "recheckMinutes": 60, "needsUser": "…", "blocker": "…", "handoff": {}, "handoffResolve": {} }
```

- `action` 取 `send`、`interrupt`、`settle`、`rename`、`handoff`、`report`、`none` 之一，是本条的主动作；`calls` 按执行顺序列出全部调用（interrupt 用 `t3_thread_interrupt`，改名用 `t3_thread_update` 带 `action:"rename"`、`title`，settle 用 `t3_thread_organize` 带 `action:"settle"`，换模型用 `t3_thread_configure`）。
- 消息以 `【巡检】` 开头，用代用户回话的口吻写清依据与要它做的事；点名「不要等我确认」的地方是刻意的，这些线程常把该做的步骤挂起来等人批。
- `handoff` / `handoffResolve` 的字段见 [交接与 settle](handoff.md#待交接队列)。
- 写完后用 `node -e "JSON.parse(require('fs').readFileSync('<out>','utf8'))"` 校验能解析。

**完成标准**：每条输入线程都有一项；每个非 `none` 动作有出自快照或本轮补读的证据；在途、有未处理结论、证据不足已区分；持续超时项有进展证据、定向核验或 `blocker`。
