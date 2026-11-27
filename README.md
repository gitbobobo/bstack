# bstack

个人开发工作流技能集，偏好统一存放在 `~/.config/bstack/`。

## 目录结构

- `skills/bstack/`：bstack 体系技能，相互配合，共用 `~/.config/bstack/` 配置
- `skills/general/`：通用原创技能，可独立安装
- `skills/services/`：提取自外部服务的专用技能（源头在各服务仓库）
- `skills/forks/`：分叉技能（注明来源，保持可独立安装）
- `docs/`：文档，包括[安装与更新](docs/setup.md)、[bstack 设计](docs/bstack-design.md)和两份 Musiver 复盘（[PR 准入](docs/musiver-pr-admission-audit.md)、[派活覆盖](docs/musiver-dispatch-coverage-audit.md)）

## 给 Agent 的安装提示词

在新设备上，把下面代码块的内容直接发给任意 agent，即可按文档安装/更新本仓库全部技能：

```text
请阅读 https://raw.githubusercontent.com/gitbobobo/bstack/main/docs/setup.md，按文档安装/更新该仓库的全部技能，不确定时先问我。
```

## bstack 技能

### bstack-setup

新设备初始化与偏好配置入口：同步各 harness 的全局代理规则、体检本机，并写入各技能偏好。仅限用户主动调用。[SKILL.md](skills/bstack/bstack-setup/SKILL.md)

### t3-code

本机 T3 Code 运行状态的内部参考，含会话查询、子线程取证、监听唤醒、收尾窗口与孤儿工作树回收。[SKILL.md](skills/bstack/t3-code/SKILL.md)

### t3-orchestrator

T3 Code 多 harness 编排：从实现/顾问两类固定档位的模型池选 harness 与模型，派活验收并在失败时换路续跑。[SKILL.md](skills/bstack/t3-orchestrator/SKILL.md)

### t3-patrol

定时巡检各 T3 环境中巡检体系自行派出及交接创建的未结线程：一条脚本出决策包，研判子代理并行逐线程定案，主代理审批后由脚本执行、回读并记下线程状态表，用户手动线程保持只读。[SKILL.md](skills/bstack/t3-patrol/SKILL.md)

### t3-dispatch

补货子代理把候选研判进跨轮题库（按仓库总量和各设备可派缺口备货），有空位时按题库顺序出队，复核来源、查重、核仓库身份后建工作树线程。[SKILL.md](skills/bstack/t3-dispatch/SKILL.md)

### acceptance-digest

从近 24 小时各项目合并的 PR 中挑出需要用户亲自验收的，合并发布一份验收总览，侧边栏按项目分组显示进度并支持快捷跳转。[SKILL.md](skills/bstack/acceptance-digest/SKILL.md)

## 通用技能

### git-prefs

git 操作偏好：可审计提交、rebase 同步远程，以及按用户要求删除当前工作树。[SKILL.md](skills/general/git-prefs/SKILL.md)

### pr-review-loop

判断审查意见在当前 PR 的处理范围、开 PR、按预算收敛审查与测试失败分诊，独立任务的派活另行评估。[SKILL.md](skills/general/pr-review-loop/SKILL.md)

### pr-finish

PR 收尾：整合目标分支、合并、分流遗留，再关闭关联问题并回收工作树与分支。[SKILL.md](skills/general/pr-finish/SKILL.md)

### test-audit

默认全仓找线索、分批核实慢测、flaky、弱断言与冗余测试，给出修改及 lint 建议，并保留续扫摘要。[SKILL.md](skills/general/test-audit/SKILL.md) · [三仓库调研与设计依据](docs/test-audit-research.md)

### architecture-audit

在本地对仓库做架构审计，核实深化候选并出中文报告。[SKILL.md](skills/general/architecture-audit/SKILL.md)

### bad-pattern-audit

在本地寻找 agent 容易照抄、且多处重复的不良编程模式，核实证据并出中文报告。[SKILL.md](skills/general/bad-pattern-audit/SKILL.md)

### performance-audit

