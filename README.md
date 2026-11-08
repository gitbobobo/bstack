# skills

个人开发工作流，保存常用技能与工具脚本。

## 目录结构

- `skills/godbobo/general/`：通用原创技能
- `skills/godbobo/specialized/`：专用原创技能
- `skills/forks/`：分叉技能（导入时注明来源，保持可独立安装）
- `docs/`：文档（bstack 改造方案与进度见 [docs/bstack-design.md](docs/bstack-design.md)）

技能的安装与更新步骤见 [docs/setup.md](docs/setup.md)（通过 `skills` CLI 安装到通用目录 + Claude Code，避免链接到所有 agent）。

## 给 Agent 的安装提示词

在新设备上，把下面代码块的内容直接发给任意 agent，即可按文档安装/更新本仓库全部技能：

```text
请阅读 https://raw.githubusercontent.com/gitbobobo/skills/main/docs/setup.md，按文档安装/更新该仓库的全部技能，不确定时先问我。
```

## 技能列表

### git-prefs

git 操作偏好：可审计粒度的规范提交、远程同步（未推送分支优先 rebase，已开 PR 的分支审查期间不追目标分支）、删除当前工作树。「删除工作树」默认指当前所在的工作树，跑 `scripts/empty-worktree.mjs`：清空全部内容、保留目录壳维持终端 cwd，并在主仓库注销注册；仅限用户明确要求时执行。

详见 [skills/godbobo/general/git-prefs/SKILL.md](skills/godbobo/general/git-prefs/SKILL.md)。

### pr-review-loop

开 PR 前确定模板，在描述里写清意图与范围；审查按预算推进：默认 3 轮，安全、数据、并发类 blocker 才延长到 5 轮，后续轮只核对改动代码与未关闭意见。意见按意图自行分级（blocker / should / nit / wrong），审查者的 P0–P2 只是线索，只为 blocker 和 should 推送，nit 一行回复不改代码；某轮只剩 nit 就收尾。同一 blocker 反复复发时按需读取方向审计。测试失败统一分诊、限制无效重跑，复用 diagnosing-bugs 定位根因；临时隔离须报告覆盖缺口与恢复安排。宿主回复接口按需读取引用文件，审查期间不追目标分支。

详见 [skills/godbobo/general/pr-review-loop/SKILL.md](skills/godbobo/general/pr-review-loop/SKILL.md)。

### pr-finish

PR 收尾：对最新目标分支一次性整合（默认 merge）并解决冲突、处理阻塞合并的基线问题；收尾推送触发的审查沿用 pr-review-loop 的账本与预算，只为整合带来的 blocker 再修，无冲突的整合只等检查；合并后交接后续工作、关闭关联问题、回收工作树与分支。检查与合并入口、合并方式、交接约定读仓库自己的文档，未声明时用默认做法。PR 审查收敛、用户要求收尾时使用。

详见 [skills/godbobo/general/pr-finish/SKILL.md](skills/godbobo/general/pr-finish/SKILL.md)。

### setup-env

统一设置本机各 agent harness 的全局代理规则（唯一真源 `rules/AGENTS.md`）并做环境体检；区分 Cargo 工具未安装与 PATH 不可见，装了 sccache 时配置全局 rustc-wrapper 共享编译缓存，检查 Windows 上 pi 是否会落到 WSL bash。仅限用户主动调用。

详见 [skills/godbobo/general/setup-env/SKILL.md](skills/godbobo/general/setup-env/SKILL.md)。

### t3-code

本机 T3 Code 运行状态的内部参考：状态库表布局与会话查询方法、子线程取证（`view:"activity"` 与 `file_change` 快照恢复）、编排机制事实、监听与唤醒（含 MCP 工具延迟加载与本账号评论不唤醒的坑）与平台坑；含孤儿工作树回收脚本 `t3-worktree-gc.mjs`（实时输出进度，`--purge-build` 可只清保留树的构建产物，空间统计需显式加 `--measure-size`）；跨环境复盘用 `t3-activity-scan.mjs` 经 T3 MCP 端点收集各环境活跃线程及其技能读取记录。专用技能。

详见 [skills/godbobo/specialized/t3-code/SKILL.md](skills/godbobo/specialized/t3-code/SKILL.md)。

