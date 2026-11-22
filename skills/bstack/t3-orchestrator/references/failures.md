# 子代理失败处理

`delegate_task` 失败的 `summary` 开头是 provider 错误原文，按原文分类：

| 类型 | 典型原文 | 处理 |
|---|---|---|
| 过载、连接、限流、额度 | `at capacity`、`server_is_overloaded`、`503`、`stream disconnected`、`Reconnecting... 5/5`、`runtime stream failed`、`Aborted`、`429`、`usage limit`、`quota`、`credits` | 确认旧尝试退出后换路。pi 报这类错误说明 cliproxyapi 已试过能用的渠道；同一轮 pi 上不同模型都连不上就 `--exclude-provider pi` |
| 参数兼容 | `Unknown option`、`unsupported option`、`rejected options`、`Invalid value ... option`，常伴 `invalid_request` | 走下节「参数兼容」，不当额度或模型不可用处理 |
| 配置或环境 | `provider_unavailable`、`model_unavailable`、`Invalid value ... model`、`is not enabled`、`auth`、`Provider session failed to open`、`does not exist`；或开始 1 分钟内无任何工具调用就失败 | 重新落盘 caps，换入口 |
| 权限被拒 | `Permission denied for this tool`、`was denied because this agent is running in the background` | 取消后用 `runtimeMode:"full-access"` 的 `delegate_task` 重派，不向用户要授权 |
| 没做好 | completed 但不达标 | 不算 harness 故障，走验收 |
| 长时间无新消息 | activity 很久没新内容 | `working` 不代表活着。查子线程 provider 日志的 mtime/大小、实际编译进程、锁持有者与排队；仍在编译或合法排队就等，确认无进展再取消，退出确认后才换路 |

## 参数兼容

单次拒参不证明全局默认失效；思考强度必须保留，不能删档位换取启动成功。

1. 记下目标 `environmentId`、provider、完整 model ID、实传 options、错误原文与时间，区分请求被拒（无 taskId）与建任务后失败；后者先按「续跑」确认无活跃写者。
2. 刷新**目标环境**的 `orchestrator_capabilities`，按该模型核键名和取值（保留原始选项描述符，裁剪丢的不算不支持）。
3. 同实例、同模型、同档位重试：目录恢复原选项就沿用原参数；只有目录明确给出等价映射时才改键/值。目录仍无法表达原档位时记录能力缺口，按换路规则找能表达的入口。
4. 重试前 `route.mjs check --provider <id> --model <完整ID> --options '<含档位的JSON>' --caps-file <刷新后的目录>`；用新的 clientRequestId。仍被拒就重新归因。
5. 回读对应 task/run 确认启动成功后，才在本轮同目标请求中复用调整。参数错误不记额度失败；`route-data.mjs` 与用户配置保持不动，需要维护时把目标环境、错误与已验证的临时参数写进建议。

## 续跑

换路前弄清上一次做到哪一步：

1. `t3_thread_read` 读失败的子线程，看它改了什么、卡在哪。
2. `task_status` 与原始日志、实际进程交叉核对；`task_cancel` 不等于已退出，确认旧写者及其子进程退出、锁释放后才启动下一次。只结束本任务拥有的进程。
3. 在工作目录看 `git status`、`git diff`，核对已完成步骤与剩余验证。

新提示词沿用委派模板，「背景」末尾加：

```text
上一次尝试由 <实例/模型> 执行，因 <错误类型> 中断。
已完成：<步骤与已有检查证据>
工作区已有的改动：<文件列表和源码状态>
失败日志：<原始路径>
后台任务：<PID/任务ID、归属、是否已退出>
剩余验证：<检查与唯一负责人>
先核对这些改动是否正确，在此基础上继续，不要从头开始，也不要回滚。
```
