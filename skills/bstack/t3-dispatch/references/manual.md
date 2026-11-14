# 手工派活

当前 harness 未向 shell 注入 T3 MCP 会话（快照脚本退出码 2，如 Codex）时读这篇：用 MCP 工具补齐快照与派出，候选计划和候选池仍用脚本，分工与准入规则沿用主流程。

1. **空位**：`t3_environment_links`、`t3_project_list`、`t3_thread_list`（`allProjects:true`、`settled:false`、`includeSubagents:false`）取各环境的占用线程与项目，按 [t3-patrol handoff.md 第 3 步](../../t3-patrol/references/handoff.md) 核实际 run/子代理、PR 窗口与排除规则。保存为 `--capacity-only` 同结构 JSON：`generatedAt`、`environments[].environmentId/projects/openThreads/capacity`，容量带 `freeByRepo` 与 `poolByRepo`；无法确认的环境记 `error`，不估空位。
2. **先分工再挑题**：用该 JSON 跑 `dispatch-plan.mjs --capacity <文件>`，脚本按预算列元数据及 `selection`，无 shell MCP 会话只意味着需在下一步手工补查重。先按[项目分工](candidates.md#2-按项目并行补筛)落记录、启动所需子代理，再由负责人依 SKILL.md 第 2 步与[派活标签](labels.md)补读取证；不能因走手工入口改回主代理串行全文筛选。
3. **查重**：对每条选中的问题，在每个可达环境用 `t3_thread_search` 搜问题编号，`projectId` 带该环境里该仓库的项目（不带时只搜当前线程所在项目，会漏）；只认标题或任务书命中，已有未 settle 的线程在做就换下一条。
4. **派出**，先按 [绑定身份](../SKILL.md#3-派出) 核目标仓库项目，再逐条做完：
   1. `issue-source.mjs claim --repo <repo> --id <问题 ID>`，输出的 `at` 是认领时间；失败就跳过。
   2. 推荐理由写进 UTF-8 文件，`issue-source.mjs render --repo <repo> --id <问题 ID> --reason-file <文件>`，`message` 原样用。
   3. `t3_thread_launch`：目标 `environmentId` 与该环境的仓库 `projectId`；`title` 按 naming.md；`modelSelection` 按 SKILL.md「派活模型」取本轮模型（默认取配置），`runtimeMode` 取配置；`workspaceStrategy` 为 `{type:"worktree", baseRef:<repos[].baseRef>, startFromOrigin:true}`；`clientRequestId` 为 `t3-dispatch-<问题 ID>-<at>`。
   4. `issue-source.mjs record --repo <repo> --id <问题 ID> --env <environmentId> --thread <threadId>`。
   5. `t3_thread_read`（`limit` 1）确认 run 进入 starting 或 running、`worktreePath` 有值；工作树仍在准备时保留认领，交下一轮核对；建线程或 run 失败时 `release` 归还，额度换档及原线程恢复按 SKILL.md 第 3 步处理。
