# 快照与补读

快照字段不清、失败、记录残缺，或要重新认设备时读取。

线程列表和线程内容的原始返回很大，直接调 MCP 工具读会塞满上下文。快照脚本经 T3 MCP 的 HTTP 端点一次性收集所有环境，只输出判定要用的字段；补读脚本 `patrol-evidence.mjs` 用同一通道按需取原文。两者共用 `t3-mcp.mjs`（MCP 客户端）与 `pr-live.mjs`（PR 实况：GitHub 走 gh，其他宿主走 Forgejo/Gitea REST，宿主与凭据由脚本自己解析）。

## 输出结构

- **顶层**
  - `generatedAt`：快照开始时间，也是下一轮分诊的「上一轮」时间点。
  - `lastRound`：状态文件里的上一轮记录（`at`、`tier`、`quotaFailure`），没有为 null。
  - `triage`：本轮是否全量（`full`）及原因，或增量分诊的起点 `since`。
  - `modelLadder`：生效配置的模型阶梯；所有换模、探测只从这里取实例与参数。
  - `config`：名额、阈值、分诊、久审审计线及 `source`/`warnings`/`errors`。
  - `environmentsFile`：`environments.json` 与本轮环境集合的对比（`unlisted` 是文件里没有的环境，`missing` 是文件里有但本轮没连上的别名）。
- **候选** `environments[].candidates`：已剔除子代理线程、首条消息是派活模板且没有工作树的执行线程、Fast Ship 审查线程（「代码审查 · PR #N」「视觉审查 · PR #N」）、「额度探测」「资源探测」（旧版遗留）线程和本线程；剔除数量在 `delegatedExcluded`。
  - 每条带 `triage`（`hot`/`quiet`）与 `triageReasons`。
  - 有事候选带全部字段：`link`、`status`、`hasWorktree`、`prs`、`lastMsgAt`、`lastRunEndedAt`、最近 3 次 `runs`、`pendingRequestCount`、`task`（首条用户消息）、`tail`（最后 4 条消息，保留首尾共 600 字——代理常在长汇报末尾才提问）、`prHealth`；在跑的还有空转迹象 `distinctRecentCommands`（最近 30 个工具调用里不同命令数）、`sampleCommand`、`minutesSinceLastMessage`。
  - `waitingResources`：线程停着且最后一条消息以 `【等待资源】` 开头（t3-orchestrator「资源不足时」的约定），带标记时间与首行。
  - 静默候选只留识别与分诊字段。
- **PR 实况** `candidates[].prHealth[]`（逐 open PR）：
  - `head`/`headAt`：当前 HEAD 与其提交时间。
  - `headReview`/`reviewsOnHead`：这个 HEAD 上的最新 review（PENDING 与请求审查不算）。
  - `checks[]`：这个 HEAD 上每个检查的最新状态 `success`/`failure`/`pending`、时间与说明；`failChecks`、`pendingChecks` 由它汇总。
  - `latestAt`：review、评论与检查出结论的最新时间；晚于线程 `lastMsgAt` 时 `prs` 标 `(stale)`。
  - `lastCommentAt`/`lastCommentBy`、`mergeable`、`openHours`、`rounds`、`inline24h`/`inlineP0P2`（24 小时内行内意见及其中 P0–P2 条数）。
- **失败清单** `failedThreads`：合并候选内失败线程与 `failedTopLevel`（被候选过滤排除、但状态是 failed/interrupted/cancelled 的顶层线程），`source` 标来源。过滤规则一改就可能误杀真线程，静默消失比多算几条候选危险得多，所以逐条处理。
- **体检清单**（环境级，不论分诊）：
  - `needsWatchThreads`：有 open PR 没挂监听（`prs`、`urls`）。
  - `needsRenameThreads`：标题是原文堆砌、超宽或缺 open PR 号（`reasons`），带 `prs`/`task`/`tail` 作为命名依据。
  - `convergenceAuditThreads`：PR 开着超过 `convergenceAudit.openHours` 或审查超过 `convergenceAudit.reviewRounds` 轮，且 24 小时内仍有 P0–P2（`prs` 带时长/轮次/条数，直接当审计题头）。
