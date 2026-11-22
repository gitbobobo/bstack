---
name: architecture-scan
description: 在本地对一个或多个代码仓库做架构扫描、核实深化候选，并仅在明确授权时写入 issue 跟踪系统时使用；默认只读报告，Grok CLI 可选。
---

# architecture-scan

找出 architectural friction，提出 **deepening opportunities**（把浅 module 做成深 module），改善可测试性与 AI 可导航性。

本技能可由**任意本地 agent** 执行：不依赖特定托管环境、外部回调，也不写死某用户的仓库名单。扫描对象、工作目录和是否建单都来自本轮说明或[配置示例](references/config.example.yaml)的本地副本。

默认**只读**：只出带证据的报告，不创建 issue、不改被扫仓库、不提交、不联网发布。写入 Fast Ship 必须同时满足：本轮用户明确授权建单，且本地配置里显式启用，见 [建单规则](references/filing.md)。**Grok CLI 可选**；缺省由当前 agent 按[扫描准则](references/criteria.md)直接扫描。

机械步骤（运行目录、并发锁、解析 out 中最后一个 JSON、校验 schema、写 manifest、安全清理）使用：

```bash
node <技能目录>/scripts/architecture-scan.mjs <命令> [参数]
```

用法见脚本头注释。架构判断、路径抽查和（授权后的）建单由 agent 完成；脚本不发起扫描、不调用 issue API、不读取凭证。

## 1. 范围与配置

1. 确定扫描对象：用户点名的本地路径、本轮给出的仓库列表，或本地配置里的 `targets`。技能本身没有默认仓库清单。
2. 记录每个目标的身份：显示名、本地路径或可克隆定位符、开始扫描时的 HEAD **SHA**。随后所有路径与行号都以该 SHA 为准。
3. 读本地配置（若有）：路径由 `--config`、环境变量 `ARCHITECTURE_SCAN_CONFIG` 或用户给出。示例见 [config.example.yaml](references/config.example.yaml)。不要把 API key、token 或服务地址写进该文件或命令行。
4. 未授权建单时，即使配置里误开了 `fast_ship.enabled`，本轮仍只出报告。

完成：每个目标都有名称与证据 SHA；工作目录、并发与超时若未配置则使用脚本默认（工作目录在系统临时目录下，并发 4，超时 3600 秒）；建单默认关闭。

## 2. 运行目录与锁

一次运行使用独立工作目录，默认 `$TMPDIR/architecture-scan-<YYYYMMDD-HHMM>`（目录已存在则追加进程号），不要与其它运行共用。

```bash
node <技能目录>/scripts/architecture-scan.mjs init-run [--work-dir DIR]
```

- `init-run` 会原子创建目录、写入 `run.json`，并 `mkdir .run.lock`。同一目录锁已存在则拒绝，避免两轮互相清理或重复汇总。
- 进入汇总前再 `acquire-lock --name .summary.lock`。该锁已存在则**静默结束**（不再解析、不再建单、不再通知）。
- 每个目标的克隆放在工作目录的子目录里，用完即删；核对证据需要时再按 SHA 浅克隆，用完再删。
- 失败（超时、克隆失败、分析失败）写入 `<name>.status`，不要删除整个工作目录直到第 6 步清理。其它目标继续。

完成：本轮有唯一工作目录和 `.run.lock`；未误用他人目录。

## 3. 扫描

对每个目标，在对应源代码（该 SHA 的检出）里按 [扫描准则](references/criteria.md) 探索。不要写 HTML 报告，不要向用户逐个追问候选（grilling）；只产出结构化发现。

扫描可由当前 agent 直接完成。仅当用户要求或本地配置显式 `grok.enabled: true`，且本机找得到 Grok CLI 时，才可把通读委托给它：在目标目录内非交互调用，标准输入关闭，提示词包含仓库标识、SHA、任务名「架构扫描」、准则要点，并要求**只输出一个 JSON**（schema 见 [产出格式](references/output-schema.md)）。模型、可执行文件路径用配置或环境变量覆盖，不要写死某台机器上的路径。CLI 失败、超时或输出无法解析时，由当前 agent **补扫**该目标，或将它记为未完成，并注明原因；不要把残缺输出当作成品。

无论谁做扫描，都将原始输出写入工作目录的 `<name>.out.txt`，状态写入 `<name>.status`（`ok|timeout|failed|clone_failed`、退出码、SHA）。全部目标结束后写 manifest：

```bash
node <技能目录>/scripts/architecture-scan.mjs write-manifest --work-dir DIR
```

完成：每个目标都有 status；ok 的目标有可解析产出或已转为补扫。

## 4. 解析与核实

对 status 为 `ok` 的目标，从 `<name>.out.txt` 取**最后一个完整 JSON**（可用 `parse-out`）。非 ok 或解析失败：补扫或记未完成，不要凑数。

每条 finding 必须带 `candidate`，并按 `validate-findings` 校验 schema。然后对照该目标证据 SHA 抽查：

- **真实：** 文件在该 SHA 中存在，行号对得上，描述与代码一致。路径不存在、行号对不上、证据不足 → 丢弃或降级。
- **有收益：** 能改善 locality、leverage 或测试面。纯风格、命名偏好、无热路径证据的 `Speculative`、或范围大到不可控的项默认跳过。
- **可控：** 建议有明确落点（文件 / module / 可验收行为），不是整体重写。

完成：进入报告的每条都经过核实；被丢弃的有内部原因，不必向用户逐条解释。

## 5. 报告与（可选）建单

只读模式下交付中文报告：范围（目标、SHA、方法）、通过核实的候选、跳过与未完成的摘要。允许零发现。

仅当第 1 步的建单条件成立时，才按 [建单规则](references/filing.md) 写入 Fast Ship：

- 使用已安装的 **fast-ship** 技能及其脚本（本仓库在 `skills/services/fast-ship`；也可独立安装）。不要在本技能里复制凭证或另写一套 HTTP 客户端。
- 查重必须包括开放单、**已关闭**单和**当天已新建**单；**每创建一张之前再查一次**当天同项目同主题。
- 中文标题；正文含现状（SHA 与文件路径）、问题、建议、收益、验收标准、来源日期与任务名。
- `source` 为 `internal`。写后回读，确认中文无替换字符。
- 凭证只存在于 fast-ship 的外部配置；本技能配置不得包含 key 或服务地址。未安装 fast-ship 或未完成其外部配置时，停止建单并只出报告，不要把密钥写入命令行或本技能文件。

## 6. 通知与清理

- **只通知本轮新建**的项目名、编号与标题。没有新建则**静默**，不要发「扫了但没建单」的摘要。
- 汇总结束后清理本轮工作目录及其中克隆：

```bash
node <技能目录>/scripts/architecture-scan.mjs cleanup --work-dir DIR
```

脚本只删除带有本技能 `run.json` 标记、且路径与记录一致的运行目录，拒绝删除主目录、家目录或临时目录根。不要删用户的配置文件或其它运行的目录。

完成：工作区不留下本轮克隆或未标记的临时目录；凭证未进入报告、commit 或命令行。
