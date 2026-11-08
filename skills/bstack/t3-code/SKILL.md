---
name: t3-code
description: 本机 T3 Code 运行状态的内部知识：状态数据库布局、本机会话查询、delegate_task 编排与 ACP 通道要点。复盘本机会话、排查编排问题时使用；跨环境线程用 T3 MCP 工具读（见「子线程取证」）；监听 PR 审查或等子任务前先读「监听与唤醒」；收尾回收孤儿工作树跑 scripts/t3-worktree-gc.mjs。
---

# t3-code 本机知识

T3 Code 的本地状态在 `~/.t3/` 下。会话、命令、消息等运行数据落 SQLite，复盘/排查时直接查库，比翻日志高效。

## 状态数据库

- 当前库：`~/.t3/userdata/statev2.sqlite`；`state.sqlite` 是旧库。
- v2 投影表（`orchestration_v2_projection_*`）2025-10-03 起为权威数据；v1 的 `projection_*` 表已停写，只在看更早历史时查。
- 关键表：
  - `orchestration_v2_projection_threads`：线程。列含 `thread_id`、`project_id`、`title`、`default_provider`、`runtime_mode`、`created_at`、`updated_at`、`archived_at`。
  - `orchestration_v2_projection_turn_items`：线程内事件流，分析主力表。列含 `thread_id`、`run_id`、`ordinal`、`type`、`status`、`updated_at`、`payload_json`。
  - `orchestration_v2_projection_subagents` / `runs` / `run_attempts` / `provider_sessions`：委派与运行明细。
  - `scheduled_tasks`、`projection_thread_pull_requests`：定时任务、线程关联的 PR。
- `turn_items.type` 常见值：`assistant_message`、`command_execution`、`reasoning`、`dynamic_tool`（MCP 调用）、`user_message`、`file_change`、`file_search`、`subagent`、`error`。
- `payload_json` 按 type 不同：`command_execution` 含 `input`/`output`/`exitCode`/`startedAt`/`completedAt`；`assistant_message`/`reasoning` 含正文文本。
- 留存限制：约 87% 的 `command_execution` 只在 `output` 里存「Exited with code N」一行，`exitCode` 字段经常缺省，完整 stdout/stderr 不落库——判成败主要靠 output 文本里的退出码。
- 委派任务的子代理是独立线程（命名形如 `thread:delegated-task:*`），查子代理活动按 `thread_id` 过滤即可。
- Windows 上没有 sqlite3 CLI，用 Python 自带的 sqlite3 模块查库；查询稍长就写临时 .py 文件再跑，cmd 里内联 `python -c` 的引号容易翻车（exec 是 cmd，`&&` 连接而不是 `;`）。

## 常用查询

```bash
DB=~/.t3/userdata/statev2.sqlite

# 最近活跃线程
sqlite3 $DB "SELECT thread_id, title, updated_at FROM orchestration_v2_projection_threads
  WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20;"

# 某线程的命令执行（含退出码）
sqlite3 $DB "SELECT json_extract(payload_json,'$.input'), json_extract(payload_json,'$.exitCode')
  FROM orchestration_v2_projection_turn_items
  WHERE thread_id='<id>' AND type='command_execution' ORDER BY ordinal;"

# 失败的命令（全库）
sqlite3 $DB "SELECT thread_id, json_extract(payload_json,'$.input')
  FROM orchestration_v2_projection_turn_items
  WHERE type='command_execution' AND payload_json LIKE '%Exited with code%'
    AND payload_json NOT LIKE '%Exited with code 0%';"

# 事件类型分布
sqlite3 $DB "SELECT type, COUNT(*) FROM orchestration_v2_projection_turn_items GROUP BY 1 ORDER BY 2 DESC;"
```

## 编排工具面（机制事实）

派活的策略与操作流程（选模型、写任务模板、换路、验收）是 `$t3-orchestrator` 技能的职责；这里只记工具层面的机制事实。

