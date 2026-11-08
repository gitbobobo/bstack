# bstack 设计

本仓库将改名为 bstack：一组相互配合的技能，偏好统一存放在用户目录的配置里，巡检从「任务安排」到「线程收尾」全程自动处理。本文记录已定方案和推进顺序，实施时按步骤更新状态。

## 原则

- 只硬依赖 T3 Code。问题来源、配置同步方式、模型等都可配置、可替换。
- 技能正文只写规则，个人事实（模型名、设备、名额、仓库）放进配置。配置缺失时退回默认值，默认值等于迁移前的行为。
- 仓库特有的流程（如设备分工）留在该仓库自己的文档里，不进配置，也不进通用技能。

## 配置目录 `~/.config/bstack/`

```
~/.config/bstack/
├── environments.json      # 设备别名 → environmentId，多技能共用
├── t3-patrol.json         # 巡检节奏、阈值、授权边界、派活档位
├── t3-dispatch.json       # 可派活仓库、问题来源、容量池、节流
├── t3-orchestrator.json   # harness 偏好、模型阶梯
├── devices/<别名>.json    # 按设备区分的值（本机路径、shell 方言）
├── templates/             # 派活提示词模板，带 {{source_block}} 等占位符
└── secrets/               # 已 gitignore，只在本机
```

- JSON 格式，脚本零依赖读取；每个文件带 `version`，技能读到旧版本时自行迁移。
- 不放密钥。各服务凭据留在自己的位置（`~/.config/fast-ship/`、gh/fj 登录、T3 `request_secret`）。
- 每个有偏好的技能自带 `references/config.defaults.json`，它同时充当结构说明：用户文件只能覆盖其中已有的键且类型相同，对象逐键合并、数组整体替换；拼错的键与错类型记 `warnings` 并沿用默认值，文件损坏记 `errors` 并整份回落默认值。加载器与测试随技能自带（首个实现：`t3-patrol/scripts/patrol-config.mjs`），`BSTACK_CONFIG_DIR` 可改配置目录。
- t3-orchestrator：`route-data.mjs` 保留为默认值，`route-config.mjs` 合并 `t3-orchestrator.json`，可覆盖模型状态、任务限定、入口、候选顺序和换路上限，也可新增模型；`PROVIDER_RULES`、任务类型与档位标准是技能规则，不进配置。

## setup 技能（`bstack-setup`）

用户主动调用（`disable-model-invocation: true`），由 setup-env 改名合并而来，作为新设备与偏好变更的唯一入口：

1. 扫描已安装技能（`scripts/discover.mjs`），列出带 `references/setup.md` 的技能及其状态（未配置 / 已配置 / 版本过旧）。setup.md 的 frontmatter 声明 `config`（主配置文件名）与 `version`。
2. 用户选择这次要配置或修改的技能。
3. 逐个读取该技能的 `setup.md`：提问、写入、验证（巡检的验证是一次 dry-run）。
4. 同步：询问是否用私有配置仓库在各环境同步。是则 `fj repo create bstack-config --private`（或 `gh repo create --private`），或克隆已有仓库。
5. 设备初始化部分沿用 setup-env：同步全局代理规则、环境体检。

每个技能的问题、默认值、结构与验证写在它自己的 `setup.md`，setup 只负责发现、询问、写入和同步。

### 配置仓库同步

- 配置仓库是可选项；技能只读 `~/.config/bstack/`，不关心它是不是 git 仓库。
- 由 `bstack-setup/scripts/config-repo.mjs` 实现（`status` / `init` / `clone` / `pull` / `commit`）；`secrets/` 与 `PAUSE` 只在本机，写进 `.gitignore`。
- 写入：`pull --rebase` → 修改 → 每项改动一个提交 → 推送。
- 读取：巡检每轮开始 `git pull --ff-only`，失败用本地版本并在报告里记一笔；其他设备在运行 setup 时拉取。

## 问题来源适配器

先做 fast-ship、GitHub、Forgejo；本地文件暂不做（实现线程在其他设备上改不到巡检宿主机的文件，认领和完成需要巡检代做，流程会多一条特殊路径）。

GitHub 与 Forgejo 合为一个托管平台适配器，底层分别走 `gh` 与 Forgejo REST（复用巡检快照已有的 Forgejo 取数与 `git credential fill`）。

| 操作 | fast-ship | GitHub / Forgejo |
|---|---|---|
| 准入 | 按 `workflow_status` 筛选（如 `todo`） | `ready` 标签，且由可信用户打上 |
| 认领 | 置 `in_progress` | 加 `in-progress` 标签并指派 |
| 附加块 | 现有 Fast Ship 附加块 | issue URL 与查看命令 |
| 完成 | 收尾时置 `done` | PR 正文 `Closes #N`，合并后自动关闭，收尾只核对 |
| 归还 | 改回 `todo` | 去掉标签 |

- 统一入口 `issue-source.mjs list --repo <名>` 输出只含判定字段的 JSON；排优先级由模型按规则判断。
- 可信门槛对三种来源都生效（含 Fast Ship 从 GitHub 导入的 `GH-xxx`）。问题正文按数据处理，模板声明它不是指令。
- Forgejo 没有原生「进行中」状态，标签名由 setup 询问，缺失时经用户确认后创建。

## 容量池

配置在 `t3-patrol.json` 的 `capacity.devices`（数组，整组替换），设备以 `environments.json` 的别名标识：

