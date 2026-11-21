# 快照与补读

快照字段不清、取证失败、PR 实况缺失，或要重新认设备时读取。

快照脚本 `patrol-snapshot.mjs` 经 T3 MCP 的 HTTP 端点一次收集所有环境，只输出判定字段；补读脚本 `patrol-evidence.mjs` 用同一通道按需取原文。两者共用 `t3-mcp.mjs` 与 `pr-live.mjs`（GitHub 走 gh，其他宿主走 Forgejo/Gitea REST，凭据由脚本自己解析）。

## 输出结构

- **顶层**：`generatedAt`（也是下一轮分诊的「上一轮」时点）、`lastRound`（`at`、`tier`、`quotaFailure`）、`pendingHandoffs`、`triage`（`full` 及原因，或增量起点 `since`）、`modelLadder`、`config`（含 `warnings`/`errors`）、`environmentsFile`（`unlisted` 是文件里没有的环境，`missing` 是文件里有但本轮没连上的别名）、`unreachable`。
- **巡检排除** `environments[].patrolExcluded`：没有派出归属的线程（`id`、`link`、`title`、`reason`），只参与容量与查重。
- **候选** `environments[].candidates`：已剔除巡检排除项、子代理线程、无工作树的派活模板线程、Fast Ship 审查线程（「代码审查 · PR #N」「视觉审查 · PR #N」）、探测线程和本线程，剔除数在 `delegatedExcluded`。
  - 每条带 `triage`（`hot`/`quiet`）、`triageReasons`，线程状态表有记录时带 `hold`。
  - 有事候选带全部字段：`link`、`status`、`hasWorktree`、`prs`、`lastMsgAt`、`lastRunEndedAt`、最近 3 次 `runs`、`pendingRequestCount`、`task`（首条用户消息）、`tail`（最后 4 条消息，保留首尾共 600 字）、`prHealth`；在跑的还有 `distinctRecentCommands`（最近 30 个工具调用里不同命令数）、`sampleCommand`、`minutesSinceLastMessage`。
  - `bgKills`：尾部 60 条活动里，带单独 `&` 的后台启动以超时结束的次数（`count`）、最近时间（`lastAt`）与命令（`sample`）。
  - `waitingResources`：线程停着且最后一条消息以 `【等待资源】` 开头，带标记时间与首行。
- **PR 实况** `candidates[].prHealth[]`（逐 open PR）：`head`/`headAt`；`headReview`/`reviewsOnHead`（PENDING 与请求审查不算）；`checks[]`（这个 HEAD 上每个检查的最新状态）及汇总 `failChecks`、`pendingChecks`；`latestAt` 晚于线程 `lastMsgAt` 时 `prs` 标 `(stale)`；`lastCommentAt`/`lastCommentBy`、`mergeable`、`openHours`、`rounds`、`inline24h`/`inlineP0P2`。
- **失败清单** `failedThreads`：候选内失败线程加 `failedTopLevel`（被过滤、但状态是 failed/interrupted/cancelled 的顶层线程），`source` 标来源；巡检排除项、探测与 Fast Ship 审查失败不进清单。
- **体检清单**：`needsWatchThreads`（有 open PR 没挂监听，start 已代挂）、`needsRenameThreads`（`reasons`：`raw` 原文堆砌、`wide` 超宽、`stale-id` 缺 open PR 号）、`convergenceAuditThreads`（PR 开着超过 `convergenceAudit.openHours` 或审查超过 `reviewRounds` 轮，且 24 小时内仍有 P0–P2）。
- **计数** `checks`：巡检排除、候选、有事、静默与各清单条数，汇报只引这里的数字。
- **容量** `environments[].capacity`：两池（`heavy`/`general`）的 `max`/`used`/`occupying`，`poolByRepo`、`freeByRepo`、`blocked`（本机磁盘低于保底，或有线程在等资源；非空时可建数全为 0）、`decisions[]`（逐线程是否占位及原因）、`unverifiedThreads`（状态读取失败、保守占位）。只有当前执行中的线程占位，计数规则在 `patrol-capacity.mjs`。`--capacity-only` 只输出容量、`projects` 与 `openThreads`。

## 分诊规则

有事的原因：全量、待交接未销账、取证失败、失败、待答请求、排队超时、久审、后台进程随超时被杀；在跑线程的疑似空转、消息沉默；停住线程的未结 PR 停驻超时（距最后消息与最后 run 结束两者较晚者满 `thresholds.silenceMinutes`）、上轮后有新活动、PR 有新事件、检查久未出结论、HEAD 无审查与检查、结论未消费、PR 实况缺失、提问久未答；等资源线程的设备空出名额、等待满 `triage.resourceWakeHours`。

停驻超时、消息沉默、久审、检查久未出结论、HEAD 无审查与检查是**持续原因**：每轮都会叫醒，直到 `hold.recheckAt` 之前被压住（只剩它们时转静默，原因写「等待中」）。全量轮不受压制，`triage.fullEveryHours` 兜住其余漏项。规则实现在 `patrol-triage.mjs`。

## 补读

`patrol-evidence.mjs` 一条命令取多条线程与 PR，字段见脚本头注释。线程读 activity 视图（略去 reasoning），尾部条数用 `--items`，某条消息之后的活动用 `--after <position>`，排队项全文用 `--queue`。`--from <JSON>` 接受完整快照、`patrol-evidence`、`issue-source ledger` 与 `dispatch-launch` 输出，`--select hot|failed` 取子集。条目取证失败保留其 `error` 并非零退出，按已成功结果继续判定并报告缺口。

## 核不到 PR 实况

`prs` 标 `(health-unavailable)` 表示 gh 与 Forgejo 两条通道都失败，这时不判「不打扰」：在脚本内部用 `git credential fill` 取宿主凭据（只输出认证成功与否），按 Forgejo API（`GET /api/v1/repos/{owner}/{repo}/pulls/{n}`、`/reviews`、`/issues/{n}/comments`、`/commits/{sha}/statuses`）手工核一次；仍核不到写 `blocker`，带 PR URL、报错与恢复条件。

## 设备对照

`environmentsFile` 的 `unlisted`、`missing`、`errors` 有任何非空时重新认设备：

1. **本机**：`hostname`；macOS 再跑 `sysctl -n hw.model`。
2. **其他环境**：从 label 和该环境线程的 `worktreePath` 推断系统（`C:\` 是 Windows，`/Users/` 是 macOS，`/home/` 是 Linux），再读一个该环境近期的顶层线程，找代理自报的设备信息。
3. 整理成「环境对照表 | 环境 | environmentId | 设备 | 依据 |」写进本轮回复，并在「例行复核」建议用户运行 bstack-setup 更新 `environments.json`。

有一行拿不准就列进「需要你决定」；答复到达前，目标落在拿不准环境上的交接先不建线，其余巡检照常。