- `orchestrator_capabilities` 返回活的 provider/模型目录（含自定义模型）；harness 自带的模型清单不是全集。
- `delegate_task` 参数面：`task`、`target:{providerInstanceId, model}`、`mode`、`clientRequestId`。返回 `taskId`（配 `task_status`/`task_cancel` 管理）和 `childThreadId`（子代理存储线程，可 `t3_thread_read`）。实际派活的规则——`target` 模型选型、`runtimeMode`/`interactionMode` 处理——在 `$t3-orchestrator` 的「派活」段，调用前先读它。
- 线程与工作区绑定只能在 `t3_thread_launch` 的 `workspaceStrategy` 里设（`worktree`/`existing_worktree`/`root`）；让 agent 自己跑 `git worktree add` 不改变绑定。
- ACP 通道兜底：T3 MCP 工具缺席且环境有 `T3_ACP_MCP_NODE` 时，走终端
  `ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" ${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call <tool> '<json>'`。
- `schedule_task` 的 `schedule` 传结构化对象（`{"type":"interval","everyMs":N}` / `{"type":"fixed_time","timeOfDay":"HH:MM","weekdays":[...]}`），不是 JSON 字符串。

## 监听与唤醒

T3 在事件到达时唤醒本线程。等外部结果时登记监听，然后结束本轮——结束本轮是把控制权交还 T3，事件会把你带回原流程，任务并未结束。

- PR 审查、CI、冲突：`watch_pull_request`（用法见 T3 注入的 PR 说明）；子任务：`delegate_task` async 的完成事件。
- 部分 harness（如 pi）延迟加载 MCP 工具：`watch_pull_request` 不在工具列表时先用 `tool_search` 搜一次，搜不到再走上节的 ACP 兜底。
- `watch_pull_request` 不会在「自己 GitHub 账号发表的评论」上唤醒线程（已实测确认：watch 注册成功、结论到达后依然无唤醒）。云端审查者现在各用自己的身份发言，它们的结论会正常唤醒；只有「借用户 token 发言」的账号才会漏唤醒，那类场景挂 `schedule_task`（`{"type":"interval","everyMs":1800000}`，回到当前线程）兜底：到点按 `$pr-review-loop`「审查意见按身份归属」重读全部评论，本轮审查者到齐或按无响应规则放弃等待后删除它。

## 子线程取证（t3_thread_read）

- 默认视图只回消息项；工具调用与文件写入要用 `view:"activity"`。找子代理回报或某次写入，从尾部 position 往回翻，不要从 0 分页。
- 跨环境复盘先跑 `node <技能目录>/scripts/t3-activity-scan.mjs --hours 24 --self <本线程 id> > scan.json`：经 T3 MCP 端点收集本机与所有已连接环境窗口期内活跃的线程，每个带读过的 `skillReads`、`$技能名` 提及和用户消息。活跃按最近一次 run 或创建时间判断：`t3_thread_list` 的 `updatedAt` 会被同步批量刷新，用它筛会把几百个老线程算进来。再对关心的线程用 `t3_thread_read` 补读细节。
- `file_change` 项的 `originalFile` 带编辑前全量快照：未跟踪文件被改毁时，取该文件最后一个 file_change 的 `originalFile` 重建——这是此类事故的最后恢复途径。

## 工作树回收（t3-worktree-gc）

T3 线程绑定的工作树（`~/.t3/worktrees/<项目分组>/<名>`）在线程结束后不会自动清理。同一绑定工作树可能经 junction/符号链接以多个路径等价可达（数据目录迁移后常见）：看到工作树路径「变了」先确认是不是同一目录（Windows `dir /al`/`fsutil reparsepoint query`，POSIX `readlink`/`stat`），不要当成目录迁移。收尾时用 `scripts/t3-worktree-gc.mjs` 只回收「其他已终结线程」的工作树——自己所在的树留给后续会话，绑定中的树永远不碰（删掉绑定目录会让该线程终端永久失效）。

```bash
node <技能目录>/scripts/t3-worktree-gc.mjs               # dry-run：逐目录打印结论
node <技能目录>/scripts/t3-worktree-gc.mjs --apply       # 真正执行回收
node <技能目录>/scripts/t3-worktree-gc.mjs --root <dir>  # 单独指定扫描根
node <技能目录>/scripts/t3-worktree-gc.mjs --purge-build [--apply]  # 附带清理保留树的构建产物
node <技能目录>/scripts/t3-worktree-gc.mjs --purge-build --measure-size  # 显式统计候选产物大小
node <技能目录>/scripts/t3-worktree-gc.mjs --diagnose    # 对已阻断的树也收集 git 原因
```