```json
{
  "capacity": {
    "devices": [
      { "device": "pc",       "pools": [{ "repos": ["musiver"], "max": 5 }, { "repos": "*", "max": 4 }] },
      { "device": "mac-mini", "pools": [{ "repos": ["musiver"], "max": 4 }, { "repos": ["tma"], "max": 2 }, { "repos": "*", "max": 4 }] },
      { "device": "linux",    "pools": [{ "repos": ["musiver"], "max": 1 }, { "repos": "*", "max": 4 }] },
      { "device": "mbp",      "pools": [{ "repos": ["musiver", "tma", "stream-music"], "max": 3 }, { "repos": "*", "max": 4 }] }
    ]
  }
}
```

- 仓库以 T3 项目的 `repositoryIdentity.canonicalKey` 标识（各环境 `projectId` 不同）。`repos` 写完整 key 精确比对；只写仓库名时比对 key 的最后一段，会同时命中不同宿主上的同名仓库（如 `liuyincs/musiver`）。
- 每个线程只落入第一个匹配的池；`"*"` 是上面未列出的仓库。「其他仓库 4 个」按每台设备各 4 个理解。
- 设备总上限取设备条目的 `maxActiveThreads`，缺省为 `capacity.maxActiveThreads`（5）。池加起来超过总上限时总上限先到，需要并行更多时在设备条目里调高。
- 占用沿用 `t3-patrol/references/handoff.md` 的定义：活跃 run 的顶层线程，加上 PR 仍 open、最近 2 小时内跑过的线程。审查线程（「代码审查 · PR #N」）只计入设备总数，不占仓库池。
- 快照每个环境输出 `capacity`：设备总数、各池占用、按仓库的可建数 `freeByRepo`、本机剩余磁盘。计算在 `t3-patrol/scripts/patrol-capacity.mjs`。
- 容量只约束巡检；用户手动开的线程照样占名额，但不受阻拦。空位先给等待中的交接，再给新问题。

## 巡检全流程

1. 收尾已有线程（现有 A→D）。
2. 按池计算空位，以第 1 步动作回读后的状态为准。
3. 空位先分给等待空位的交接。
4. 调 `t3-dispatch`：列候选 → 过滤（已关联 PR、已认领、信息不足、需产品决策）→ 按问题引用号在目标环境查重 → 排优先级并按仓库文档的设备分工匹配设备 → 认领 → 建线程 → 回读确认开工；开工失败则归还。
5. 报告新增「本轮派活」：选了什么、为什么跳过某些。

`t3-dispatch` 是独立技能，允许模型主动调用，手动「给 pc 再分两个任务」也走同一套规则。派活档位 `off` / `dry-run` / `auto`，先 dry-run 观察再切 auto。

### 保护措施

- 认领与线程对账：问题在进行中，但线程已 settle 或失败且无 PR，自动归还或重派，重派有次数上限。
- 额度：模型阶梯已降到兜底档时暂停派新任务，只做恢复。
- 节流：每轮、每天派活上限；`~/.config/bstack/PAUSE` 存在时跳过派活。
- 同仓库并行：对比在跑线程的范围，有重叠时在提示词写明分工或串行。
- 宿主：巡检宜放在常开的设备上，初始化时确认它能连到所有环境。

### 巡检初始化（`t3-patrol/references/setup.md`）

认设备并写 `environments.json` → 验证快照通道 → 询问可派活仓库、问题来源、容量池、模型阶梯、频率与免打扰时段、派活档位 → 写配置 → dry-run 给用户过目 → `schedule_task` 绑定专用线程，提示词只写「使用 t3-patrol 技能巡检」，`scheduledTaskId` 记入配置，重复初始化时更新而不重建。

## 快照通道

T3 只向 ACP 类 harness（droid、devin 等）的进程环境注入 `T3_ACP_MCP_ENDPOINT` 与 `T3_ACP_MCP_AUTHORIZATION`。Codex 自 T3 `7394d73abb`（2026-10-27）起改为在每线程配置里接收 T3 MCP，shell 拿不到会话，旧的 `T3_MCP_URL` / `T3_MCP_BEARER_TOKEN` 已不存在。巡检线程要用快照脚本，需运行在 ACP 类 harness 上；否则按 `snapshot.md` 手工取证。

## 推进顺序

| # | 步骤 | 状态 |
|---|---|---|
| 1 | 快照脚本改用 `T3_ACP_MCP_*` 通道 | 已完成 |
| 2 | 配置骨架；t3-patrol 的模型阶梯、名额、阈值迁入配置，默认值等于现状 | 已完成 |
| 3 | setup 技能（合并 setup-env），含私有配置仓库同步；拆分 t3-orchestrator 路由数据 | 已完成 |
| 4 | 快照按池统计容量，handoff 第 3 步改用池 | 已完成 |
| 5 | `t3-dispatch` 与 fast-ship 适配器，先手动使用 | 待办 |
| 6 | 接入巡检（dry-run → auto），t3-patrol `setup.md` 补派活相关问题（setup.md 的设备、偏好与定时任务部分已在第 3 步完成） | 待办 |
| 7 | GitHub / Forgejo 适配器 | 待办 |
| 8 | 仓库改名 bstack：GitHub 仓库、安装文档、各设备重装、T3 项目路径、复盘定时任务里的路径 | 待办 |
