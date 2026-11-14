---
name: bstack-setup
description: bstack 的设备初始化与偏好配置入口。新设备初始化、修改技能偏好、全局约定变更后重同步时使用。仅限用户主动调用。
disable-model-invocation: true
---

新设备和偏好变更的唯一入口。本技能只负责发现、询问、写入和同步；每个技能问什么、写成什么结构、怎么验证，写在它自己的 `references/setup.md`。

配置目录是 `~/.config/bstack/`（`BSTACK_CONFIG_DIR` 可改），JSON 格式。技能只读这个目录，缺文件时用自带的默认值。

## 流程

1. **设备初始化**：按下文「设备初始化」同步全局代理规则并体检。用户只想改偏好、本机已初始化过时，跑 `--check` 确认全部就位即可。
2. **配置同步**：跑 `node <技能目录>/scripts/config-repo.mjs status`。
   - `repo: true`：跑 `pull`，失败就停下报告，不要在分叉的配置上继续写。
   - `repo: false`：问用户是否用私有仓库在各设备同步配置。三种答复：
     - 新建：`fj repo create bstack-config --private`（Forgejo）或 `gh repo create bstack-config --private`（GitHub），取它的克隆地址，跑 `config-repo.mjs init --remote <url>`。
     - 已有仓库：`config-repo.mjs clone <url>`；目录非空时向用户说明原目录会改名为 `.bak-<时间戳>` 保留，确认后加 `--backup-existing`。克隆后对比备份里的文件，有备份里独有的偏好就问用户是否并入。
     - 不同步：直接继续，以后随时可以重跑本技能开启。
3. **选择技能**：跑 `node <技能目录>/scripts/discover.mjs`，把结果整理成表（技能、配置文件、状态）给用户看，问这次要配置哪些。`outdated` 与 `broken` 的技能要提醒；`newer` 说明本机技能比配置旧，先 `npx skills update -g` 再配置；`invalid` 是技能自身缺陷，报告即可。
4. **逐个配置**：完整读取所选技能的 `setup.md`，按它的步骤提问、写入、验证。一个技能完成后再进行下一个。
5. **提交同步**：配置目录是仓库时，每个技能写完跑 `config-repo.mjs commit -m "chore(<技能名>): <改了什么>"`。推送失败时提交会留在本地，报告给用户；下次 commit 会重推。

**完成标准**：设备初始化体检退出码为 0；所选技能各自的验证通过；配置目录是仓库时 `status` 的 `dirty` 为空且 `ahead` 为 0。没通过的项写明原因和下一步。

## 写配置

- 改之前先读现有文件，只改这次问到的键，其他键原样保留。
- 只写与技能默认值不同的键，外加 `version`（取 setup.md 的 `version`）。用户说「恢复默认」就删掉那个键。
- 2 空格缩进，UTF-8 无 BOM，末尾换行。
- 不写密钥。凭据留在各服务自己的位置（如 `~/.config/fast-ship/`、gh/fj 登录、T3 `request_secret`）；确需落盘的放 `secrets/`。`secrets/`、`PAUSE` 与运行状态目录 `state/` 只在本机，不进配置仓库。
- `environments.json` 多个技能共用，写入前看清已有条目，不要整份覆盖。

## 技能如何接入

技能有用户偏好时，在 `references/setup.md` 开头写 frontmatter：

```markdown
---
config: <技能名>.json
version: 1
---
```

`config` 是配置目录里的主文件名，`discover.mjs` 按它判定状态；`version` 是当前配置结构的版本，结构变化时加 1，并在正文写明旧版本怎么迁移。正文写清要问的问题（附默认值）、写入的结构、验证方式。

## 设备初始化

把 `rules/AGENTS.md`（本技能目录下，唯一真源）链接到各 harness 的全局规则路径，让所有 CLI 代理在任何项目里都加载同一套约定；具体编排流程留在对应技能。同步后仍以项目规则优先。同时报告各 harness CLI 与本机工具（如 cargo-nextest）是否可用——工具只报告不安装。cargo-nextest 不在 PATH 时再探测 CARGO_HOME 和默认 Cargo bin，区分「未安装」与「已安装但 PATH 不可见」；后者在实际代理启动环境补路径，再从新代理执行 `cargo nextest --version` 验证。装了 sccache 时，把它写进 `$CARGO_HOME/config.toml` 的 `[build] rustc-wrapper`，让多个工作树共享 Rust 编译缓存（已有别的 wrapper 或设置了 `RUSTC_WRAPPER` 时不覆盖；改写前先备份原文件）；没装只报告。

1. 体检：`node <技能目录>/scripts/setup-env.mjs --check`，逐项看状态：已链接 / 旧链接 / 副本一致 / 副本过期 / 有别的内容 / 缺失。
2. 执行：`node <技能目录>/scripts/setup-env.mjs`。Windows 或符号链接权限不足时用 `--copy`。
3. 核对备份：脚本对已有非空内容会先备份成 `<文件>.bak-<时间戳>` 再替换。出现备份就提醒用户检查旧内容是否需要合并。「旧链接」是指向改名前 setup-env 技能的链接，直接改指真源，不备份。
4. 完成标准：脚本退出码为 0，且输出中每个 harness 显示「已链接」或「副本一致」。

### 从 setup-env 迁移

本技能由 setup-env 改名而来。装好本技能并跑过设备初始化后，旧链接都已改指新路径，再用 `npx skills remove setup-env -g -y` 卸掉旧技能。`--copy` 部署的设备内容一致即可，无需处理。

### 覆盖的 harness

| harness | macOS / Linux | Windows |
|---|---|---|
| devin | `~/.config/devin/AGENTS.md` | `%APPDATA%\devin\AGENTS.md` |
| codex | `~/.codex/AGENTS.md` | `~/.codex/AGENTS.md` |
| claude / claudeAgent | `~/.claude/CLAUDE.md` | `~/.claude/CLAUDE.md` |
| pi | `~/.pi/agent/AGENTS.md` | `~\.pi\agent\AGENTS.md` |

新增 harness 时改 `scripts/setup-env.mjs` 里的 `TARGETS`。pi 的目录可被 `PI_CODING_AGENT_DIR` 覆盖，脚本也照这个变量取路径。

pi 备注：在 Windows 上，pi 只去 C 盘的 `Program Files` 找 Git Bash，找不到就用 PATH 上的 `System32\bash.exe`，也就是 WSL。Git 装在其他盘时，体检会报 `pi:shell` 待处理，并给出应写进 `<agent-dir>/settings.json` 的 `"shellPath"`；照提示写入后重跑体检确认。

### 边界

- 全局规则是「会被加载」，不是「必定遵守」。跨 harness 委派（`delegate_task`）时的硬性约束仍要原文写进任务 prompt 转述。
- 仓库级规则仍放各仓库的 AGENTS.md；本文件只放与仓库无关的通用约定。
- 改约定只改 `rules/AGENTS.md`。符号链接立即生效；`--copy` 部署过的机器要重跑本脚本。
- 设备初始化只管全局规则和上述 cargo 全局配置，不装 CLI、不改项目。技能本身的安装走 `docs/setup.md` 的 `npx skills` 流程。
