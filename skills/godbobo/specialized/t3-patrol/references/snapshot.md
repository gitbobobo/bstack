# 快照与补读取证

快照失败、字段不清或记录残缺时读取。

线程列表和线程内容的原始返回很大，直接调 MCP 工具读会塞满上下文。先跑快照脚本，它经 T3 MCP 的 HTTP 端点一次性收集所有环境，只输出判定要用的字段：

```bash
node <技能目录>/scripts/patrol-snapshot.mjs --self <thread.threadId> > /tmp/t3-patrol-snapshot.json
```

- 输出结构的读法：
  - **模型阶梯**：顶层 `modelLadder`，取自生效配置；所有换模/探测只准从这里取实例与参数。
  - **偏好**：顶层 `config` 带名额、阈值、久审审计线及 `source`/`warnings`/`errors`，用法见 SKILL.md「偏好配置」。
  - **设备对照**：顶层 `environmentsFile` 对比 `environments.json` 与本轮环境集合（`unlisted` 是文件里没有的环境，`missing` 是文件里有但本轮没连上的别名）；各环境条目带 `alias`、`device`。用法见 SKILL.md 第 0 步。
  - **候选**：`environments[].candidates`（已剔除子代理线程、首条消息是派活模板且没有工作树的执行线程、Fast Ship 审查线程（「代码审查 · PR #N」「视觉审查 · PR #N」）、「额度探测」「资源探测」线程和本线程；剔除数量在 `delegatedExcluded`）。每条带 `link`、`status`、`prs`、`lastMsgAt`、最近 3 次 run、`pendingRequestCount`、`task`（首条用户消息）、`tail`（最后 4 条消息，保留首尾共 600 字——代理常在长汇报末尾才提问）。
  - **失败清单**：`environments[].failedThreads` 合并候选内失败线程与 `failedTopLevel`，每条带 `id`/`link`/`title`/`status`/`model`/`source`；候选内的还带 `task`/`tail`/`runs`/`prs`。这是每轮第一份行动清单，逐条处理，不许只扫自己刚推过的线程。
  - **体检清单（环境级）**：三项体检各一份，每条带线程 `id`，逐条处理即可。
    - `needsWatchThreads`：有 open PR 没挂监听（`prs`、`urls`）。
    - `needsRenameThreads`：标题是原文堆砌、超宽或缺 open PR 号（`reasons`），同时带 `prs`/`task`/`tail` 作为命名依据。
    - `convergenceAuditThreads`：久审未收敛，即 PR 开着超过 `convergenceAudit.openHours`（12 小时）或审查超过 `convergenceAudit.reviewRounds`（5 轮），且当日仍有 P0–P2（`prs` 带时长/轮次/当日 P0–P2 条数，直接当审计题头）。
  - **体检计数**：`checks` 汇总 `candidates` 与各清单条数。汇报「例行复核」只能引用这里的数字；没读到 `checks` 或清单内容，不许写 0，也不许凭候选摘要估数。
  - **监听状态**：`prs` 里 open PR 标 `(unwatched)`；已挂监听但 review/评论时间晚于 `lastMsgAt` 标 `(stale)`。
  - **审查健康度（逐候选、逐 PR）**：`environments[].candidates[].prHealth[]` 带 `openHours`、`rounds`、`latestAt`、`inline24h`/`inlineP0P2`、`failChecks`/`pendingChecks`、`mergeable`、`checksVia`（取数通道）。这些聚合字段是补查线索；是否在途及是否已处理须核最新 HEAD、审查触发记录与线程活动。宿主与凭据由脚本自己解析，不用手配。
  - **核不到实况**：`prs` 标 `(health-unavailable)` 表示该 PR 的 gh 与 Forgejo 两条通道都失败。这时不要判「不打扰」：在脚本内部用 `git credential fill` 获取宿主凭据，仅输出认证成功与否，再按 Forgejo API（`GET /api/v1/repos/{owner}/{repo}/pulls/{n}`、`/reviews`、`/issues/{n}/comments`、`/commits/{sha}/statuses`）手工核一次；仍核不到就写进「阻塞」，带 PR URL、报错与恢复条件；需要用户提供权限或环境信息时再提问。
  - **空转迹象**（仅活跃状态 preparing/queued/starting/running/waiting）：`distinctRecentCommands`（最近 30 个工具调用里不同命令数）、`sampleCommand`、`minutesSinceLastMessage`。
  - **容量**：`environments[].capacity`（设备总数、仓库池、磁盘 `disk`（远程环境的 `freeGB` 为 null）、按仓库的可建数 `freeByRepo`）、`activeTopLevel` 与 `occupying`，用法见 [handoff.md](handoff.md) 第 3 步。
  - **失败对账**：`failedTopLevel` 列出被候选过滤排除、但状态是 failed/interrupted/cancelled 的顶层线程；行动时看合并后的 `failedThreads`——过滤规则一改就可能误杀真线程，静默消失比多算几条候选危险得多。
- 按环境分段用 `jq` 或 `read` 取这个文件。某个线程的 `tail` 不够判断时，再单独用 `t3_thread_read` 补读那一个线程（`view:"activity"`，`afterPosition` 取 `max(0, itemCount - 60)`，按 nextPosition 翻到末尾；只需消息时省略 view，`limit` 10，`maxCharsPerItem` 1500）。
- 以往运行巡检的线程也会出现在候选里（标题含 t3-patrol 或巡检），判定时跳过。
- 脚本退出码 2 表示当前 harness 没有向 shell 注入 T3 MCP 会话（`T3_ACP_MCP_ENDPOINT`/`T3_ACP_MCP_AUTHORIZATION` 只注入给 ACP 类 harness，如 droid、devin；Codex 的会话只写进它自己的 MCP 配置）：改用 `t3_thread_list`（`allProjects:true`、`settled:false`，按 `nextCursor` 翻完）和上面的 `t3_thread_read` 参数手工取证，取到的每条只记判定要用的字段。

**快照核对**：每个可达环境的 `candidates` 数组都已取出并数过个数（判定表要覆盖数组里每一个线程；拿到空数组前先确认字段名没读错），`checks` 计数也已读到；带 `error` 的环境或线程已用 MCP 工具补读或记进报告。

## 持续降级

同一巡检线程已确认缺连接变量、且入口配置没有变化时，后续轮次直接用 MCP 手工取证；报告沿用已核实的入口阻塞，待配置变化再重试脚本。手工模式也按环境分页到底，分别记录候选、过滤外失败、监听、命名、久审清单的对象与补读结果；缺少的清单或汇总仍记未知，并列明缺口。连续多轮缺同一入口时，在「建议」里提一次：把巡检线程换到 ACP 类 harness 即可启用快照脚本；harness 由用户决定，巡检不自行切换，也不读取或输出凭据值。
