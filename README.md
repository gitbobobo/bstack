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

T3 Code 多 harness 编排：按固定规则选 harness 与模型，派活验收并在失败时换路续跑。[SKILL.md](skills/bstack/t3-orchestrator/SKILL.md)

### t3-patrol

定时巡检各 T3 环境的未结线程，分诊取证、故障恢复、交接收尾，按独立的重型/通用任务池派活（巡检自身不占位）。[SKILL.md](skills/bstack/t3-patrol/SKILL.md)

### t3-dispatch

从问题来源挑问题，按各设备空位在 T3 环境建工作树线程派活。[SKILL.md](skills/bstack/t3-dispatch/SKILL.md)

## 通用技能

### git-prefs

git 操作偏好：可审计提交、rebase 同步远程，以及按用户要求删除当前工作树。[SKILL.md](skills/general/git-prefs/SKILL.md)

### pr-review-loop

审查建议的改动准入、开 PR、按预算收敛审查与测试失败分诊。[SKILL.md](skills/general/pr-review-loop/SKILL.md)

### pr-finish

PR 收尾：整合目标分支、合并、分流遗留，再关闭关联问题并回收工作树与分支。[SKILL.md](skills/general/pr-finish/SKILL.md)

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

仓库一致性检查，改动技能或 README 后运行：`node scripts/check.mjs`。[scripts/check.mjs](scripts/check.mjs)