扫描根与逐树结论实时写 stdout，阶段开始/结束、命令耗时及超时失败写 stderr；需要完整日志时用 `> gc.log 2>&1`，不要管道截断退出码。默认遇到 self、线程/占用或数据库阻断就跳过 git 重检查；排查全部原因时用 `--diagnose`（会增加遍历和联网成本）。

`--purge-build`：工作树因 git 原因保留（脏树、未推送、珍贵文件、unbound 半删残留）、但没有未终结线程、活跃 run 或不可归因的进程占用时，只删其中可重建的构建产物：cargo `target`（带 `.rustc_info.json`/`CACHEDIR.TAG`/`.fingerprint`）、`.build`、`node_modules`、`.gradle`、Xcode 派生数据（`DerivedData`，或含 `ModuleCache.noindex`/`Build/Intermediates.noindex` 的目录，在 ignored 目录内最多向下找两层）。只认 ignored 目录，不碰跟踪文件、未提交文件和其他 ignored 内容。多个工作树并行、磁盘吃紧时，用它代替删树来回收空间。默认只列目标，不运行 `du`；需要空间估算才加 `--measure-size`（逐目标遍历可能很慢，失败显示「未知」，不影响清理资格）。每棵树进入产物删除阶段时重拍一次进程占用快照，避免逐产物重复全机扫描；每个目标删除前刷新绑定并结合该占用快照检查，再核验 ignored 规则、跟踪与非 ignored 文件、产物标记和路径边界；目标及树内祖先是符号链接/junction 时保留。复查收窄并发窗口，不是原子锁；不要同时手动改写正在清理的目录。

全部满足才删，任一不满足则 skip 并注明原因：

- 调用者 cwd 不在该工作树内（self 永不删）；
- 是 git 链接工作树（独立 clone skip）。非 git/gitfile 失效的残留里，整树只含占位/系统垃圾文件（T3 合并 PR 后留的 `.keep`/`.worktree-placeholder`、`.DS_Store` 等）的占位目录同样过绑定/占用检查后删除；含其他内容标 not-a-worktree 只报告。`--apply` 收尾顺带 rmdir 本轮删空的二层分组目录；
- 绑定的线程全部已终结（settled / archived / deleted 任一；委派子线程的 settledOverride 永不写入，改看 subagents 表 child_thread_id/provider_thread_id 关联行——全部终态即算终结，无关联行仍算未终结；零绑定标 unbound 可删），且未终结线程没有 queued/preparing/starting/running/waiting 状态的 run——已终结线程上的 running 行是投影滞留（见「已观察到的坑」），降级为备注放行；
- `git status --porcelain -uall` 为空（`-uall` 覆盖 `status.showUntrackedFiles` 配置；所有读工作树状态的调用带 `-c core.fsmonitor=false -c core.untrackedCache=false`，防 fsmonitor 钩子/未跟踪缓存误报把本地编辑藏掉）；ignored 逐文件展开里没有命中「珍贵模式」的条目——珍贵模式 = 凭据类文件类型（`.env`、密钥/证书/keystore、`*.properties`、kubeconfig、`.kube`/`.docker`/`.azure` 等云凭据目录、`.config/gh`/`gcloud`（项目本地 `GH_CONFIG_DIR` 等 CLI 凭据区）、`*.tfstate*`/`local.settings.json`、`hosts.yml`、`.git-crypt`、凭据命名、本地数据库等，全集见脚本里 `PRECIOUS_PATTERNS`/`PRECIOUS_SUBSTRINGS`）；命中前先过 `BENIGN_DIR_SEGMENTS` 良性目录段滤掉产物/依赖目录（含 `.build`/`.tmp`/`Pods`/`Carthage`/`SourcePackages` 等 SwiftPM、CocoaPods 检出与派生数据），命中列出文件，其余 ignored 条目收敛到顶层名进报告、超 8 个截断。`*.properties` 命中再过内容级豁免：整文件键都在工具链白名单（`sdk.dir`/`ndk.dir`/`cmake.dir`/`flutter.*`）的是 IDE 生成的 SDK 指针而非凭据（`local.properties` 常态），放行进报告；其他键、不可解析行、读取失败维持阻断；
- 没有 ls-files 下探不了的目录（嵌套 git 仓库等尾斜杠条目；良性目录段内的豁免——`.build/checkouts` 这类依赖检出不算用户仓库）、没有 git 子模块（索引里没有 mode 160000 的 gitlink）、没有 assume-unchanged/skip-worktree 标记文件（`ls-files -v` 小写或 `S` 标签；两项合并成一次 `ls-files -s -v`）——这些路径的内部状态对所有检查不可见，一律不删；
- HEAD 改动已在远端：HEAD 是某 `refs/remotes/origin/*` 的祖先，或 `git cherry` 逐提交 patch 等价（rebase/单提交 squash 合并），或整支 `diff(base..HEAD)` 的 patch-id 命中 `base..ref` 上某提交（多提交 squash 合并，上游比对封顶 400 个提交），或对 base 无净改动。patch 等价放行的是改动内容——提交对象仍丢弃，squash 工作流正是如此；内容对不上的孤立提交仍阻断。判定前先对该仓库跑一次 `fetch origin --prune` 刷新本地跟踪引用——远端删过分支后残留的 tracking ref 不代表已推送；远端不可达即 skip。注意 dry-run 也会执行这一步：fetch 需要联网、会更新本地 `refs/remotes/origin/*`（已禁交互凭据提示，缺凭据直接判不可达不卡终端）。patch 等价的分支在 `--apply` 后用 `branch -D` 强删（git 视角是未合并分支，但内容已在远端）；
- 没有进程以它为 cwd（POSIX 用 lsof，缺席时 Linux 退 /proc；检查不可用仍是阻断——看不到占用无从归因。例外：绑定线程全部终结时，占用者只可能是已终结线程的残留进程——孤儿代理/模拟器/守护进程——降级为备注放行，删掉干净且已推送的目录只让残留进程 cwd 失效；未绑定目录的占用无法归因——可能是闲逛进去的活线程——维持阻断。Windows 不查，靠删除失败兜底）。

