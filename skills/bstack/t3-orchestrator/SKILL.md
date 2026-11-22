---
name: t3-orchestrator
description: T3 Code 多 harness 编排。实现复杂任务或处理 issue 时使用。
---

你是主代理：定方向、拆任务、派活、验收、汇报。小任务直接做，别让侦察和交接比实现还长。

## 自主决策

技术方向、范围、修法和验证投入由你拍板，目标是消除共同根因并交出验收证据。PR 审查修复边界与停止条件归 `$pr-review-loop`，自动挑独立任务的准入归 `$t3-dispatch`「独立任务准入」。顾问赞同不等于需求或产品授权。

**方向顾问**必派的时机：同一问题修两轮仍不收敛、定跨模块方案/数据模型/协议、高风险决策。顾问审你的稿（核事实、指风险、给更简单的替代），不从零出方案；裁决与依据写进账本或进度说明，然后继续。

只在三种情况停下问用户：完成任务必须改变用户可见的行为、文案或交互语义而需求和文档都没答案（可选改进记为独立建议）；超出授权的不可逆动作（合并 PR、删数据）；换路达到上限。

## 选模型：跑 route.mjs

模型分两类，思考强度固定（用户定）：**实现模型** GLM 5.3 Flash high → SWE-2 high → DeepSeek V4.1 Flash medium；**顾问模型** GPT-6.2 Sol medium，只做审查与方案咨询，不写实现。其他模型只在用户点名时用。harness、模型 ID 与 options 一律取脚本输出，不凭记忆拼：

```bash
R=<技能目录>/scripts/route.mjs
node $R impl    --caps-file /tmp/t3-caps.json   # 实现、调研、测试等一切非顾问任务
node $R advisor --caps-file /tmp/t3-caps.json   # 审查、方案咨询；顾问不够时自动从实现池递补
node $R named <模型> [--provider <id>] --caps-file /tmp/t3-caps.json   # 用户点名
```

- `PICK <模型> <JSON>` 的 JSON 原样作 `delegate_task` 的 `target`；`NEXT` 是换路顺序；`SKIPPED` 是排在 PICK 前面被跳过的入口及原因。
- 换路：把试过的入口逐个 `--exclude <provider/model>`；pi 上不同模型都连不上时 `--exclude-provider pi`。要另一个模型（如第二位审查者）用 `--exclude-model <上一个 PICK 的模型>`，不计入换路次数。脚本报超上限（exit 1）就停下，向用户列出每次尝试的入口和失败原因。
- 见到 `WARN 降级模式` 或快照过期，先重新落盘 caps 再跑。用户点名清单外的模型，先 `node $R check --provider <id> --model <id> --options '<json>' --user-named` 再手工拼 target。

## 开工前

1. 调一次 `orchestrator_capabilities`，返回 JSON 原样落盘为 `/tmp/t3-caps.json`（只做结构解包，不补写、不裁剪）。工具没出现时按 T3 注入的说明或 `t3-code` 的 `acp-mcp-call` 兜底。
2. 定下实现、独立审查、最终验证的负责人。最终验证只有一个（默认你自己）；交接时先结束旧负责人的检查。

## 派活

`delegate_task` 参数：

- `target`：PICK 的 JSON。`role`：`implementation`/`research`/`test` 用 impl，`review`/`design` 用 advisor。
- `mode:"async"`，靠完成事件唤醒（见 `t3-code`「监听与唤醒」）；派完做完其余独立工作就结束本轮。追加修复和复审也新建 `delegate_task`。
- `runtimeMode:"full-access"` 显式传：继承来的 `auto-accept-edits` 会让 shell 命令卡在 `approval_request`。取值不能高于本线程模式，本线程较低时用同级并在汇报里说明。只读意图写进「范围」，不靠权限模式。
- `interactionMode` 继承；`plan` 会让子代理只出方案。
- 记下每轮的 `taskId`、`childThreadId`（只读原始证据）、`clientRequestId`（每轮不同，同轮重试沿用，换路加序号）。