### t3-orchestrator

T3 Code 多 harness 编排：pi / codex / devin / factory droid 四个 harness，pi 经 cliproxyapi 调 glm/deepseek/grok/gpt 系（额度由 cliproxyapi 自动路由）；swe-2 只走 devin、opus 走 devin/droid（用户定；cliproxyapi 的 devin 订阅已移除）。选 harness/模型由 `route.mjs` 按固定规则裁决（`route-data.mjs` 是唯一事实源，`route.mjs audit` 核对路由数据与实时目录），delegate_task 派活验收（子代理一律 `runtimeMode:"full-access"`，不为它向用户索要授权；卡在 `approval_request` 就取消重派），失败自动换路续跑；实现顾问由 `--task design` 单独选出，Opus 只做实现顾问；非产品决策由主代理按「根治」取向自主拍板，命中方向顾问触发（审计、技术取舍、跨模块方案、高风险决策）就派一位顾问独立裁决，不停下等用户；附 `route-playground.mjs` 可视化路由沙盒。专用技能，仅限用户或技能点名时调用。

详见 [skills/godbobo/specialized/t3-orchestrator/SKILL.md](skills/godbobo/specialized/t3-orchestrator/SKILL.md)。

### t3-patrol

跨 T3 环境巡检未结线程，适合每小时定时运行。逐线程核对快照与实际进展，再做故障恢复、预算收口（轮次越过审查预算且只剩非 blocker 时推线程停止修复并收尾）、代授权及交接；消息沉默和审查时间差先补查，「审查在途」须有晚于最新 HEAD 的触发证据，队列只清理已核实可被 PR 实况覆盖的系统通知。发送前刷新并去重，发送后区分已排队、已启动、已执行和已完成，报告保留未测与审查者缺席事实。仍有 blocker 的审计预测失败或反例由实现线程结合顾问意见处理根因，技术分歧不自动交回用户；用户决策与外部阻塞分开汇报。模型恢复、快照取证和交接细节按分支读取。模型阶梯、名额与阈值的默认值在 `references/config.defaults.json`，用户在 `~/.config/bstack/t3-patrol.json` 只写要改的键（`scripts/patrol-config.mjs` 输出生效配置，拼错的键与错类型报警告）。专用技能，仅定时任务点名时使用。

详见 [skills/godbobo/specialized/t3-patrol/SKILL.md](skills/godbobo/specialized/t3-patrol/SKILL.md)。

### html-preview

通过 HTML Preview REST API 上传、管理 HTML/ZIP 预览页并生成分享链接（需 API Key）。专用技能，配合同名服务使用。