`--apply` 在真正删除前对该目录重拍线程绑定/活跃 run/进程占用快照并重查 git 侧全部条件，收窄扫描与执行之间的并发窗口。报告末尾汇总行附「在用工作树」计数（有未终结绑定线程或进行中 run 的目录数）。

数据库 `userdata/statev2.sqlite` 只读打开（node:sqlite 优先，退回 sqlite3 CLI）；缺席或打不开时此根下全部 skip，不做删除。`--apply` 下用 `rmSync` 删目录后 `git worktree prune` 注销（不用 `worktree remove`：spawn 超时会把数万文件的递归删除砍在半途，留下半删残留），再用 `git branch -d` 兜底删本地分支（改动已验证在远端的分支 `-d` 拒删时改用 `-D`——patch 等价与已推送未合入当前 HEAD 都算，失败保留并注明）；任一步失败标 failed 继续下一个，退出码置非 0；绝不结束进程、不换更强硬的命令重试。

测试：`node <技能目录>/scripts/t3-worktree-gc.test.mjs`——在临时目录造夹具（git 仓库 + 假 origin + 最小 statev2.sqlite），覆盖每条 skip 原因；不碰真实 `~/.t3`。

外部依赖：T3 目前不能解除线程与工作树的绑定、也没有「退回 root」的接口（`t3_worktree_handoff` 只能转入新工作树）；绑定中的工作树只能等线程终结后由 gc 回收，解绑能力依赖 T3 产品改动。

## 已观察到的坑

- 少数 ACP 代理收了 MCP 注入但不暴露工具——先用上面的 `acp-mcp-call` 兜底验证一次再下结论。
- delegated 子代理偶发静默丢失，主代理要做好降级自审。
- `subagents`/`runs` 投影停在 `running` 有两种真因：子线程实际已完工（投影滞留）；或子代理卡在授权等待——子线程尾部是 `approval_request`/`waiting` 事件，`approval-required` 模式的后台子代理没人批授权就永久挂起，`task_status` 却一直 running。别只信状态轮询，用 `t3_thread_read` 读 `childThreadId` 尾部判断真实进度；授权挂起时批准放行或 `task_cancel` 后按继承模式重派。
- `mcp__t3-code__*` 偶发报 "Failed to connect to MCP server 't3-code'"，重试即恢复；不行再走 ACP 兜底。
- `mcp_list_tools` 每次会话都重查完整目录，token 开销不小。
- `command_execution` 输出留存不全（见上节），分析失败命令时 stderr 多半拿不到，只能看退出码。