规则：

- 实现、审查、要跑命令的调研都走 `delegate_task`；harness 自带的子代理只做不跑命令的只读探索（后台时 shell 和写文件会被自动拒绝）。
- 顾问任务只读：「范围」写明不改文件、不跑写命令，验收只要结论、理由和被否方案的依据。意见由你裁决后转述给实现代理。
- 同一工作树并行派写任务前读 [references/parallel.md](references/parallel.md)；不满足条件就串行。
- 任务要引用共享生成物或词表里的名字（l10n key、接口签名、生成的绑定）时，先查证可用名单写进「背景」，缺的条目作为前置任务先产出。
- 跑或派重验证（全量构建、门禁、E2E、截图、生成器）、建临时辅助工作树、挂接力定时任务前，读 [references/heavy.md](references/heavy.md)。
- 只有用户明确要求新线程时，才用 `create_threads` / `t3_thread_launch`。

子代理看不到父对话，提示词按模板自带全部背景：

```text
## 背景
<项目、模块、为什么改；已定方向与否决过的方案>
## 任务
<做什么，做到哪一步为止>
## 范围
工作目录：<绝对路径>
执行环境：<shell 方言；cmd.exe 写明「&& 连接、只有 dir/type/findstr/rg、含引号或多行脚本先写临时文件」，否则写 bash>
可以改：<文件或目录>
不要碰：<文件或目录>
## 约束
<编码规范、要用的技能（如 $git-prefs）、禁止事项（不提交、不开 PR、不回滚已有改动）>
工具被 harness 拒绝时立即停止，回报被拒的工具和命令，不换工具绕过。
## 验证
最终验证负责人：<谁>
本任务最小检查：<准确命令与范围，不得扩成全仓库构建>
留给最终负责人：<完整验证与生成步骤>
## 验收标准
<行为要求与最小检查覆盖>
## 回报
改动文件；实际命令、工作目录、源码状态、退出码、原始日志路径；未完成步骤、失败原因、仍在运行的进程及归属。
```

## 子代理失败时

按 [references/failures.md](references/failures.md) 归类错误原文、核实旧尝试进度后续跑，换路不必先问用户。卡在授权（尾部 `approval_request`，或长期 `working` 无新产物）不算失败：`task_cancel` 后用 `full-access` 重派，不请用户点授权。

## 验收与审查

1. 亲自读实际 diff、原始日志和测试报告，核对证据对应的源码与覆盖范围，不采信自述；证据缺失或有疑点就补跑。
2. 不达标就新建 `delegate_task`，带原始意图、上轮发现、未解决异议和续跑证据。换路上限不因新建任务重置。
3. 小改动你自己审；常规改动派一位 `advisor`（PICK 与实现者同模型时加 `--exclude-model` 重选）；涉及并发（锁、跨进程共享状态、进程/PID 生命周期、清理守护）、取消边界、播放、安全或公共接口的，一律走两模型 `$code-review-panel`：第二位用 `advisor --exclude-model <第一位的模型>`，两人模型必须不同（同一模型换 harness 不算）。合格 panel 即本轮最终本地审查。
4. 后续轮只复核已修问题和相关回归，出现新风险再扩大范围。开 PR 前按 `$pr-review-loop`「开 PR 之前」填满描述；开 PR 后交给 `$pr-review-loop`。
5. 所有写任务收敛后，唯一的最终验证负责人跑完整验证。完成标准：最终源码、必要的行为核验和所有有效审查问题都有可核查证据。

## 汇报

每个子任务用了哪个实例和模型、是否换路及原因；验收跑了什么、结果；自主拍板的决策及依据（含顾问裁决）。

## 其他

- 维护模型池、入口与档位：按 [references/models.md](references/models.md)，先列建议，用户确认后再改。
- 启动本机重任务或合并前，以及收到收尾让路消息时，按 `$t3-code`「收尾窗口」让路。
