# 子代理失败处理

`delegate_task` 失败的 `summary` 开头是 provider 的错误原文，按原文分类：

| 类型 | 典型原文 | 处理 |
|---|---|---|
| 临时过载、连接失败、限流或额度 | `at capacity`、`server_is_overloaded`、`503`、`stream disconnected`、`Reconnecting... 5/5`、`runtime stream failed`、`Aborted`、`429`、`usage limit`、`quota`、`credits` | 确认旧尝试退出后换路。pi 入口报这类错误说明 cliproxyapi 已经试过它能用的渠道；同一轮里 pi 上不同模型都报连接类错误，按 cliproxyapi 整体故障处理，`--exclude-provider pi` |
| 配置或环境 | `provider_unavailable`、`model_unavailable`、`Invalid value ... model`、`is not enabled`、`auth`、`Provider session failed to open`、`does not exist` | 不在原目标重试；重新调 `orchestrator_capabilities` 落盘，换入口 |
| 启动即失败 | 开始后 1 分钟内失败，期间没有任何工具调用，原文不属于上面几类（例如 `Provider turn failed`） | 按配置或环境处理 |
| 权限被拒 | `Permission denied for this tool`、`was denied because this agent is running in the background` | 不在原目标重试，改用 `delegate_task` 重派；已是 `delegate_task` 的，取消后用 `runtimeMode:"full-access"` 重派同一任务，不向用户要授权 |
| 卡在人工授权 | 子线程尾部是 `approval_request`，或 `task_status` 长期 `working` 而无新产物 | 既不是失败也不是合法等待：`task_cancel` 后用 `runtimeMode:"full-access"` 重派。不要让用户去点授权，也不要在汇报里写成「等你授权」——这是默认模式撞上 shell 命令限制，不是需求没授权 |
| 任务没做好 | 状态是 completed，但结果不达标 | 不算 harness 故障，走验收流程 |
| 长时间无新消息 | activity 很久没有新内容 | `status=working` 不算活着——请求流挂死时状态停 working、零事件。查子线程 provider 日志文件 mtime/大小是否增长、实际编译进程、锁持有者和排队状态；仍在编译或合法排队就继续等待。确认无实际进展再取消，退出确认后才换路 |

## 续跑

换路前先弄清上一次尝试做到了哪一步：

1. `t3_thread_read` 读失败的子线程（`childThreadId`），用 activity 视图看它改了什么、卡在哪；
2. `task_status` 与原始日志/实际进程交叉核对。需要取消时调 `task_cancel`；取消请求本身不是退出确认。确认旧写者及其构建子进程已退出、锁已释放，才能启动下一尝试。投影与实际不一致时继续查证，不复制启动同一写任务；仅可结束本任务拥有的进程。
3. 在工作目录看 `git status` 和 `git diff`，核对已完成步骤、失败日志、后台任务及剩余验证。

新提示词沿用委派模板，在「背景」末尾加上：

```text
上一次尝试由 <实例/模型> 执行，因 <错误类型> 中断。
已完成：<步骤与已有检查证据>
工作区已有的改动：<文件列表和源码状态>
失败日志：<原始路径>
后台任务：<PID/任务ID、归属、已确认退出或仍运行>
剩余验证：<检查与唯一负责人>
截图边界：<首次开始时间、累计耗时与崩溃计数，续跑不重置>
先核对这些改动是否正确，在此基础上继续，不要从头开始，也不要回滚。
```