- **计数** `checks`：候选、有事、静默与各清单条数。汇报「例行复核」只引用这里的数字。
- **容量** `environments[].capacity`：设备总数、仓库池、按仓库的可建数 `freeByRepo`、`blocked`（本机磁盘低于保底，或设备上有线程在等资源；非空时可建数全为 0），以及 `activeTopLevel` 与 `occupying`，用法见 [handoff.md](handoff.md) 第 3 步。`disk.freeGB` 只有本机有值，远程磁盘由在那里干活的线程自己查。

## 分诊规则

有事的原因（`triageReasons`）：全量、取证失败、失败、待答请求、排队超时、久审；在跑线程的疑似空转、消息沉默；停住线程的上轮后有新活动、PR 有新事件、审查类检查久未出结论、HEAD 无审查与检查、结论未消费、PR 实况缺失、提问久未答；等资源线程的设备空出名额（本轮占用比状态文件里上一轮的少）、等待满 `triage.resourceWakeHours`。久审只在有别的变化或全量时一并标出。阈值类原因只在超时发生在两轮之间时触发一次，之后靠线程的新活动（包括对巡检消息的响应）再次叫醒。`triage.fullEveryHours` 一次的全量兜住长期静默却卡住的线程。规则实现见 `scripts/patrol-triage.mjs`。

## 补读

`patrol-evidence.mjs` 一条命令取多条线程与 PR，字段见脚本头注释。线程读的是 activity 视图（略去 reasoning），尾部条数用 `--items`，读某条消息之后的活动用 `--after <position>`。

## 核不到 PR 实况

`prs` 标 `(health-unavailable)` 表示 gh 与 Forgejo 两条通道都失败。这时不判「不打扰」：在脚本内部用 `git credential fill` 获取宿主凭据，仅输出认证成功与否，再按 Forgejo API（`GET /api/v1/repos/{owner}/{repo}/pulls/{n}`、`/reviews`、`/issues/{n}/comments`、`/commits/{sha}/statuses`）手工核一次；仍核不到就写进「阻塞」，带 PR URL、报错与恢复条件。

## 脚本跑不了

退出码 2 表示当前 harness 没有向 shell 注入 T3 MCP 会话（ACP 类 harness 如 droid、devin，以及 pi 都有；Codex 的会话只写进它自己的 MCP 配置）：改用 `t3_thread_list`（`allProjects:true`、`settled:false`，按 `nextCursor` 翻完）和 `t3_thread_read`（`view:"activity"`，`afterPosition` 取 `max(0, itemCount - 60)`）手工取证，每条只记判定要用的字段。手工模式没有分诊，全部候选按有事处理；也按环境分页到底，分别记录候选、过滤外失败、监听、命名、久审清单的对象与补读结果，缺少的清单或汇总记未知。

同一巡检线程已确认缺连接变量、且入口配置没有变化时，后续轮次直接手工取证，报告沿用已核实的入口阻塞。连续多轮缺同一入口时，在「建议」里提一次：把巡检线程换到 ACP 类 harness 或 pi 即可启用快照脚本；harness 由用户决定，巡检不自行切换。

## 设备对照

`environmentsFile` 的 `unlisted`、`missing`、`errors` 有任何非空时，按下面重新认设备：

1. **本机**：跑 `hostname`；macOS 再跑 `sysctl -n hw.model`，得到主机名和机型。
2. **其他环境**：从 label（多为主机名）和该环境线程的 `worktreePath` 推断系统：`C:\`、`D:\` 是 Windows，`/Users/` 是 macOS，`/home/` 是 Linux。再读一个该环境近期的顶层线程，找代理自报的设备信息（如「设备是 Mac mini」）。
3. **整理成表**，写进本轮回复：

   ```
   环境对照表
   | 环境 | environmentId | 设备 | 依据 |
   ```

有任何一行拿不准（推断不出机型，或两个环境像同一类设备），就向用户提问确认。答复到达前，交接目标落在拿不准的环境上的线程先不交接，其余巡检照常。
