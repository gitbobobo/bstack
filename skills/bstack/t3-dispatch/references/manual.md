# 手工派活

当前 harness 拿不到 T3 MCP 会话（快照脚本退出码 2，如 Codex）时读这篇：`dispatch-plan.mjs` 与 `dispatch-launch.mjs` 都要这个会话，改用 MCP 工具按同样的口径手工做。

1. **空位**：`t3_environment_links`、`t3_project_list`、`t3_thread_list`（`allProjects:true`、`settled:false`、`includeSubagents:false`）取各环境的占用线程与项目，按 [t3-patrol handoff.md 第 3 步](../../t3-patrol/references/handoff.md) 的口径算每台目标设备的可建数，用 `limits.perRun` 与 `ledger` 的 `launched` 封顶。都是 0 就停。
2. **候选**：每个有空位的仓库跑 `issue-source.mjs list --repo <repo>`，按 SKILL.md 第 2 步及[派活标签](labels.md)的规则挑；用户优先项先于普通候选，暂缓及冲突按来源返回的 skipped 报告。
3. **查重**：对每条选中的问题，在每个可达环境用 `t3_thread_search` 搜问题编号，`projectId` 带该环境里该仓库的项目（不带时只搜当前线程所在项目，会漏）；只认标题或任务书命中，已有未 settle 的线程在做就换下一条。
4. **派出**，逐条做完再做下一条：
   1. `issue-source.mjs claim --repo <repo> --id <问题 ID>`，输出的 `at` 是认领时间；失败就跳过。
   2. 推荐理由写进 UTF-8 文件，`issue-source.mjs render --repo <repo> --id <问题 ID> --reason-file <文件>`，`message` 原样用。
   3. `t3_thread_launch`：目标 `environmentId` 与该环境的仓库 `projectId`；`title` 按 naming.md；`modelSelection` 按 SKILL.md「派活模型」取本轮模型（默认取配置），`runtimeMode` 取配置；`workspaceStrategy` 为 `{type:"worktree", baseRef:<repos[].baseRef>, startFromOrigin:true}`；`clientRequestId` 为 `t3-dispatch-<问题 ID>-<at>`。
   4. `issue-source.mjs record --repo <repo> --id <问题 ID> --env <environmentId> --thread <threadId>`。
   5. `t3_thread_read`（`limit` 1）确认 run 进入 starting 或 running、`worktreePath` 有值；工作树仍在准备时保留认领，交下一轮核对；建线程或 run 失败时 `release` 归还，额度换档及原线程恢复按 SKILL.md 第 3 步处理。