来源：[gitbobobo/html-preview — skills/html-preview](https://github.com/gitbobobo/html-preview/tree/main/skills/html-preview)

详见 [skills/godbobo/specialized/html-preview/SKILL.md](skills/godbobo/specialized/html-preview/SKILL.md)。

### fast-ship

通过 Fast Ship REST API 创建、更新与查询 Issue：PR 关联、人机协作区、附件、截图标注、自身日志查询与 T3 项目绑定等（需 API Key）。专用技能，配合同名服务使用。

来源：[gitbobobo/fast_ship — skills/fast-ship](https://github.com/gitbobobo/fast_ship/tree/main/skills/fast-ship)

详见 [skills/godbobo/specialized/fast-ship/SKILL.md](skills/godbobo/specialized/fast-ship/SKILL.md)。

### uiv

把截图、录屏上传到 UIV，拿到公开链接与 Markdown，用于展示端到端验证成果（需 `UIV_URL`/`UIV_TOKEN`）；含「等界面到达最终状态再截图」与动图自检规则。专用技能，配合同名自托管服务使用。

来源：[gitbobobo/uiv — skills/uiv](https://github.com/gitbobobo/uiv/tree/main/skills/uiv)

详见 [skills/godbobo/specialized/uiv/SKILL.md](skills/godbobo/specialized/uiv/SKILL.md)。

## 分叉技能

### blast-radius

改动发布前找出它会在别处破坏什么，并运行真实代码证明「安全所依赖的那个事实」。

来源：[cursor/plugins — pstack/skills/blast-radius](https://github.com/cursor/plugins/tree/main/pstack/skills/blast-radius)（MIT）。已改造为可独立安装。

详见 [skills/forks/blast-radius/SKILL.md](skills/forks/blast-radius/SKILL.md)。

### code-review-panel

高风险改动推送前，用两个不同模型家族的只读审查者检查同一份 diff，主代理归并裁决。

来源：[cursor/plugins — pstack/skills/interrogate](https://github.com/cursor/plugins/tree/main/pstack/skills/interrogate)（MIT），改名改造而来。

详见 [skills/forks/code-review-panel/SKILL.md](skills/forks/code-review-panel/SKILL.md)。

### create-verification-skill

访谈仓库后生成项目本地的验证技能（SKILL.md + feature map），按自己的说明完整跑一遍才交付。仅限用户主动调用。

来源：[cursor/plugins — pstack/skills/create-verification-skill](https://github.com/cursor/plugins/tree/main/pstack/skills/create-verification-skill)（MIT）。

详见 [skills/forks/create-verification-skill/SKILL.md](skills/forks/create-verification-skill/SKILL.md)。

### diagnosing-bugs

疑难 bug 与性能回退的诊断纪律：先建一条能变红的紧反馈回路，再按假设逐个插桩定位。

来源：[mattpocock/skills — skills/engineering/diagnosing-bugs](https://github.com/mattpocock/skills/tree/main/skills/engineering/diagnosing-bugs)

详见 [skills/forks/diagnosing-bugs/SKILL.md](skills/forks/diagnosing-bugs/SKILL.md)。

### frontend-design

前端界面设计指导：先头脑风暴出设计 token，再做不像模板的独特视觉方向。

来源：[anthropics/skills — skills/frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design)（Apache-2.0）

详见 [skills/forks/frontend-design/SKILL.md](skills/forks/frontend-design/SKILL.md)。

### grilling

就一个计划、决策或想法对用户连环追问，按设计树逐轮推进直到达成共同理解。

来源：[mattpocock/skills — skills/productivity/grilling](https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling)

详见 [skills/forks/grilling/SKILL.md](skills/forks/grilling/SKILL.md)。

### handoff

把当前会话压缩成交接文档保存到系统临时目录，供新会话接着干。仅限用户主动调用。

来源：[mattpocock/skills — skills/productivity/handoff](https://github.com/mattpocock/skills/tree/main/skills/productivity/handoff)

详见 [skills/forks/handoff/SKILL.md](skills/forks/handoff/SKILL.md)。

### maintain-verification-skill

create-verification-skill 生成的验证技能的维护回路：逐功能核查并实际驱动一遍。仅限用户主动调用。

来源：[cursor/plugins — pstack/skills/maintain-verification-skill](https://github.com/cursor/plugins/tree/main/pstack/skills/maintain-verification-skill)（MIT）。

详见 [skills/forks/maintain-verification-skill/SKILL.md](skills/forks/maintain-verification-skill/SKILL.md)。

### retro

复盘一次编码会话，向 agent 工作环境提改进建议。依赖同仓库的 writing-for-agents（单独安装时需一并安装）。仅限用户主动调用。

来源：[mattpocock/skills — skills/engineering/retro](https://github.com/mattpocock/skills/tree/main/skills/engineering/retro)；另吸收 [cursor/plugins — pstack/skills/correct](https://github.com/cursor/plugins/tree/main/pstack/skills/correct) 的两条主张。

详见 [skills/forks/retro/SKILL.md](skills/forks/retro/SKILL.md)。

### writing-for-agents

给 agent 写文档（技能、AGENTS.md 等）的通用参考：context pointer、信息层级、完成标准、删减原则。

来源：[mattpocock/skills — skills/productivity/writing-for-agents](https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents)

详见 [skills/forks/writing-for-agents/SKILL.md](skills/forks/writing-for-agents/SKILL.md)。

## 工具脚本

### check

仓库一致性检查：AGENTS/CLAUDE 一致、技能 frontmatter 与 README 小节、分叉来源标注、scripts 登记、`disable-model-invocation` 标注、技能测试全绿、脚本主入口判断经 `realpathSync`（技能经符号链接安装时不静默空转）。改动技能或 README 后运行。

```bash
node scripts/check.mjs
```

详见 [scripts/check.mjs](scripts/check.mjs)。