在本地对仓库做性能审计，核实热路径上有证据的问题并出中文报告。[SKILL.md](skills/general/performance-audit/SKILL.md)

### dependency-audit

在本地对仓库做依赖审计，对照 registry 核实直接依赖并分档并出中文报告。[SKILL.md](skills/general/dependency-audit/SKILL.md)

### bug-audit

在本地对仓库做 bug 审计，核实生产可达、有证据的逻辑与安全问题并出中文报告。[SKILL.md](skills/general/bug-audit/SKILL.md)

### harmful-prompt-audit

按可扩充的模式库扫描仓库中对 agent 有害的提示词、规则与任务描述（首个模式：诱导创可贴修复的"最小改动"措辞），给出改写建议。[SKILL.md](skills/general/harmful-prompt-audit/SKILL.md)

### create-ui-polish-skill

为仓库生成或升级界面打磨专用技能：完整界面地图、按平台族划分的布局蓝图、截图工具，以及「定调轮由用户确认打磨范围、之后只采纳评审建议」的评分循环，前后截图对比和过程记录生成网页。仅限用户主动调用。[SKILL.md](skills/general/create-ui-polish-skill/SKILL.md)

## 服务技能

### fast-ship

通过 Fast Ship REST API 创建、更新与查询 Issue。[SKILL.md](skills/services/fast-ship/SKILL.md)

来源：[gitbobobo/fast_ship](https://github.com/gitbobobo/fast_ship/tree/main/skills/fast-ship)

### html-preview

通过 HTML Preview REST API 上传、管理 HTML/ZIP 预览页。[SKILL.md](skills/services/html-preview/SKILL.md)

来源：[gitbobobo/html-preview](https://github.com/gitbobobo/html-preview/tree/main/skills/html-preview)

### uiv

把截图、录屏上传到 UIV，拿到公开链接与 Markdown。[SKILL.md](skills/services/uiv/SKILL.md)

来源：[gitbobobo/uiv](https://github.com/gitbobobo/uiv/tree/main/skills/uiv)

## 分叉技能

### blast-radius

改动发布前找出它会在别处破坏什么，并运行真实代码证明它安全。[SKILL.md](skills/forks/blast-radius/SKILL.md)

来源：[cursor/plugins — pstack/skills/blast-radius](https://github.com/cursor/plugins/tree/main/pstack/skills/blast-radius)（MIT），已改造为可独立安装。

### code-review-panel

推送前让两个不同模型家族的只读审查者对抗审查同一份 diff，再归并结论。[SKILL.md](skills/forks/code-review-panel/SKILL.md)

来源：[cursor/plugins — pstack/skills/interrogate](https://github.com/cursor/plugins/tree/main/pstack/skills/interrogate)（MIT），改名改造而来。

### diagnosing-bugs

疑难 bug 与性能回退的诊断回路：先建能复现的反馈回路，再按假设定位。[SKILL.md](skills/forks/diagnosing-bugs/SKILL.md)

来源：[mattpocock/skills — skills/engineering/diagnosing-bugs](https://github.com/mattpocock/skills/tree/main/skills/engineering/diagnosing-bugs)

### frontend-design

前端界面设计指导，做出不像模板的独特视觉方向。[SKILL.md](skills/forks/frontend-design/SKILL.md)

来源：[anthropics/skills — skills/frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design)（Apache-2.0）

### grilling

就一个计划、决策或想法对用户连环追问，直到达成共同理解。[SKILL.md](skills/forks/grilling/SKILL.md)

来源：[mattpocock/skills — skills/productivity/grilling](https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling)

### writing-for-agents

给 agent 写文档（技能、AGENTS.md 等）的通用参考。[SKILL.md](skills/forks/writing-for-agents/SKILL.md)

来源：[mattpocock/skills — skills/productivity/writing-for-agents](https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents)

## 工具脚本

### check

仓库一致性检查，含通用技能不得反向引用 bstack 的依赖边界；改动技能或 README 后运行：`node scripts/check.mjs`。[scripts/check.mjs](scripts/check.mjs)
