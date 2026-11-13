# 派活标签

用户只给部分问题打标签；无标签问题沿用现有准入与技术排序。

| 标签 | 行为 |
| --- | --- |
| `bstack:priority` | 用户确认纳入派活，覆盖 GitHub 导入问题的 `trustedUsers` 作者限制；通过其余准入后排在无标签问题前，同组沿用技术排序 |
| `bstack:defer` | 排除自动派活，移除后恢复；与 priority 并存时暂缓生效，报告冲突 |

标签由用户分配，代理负责维护标签目录、读取与执行。先按标签判定：defer 暂缓优先；priority 表示用户确认，外部作者与可信作者同等进入候选，`trustedUsers` 为空也生效；无这两个标签时沿用作者限制，其他 `bstack:*` 名称不产生授权。优先标签仍受开放状态、准入工作流状态、已关联 PR、信息完整度、产品决定、依赖、查重与重派上限约束。用户当面要求增加派活数量时也遵守暂缓；用户明确要求实现某条暂缓问题时，以该指令为依据，经来源接口移除 defer 并回读后认领，报告中记录覆盖依据。

## 标签目录

初始化、增加派活仓库及每轮派活前，每个已配置仓库检查一次目录，补齐缺失标签；dry-run 只检查。已有标签保留名称、颜色和说明，具体问题上的标签保持原样。权限或认证不足时报告项目、仓库和缺口，已有标签继续生效。

目标是**问题所属仓库**：从 Fast Ship 项目详情的 `repository_url` 核实，代码主仓 `code_repo_url` 仅用于匹配 T3 项目。先依据项目配置、仓库文档或服务元数据确认 GitHub / Forgejo，其他主机名本身不能证明服务类型。

- **GitHub**：`node <技能目录>/scripts/issue-source.mjs ensure-labels --repo <repo>`；dry-run 加 `--check 1`。脚本经 Fast Ship 读取标签目录，缺失标签通过 `gh api` 与 UTF-8 文件创建，使用 gh 已有认证；已有标签保持原样。脚本会绕过目录缓存实时检查，处理并发创建。GitHub Enterprise 确认服务类型后，用 `gh api --hostname <主机> repos/<owner>/<repo>/labels` 查询，缺失项通过 POST 与 UTF-8 JSON 文件补齐并回读。
- **Forgejo**：Fast Ship 的 repo-labels 接口目前只承诺 GitHub，走 Forgejo 自身的目录。先用 `fj repo labels --help` 核对本机语法，再用 `fj --host <实例URL> repo labels <owner/repo> view` 检查；仅为缺失项执行 `fj --host <实例URL> repo labels <owner/repo> create <名称> <颜色> --description <说明>`，之后重新 view 确认。沿用 fj 对目标实例的认证，英文说明可直接传参。颜色与英文说明分别为：priority / `D93F0B` / `User priority; dispatch admission still applies`；defer / `CFD3D7` / `Defer automatic dispatch until this label is removed`。
- 服务尚未识别或 CLI 缺失时列出待补齐项，继续只读筛选；确认服务后按对应分支补齐，避免向其他服务发送 gh 写请求。

Forgejo 标签必须能从问题来源接口返回到候选与详情；核对一条已带标签的问题，确认 `list` 和 `show` 的 labels 包含该标签。来源尚未返回这些标签时，该仓库暂停自动派活并报告接入缺口，避免把读取不到当作无标签。新增独立 Forgejo 问题来源时，应在来源适配器实现 list/show/claim 与目录维护，沿用本规则。

创建后分别回读托管服务与 Fast Ship 的标签目录。Fast Ship 的非空目录缓存会直接返回旧列表，仓库标签在 Issue 同步时刷新；手动同步接口仅 JWT，API Key 无权触发。托管服务已确认而 Fast Ship 尚未出现时，报告「仓库已创建，Fast Ship 待同步」，已有标签继续生效；新标签在 Fast Ship 可选和可打标的验证保持未完成。

## 生效与报告

每轮重新读取标签；脚本在截取 shortlist 前排除 defer、提升 priority，模型在准入检查后保留这一顺序。shortlist 全被跳过时继续查看其余候选。手工派活同样按此顺序处理。

认领前回读最新标签，新增 defer 时跳过；合并重复问题时逐条核对，暂缓问题保持在任务范围外。已经运行的任务继续按原任务执行，标签变化本身不取消线程。

报告：选中的优先问题注明「用户标记优先」；未派出的优先问题写阻塞原因或容量限制；暂缓只汇总数量，冲突逐条列出；目录检查失败或缺失标签写入警告。
