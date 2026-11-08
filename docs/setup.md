# 技能安装与更新指南

描述本仓库技能在新设备/本机上的安装与更新步骤。工具为 [skills.sh](https://www.skills.sh/docs/cli) 提供的 `skills` CLI，通过 `npx skills` 直接运行，无需安装。

## 核心原则

执行本文档任何步骤前，先记住三条：

1. **一律通过 CLI 操作，禁止手动 `rm -rf` 技能目录。** CLI 会同步维护 `~/.agents/.skill-lock.json` 状态文件并清理各 agent 目录中的链接，手动删除会留下残留条目。
2. **禁止使用 `--all`。** 它等价于 `--skill '*' --agent '*' -y`，其中 `--agent '*'` 会把符号链接铺到本机检测到的全部 60+ 个 agent。
3. **不确定就问。** 以下任何选项不明确时（装哪些技能、装给哪些 agent、全局还是项目级），主动询问用户确认，不要自行决定。

默认安装范围：`universal`（通用目录 `~/.agents/skills/`，支持该标准的 agent 如 Codex、Cursor、Cline、Antigravity 会自动读取）+ `claude-code`（通过 `~/.claude/skills/` 符号链接）。

## 安装

### 1. 查看仓库技能清单（只列不装）

```bash
npx skills add gitbobobo/skills -l
```

### 2. 确认安装范围

- **技能**：全部（`-s "*"`）或指定技能（`-s git-prefs`，多个重复传参）
- **agent**：默认 `-a universal -a claude-code`；用户另有要求时按需调整
- **范围**：默认全局 `-g`（本机所有项目可用）

注意：

- `-a` 必须重复传递，`-a claude-code,universal` 这种逗号写法会报 `Invalid agents`。
- 通配符用双引号 `"*"`。Windows cmd 不会剥掉单引号，`'*'` 会被当成字面字符串传给 CLI，报 `No matching skills found`；双引号在 cmd、PowerShell、bash 下都能用。

### 3. 执行安装

```bash
# 全部技能，装到通用目录 + Claude Code（推荐）
npx skills add gitbobobo/skills -g -s "*" -a universal -a claude-code -y

# 单个技能
npx skills add gitbobobo/skills -g -s git-prefs -a universal -a claude-code -y
```

### 4. 验证

```bash
npx skills ls -g
```

- 技能文件应位于 `~/.agents/skills/<name>`，Claude Code 链接应位于 `~/.claude/skills/<name>`
- 输出中 Eve、PromptScript 报「不支持全局安装」属预期，可忽略
- `Agents:` 一行是"可读取该技能的 agent"列表，并非实际创建的符号链接

### 5. 初始化设备与偏好

安装后在 agent 里调用 `$bstack-setup`：同步全局代理规则、体检本机，并按需配置各技能偏好（存于 `~/.config/bstack/`，可选私有仓库同步）。

从旧版升级的设备：`bstack-setup` 取代了 `setup-env`。装好新技能并跑过一次设备初始化后，执行 `npx skills remove setup-env -g -y` 卸掉旧技能。

## 更新

本仓库技能推新后，在任一目录执行：

```bash
npx skills update -g                      # 更新全部全局技能
npx skills update -g git-prefs            # 只更新指定技能
```

- `-p` 仅更新项目级，`-y` 跳过范围确认
- 也可以直接重跑上面的安装命令，等效于覆盖安装到最新版（推荐换设备时用这个）

## 移除

```bash
npx skills remove <skill...> -g -y   # 省略 -a 时会同时清理所有 agent 链接
```

## 附注

- 查看有效 agent 标识符：给 `-a` 传一个无效值（如 `-a xx`），报错信息会列出全部有效标识（如 `universal`、`claude-code`、`codex`、`cursor` 等）
- CLI 默认收集匿名遥测，设置环境变量 `DISABLE_TELEMETRY=1` 可关闭
- 专用技能 `fast-ship`、`html-preview` 需要先配置对应服务的 API Key（`~/.config/fast-ship/config.yaml`、`~/.config/html-preview/config.yaml`），`uiv` 需要 `UIV_URL` 和 `UIV_TOKEN` 环境变量，详见各自 SKILL.md
