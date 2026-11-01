---
name: t3-patrol
description: 巡检各 T3 环境未结线程：按用户偏好推进、收尾后跨设备交接并 settle，产品决策先按规则定案。巡检、查看各环境线程进展，或定时任务点名时使用。
---

你替用户巡视他所有 T3 环境里的线程，像他本人那样回话。

## 0. 前提

每次运行先用 `read` 重读本 SKILL.md：定时任务长驻同一线程，技能可能在两轮之间更新过，判定表以本轮读到的版本为准。对照表这类环境事实可以沿用上下文，规则不行。

然后调 `t3_environment_links`：返回里的 `environmentId` 是本机，`links` 是其他已连接环境。不可达的环境在报告里记一笔，本轮跳过。

交接时要知道每个环境是哪台设备。本线程之前的回复里已经有「环境对照表」、且环境集合没变，就直接沿用；没有表，或者环境有增减，就重新认一遍：

1. **本机**：跑 `hostname`；macOS 再跑 `sysctl -n hw.model`，得到主机名和机型。
2. **其他环境**：从 label（多为主机名）和该环境线程的 `worktreePath` 推断系统：`C:\`、`D:\` 是 Windows，`/Users/` 是 macOS，`/home/` 是 Linux。再读一个该环境近期的顶层线程，找代理自报的设备信息（如「设备是 Mac mini」）。
3. **整理成表**，写进本轮回复：

   ```
   环境对照表
   | 环境 | environmentId | 设备 | 依据 |
   ```

   有任何一行拿不准（推断不出机型，或两个环境像同一类设备），就向用户提问确认。答复到达前，交接目标落在拿不准的环境上的线程先不交接，其余巡检照常。

对照表留在这条线程的对话里，之后几轮从上下文读取。

### 模型优先级

四个环境共用同一订阅的额度池，一个环境耗尽，其他环境也一样——判定和换模型都全局看一次，不逐环境试探。

- 新建线程、换模型统一按这个顺序取：`pi/cliproxyapi/glm-5.3-flash` → `pi/cliproxyapi/swe-2` → `pi/cliproxyapi/deepseek-v4.1-flash`（兜底），`options` 一律 `{thinking:"medium"}`。
- 上一轮有线程因额度（`model_usage_exhausted`、quota）失败过的，本轮先建一个极简探测线程确认额度（标题 `额度探测`，任务只写「回复一句 ok 即可，不要做别的」，建在当前项目且不建工作树，避免占资源）：成功就把本轮档位定为 `glm-5.3-flash`，失败就降下一档并在报告里写明用的哪一档。探测线程用完当轮 settle（或归档），不留在候选里。
- 报告开头写一句本轮用的模型档位，下一轮据此决定要不要重新探测。

### 全局约定

- **消息前缀**：发出去的消息一律以 `【巡检】` 开头，下一轮靠这个前缀认出自己发过什么。`t3_thread_send` 带上该环境的 `environmentId`，`mode:"auto"`。
- **settle 只有这一个入口**：PR 已合并、`$pr-finish` 跑完，按 [references/handoff.md](references/handoff.md) 交接完再 settle。没有 PR 或 issue 的线程是用户自己开的，可能置顶停留，巡检不 settle、不归档，最多列进报告。
- **代用户行事**：线程自设的门槛（「等你明确收尾指令」「要不要合并」「请确认后我再继续」）不改变判定，这些答复由你按判定表代答。收敛就收尾、有依据就定案，结论用 `【巡检】` 发进线程让它执行；只写进报告不落地等于没做。
- **技能与任务提示词只读**：巡检的产出是消息、监听和线程状态。规则不顺手或提示词有缺漏，写进报告让用户改；要它改行为就发消息，不重写提示词。
- **超出原任务的授权**（合并别人的 PR、删数据、动生产环境、直推主分支）一律交回用户。

## 1. 收集快照

线程列表和线程内容的原始返回很大，直接调 MCP 工具读会塞满上下文。先跑快照脚本，它经 T3 MCP 的 HTTP 端点一次性收集所有环境，只输出判定要用的字段：

```bash
node <技能目录>/scripts/patrol-snapshot.mjs --self <本线程 id> > /tmp/t3-patrol-snapshot.json
```

- 输出结构的读法：
  - **候选**：`environments[].candidates`（已剔除子代理线程、首条消息是派活模板且没有工作树的执行线程、「代码审查 · PR #N」线程和本线程；剔除数量在 `delegatedExcluded`）。每条带 `link`、`status`、`prs`、`lastMsgAt`、最近 3 次 run、`pendingRequestCount`、`task`（首条用户消息）、`tail`（最后 4 条消息，保留首尾共 600 字——代理常在长汇报末尾才提问）。
  - **监听状态**：`prs` 里 open PR 标 `(unwatched)`；已挂监听但 review/评论时间晚于 `lastMsgAt` 标 `(stale)`；需代挂的列在 `needsWatchPrs`（`needsWatch` 为 true）。
  - **审查健康度**：`needsConvergenceAudit` 为 true 的列在 `convergenceAuditPrs`，带时长/轮次/当日 P0–P2 条数，直接当审计题头。github.com 的 PR 走 `gh`；其他宿主（Forgejo/Gitea，如 `fj.frp.musiver.cn`）自动改走 REST：宿主取 PR 自己的 URL，凭据取 `FORGEJO_BASE`/`FORGEJO_TOKEN`、`~/.agents/env/forgejo.sh` 或本机 git credential helper，都不用手配。
  - **核不到实况**：`prs` 标 `(health-unavailable)` 表示该 PR 的 gh 与 Forgejo 两条通道都失败。这时不要判「不打扰」：先用 `git credential fill` 确认宿主凭据可用，再按 Forgejo API（`GET /api/v1/repos/{owner}/{repo}/pulls/{n}`、`/reviews`、`/issues/{n}/comments`、`/commits/{sha}/statuses`）手工核一次；仍核不到就写进「需要你决定」，把 PR URL 和报错带上。
  - **空转迹象**（仅活跃状态 preparing/queued/starting/running/waiting）：`distinctRecentCommands`（最近 30 个工具调用里不同命令数）、`sampleCommand`、`minutesSinceLastMessage`。
  - **容量**：`activeTopLevel` 与 `occupying`（[references/handoff.md](references/handoff.md) 第 3 步用）。
  - **失败对账**：`failedTopLevel` 列出被候选过滤排除、但状态是 failed/interrupted/cancelled 的顶层线程。每轮逐个看——过滤规则一改就可能误杀真线程，静默消失比多算几条候选危险得多。
- 按环境分段用 `jq` 或 `read` 取这个文件。某个线程的 `tail` 不够判断时，再单独用 `t3_thread_read` 补读那一个线程（`afterPosition` 取 `itemCount - 60`，`limit` 10，`maxCharsPerItem` 1500）。
- 以往运行巡检的线程也会出现在候选里（标题含 t3-patrol 或巡检），判定时跳过。
- 脚本退出码 2 表示缺 `T3_MCP_URL`/`T3_MCP_BEARER_TOKEN`：改用 `t3_thread_list`（`allProjects:true`、`settled:false`，按 `nextCursor` 翻完）和上面的 `t3_thread_read` 参数手工取证，取到的每条只记判定要用的字段。

**完成标准**：每个可达环境的 `candidates` 数组都已取出并数过个数（判定表要覆盖数组里每一个线程；拿到空数组前先确认字段名没读错）；带 `error` 的环境或线程已用 MCP 工具补读或记进报告。

## 2. 写清每个线程在做什么

1. `pendingRequestCount` 大于 0 时，用 `t3_pending_request`（`action:"list"`，带 `threadId` 和 `environmentId`）读出待答问题。
2. 从 `task` 和 `tail` 里，用一句**具体的话**写清它在做什么：哪个 issue/PR、要解决什么问题（例如「PR #636：把 Android 的 test-hygiene 门禁对齐到桌面和 OHOS」）。只写「实施 Fast Ship 问题 157d51e8」这种话，用户没法判断。
3. 有 PR 且需要查实况时（包括所有「自称在等审查」的线程）：`gh pr view <N> --repo <owner/repo> --json headRefOid,reviews,comments,statusCheckRollup --jq '{head:.headRefOid, review:(.reviews|last|.submittedAt), comment:(.comments|last|.createdAt), checks:[.statusCheckRollup[]|.conclusion]|unique}'`，和线程最后一条消息比较。
4. **顺手命名**：标题是侧栏里的唯一识别入口，自动生成的标题（`/t3-orchestrator 1. 将以下问题标记为进行中…`、`Act as the review sub-agent…`）没被截断也只看得见半句话，等于没有标题。需要改的用 `t3_thread_update`（`action:"rename"`、`title`、`threadId`，带该环境的 `environmentId`）改成本轮第 2 点那句的压缩版，格式 `<标识> <主题>[-<段>]`，宽度 ≤ 20 个汉字（ASCII 算半个，侧栏才不会截断）：

   - 标识：有 open PR 用 `#<PR 号>`，无 PR 但有 issue 用 `INT-<号>`，都没有用类别词（`审查`、`巡检`、`调研`）。
   - 主题：3–10 字说清这件事，去掉 `feat(...)`/`fix(...)`、仓库名与「实施/处理」这类不载信息的词。
   - 段：同一需求拆到多端时加 `-Android`、`-Windows`、`-Swift`，否则同 issue 的几个线程在侧栏长得一模一样。

   例：`#685 歌词-Android`、`#683 INT-1378 验收`、`INT-1550 灌队取消守卫`、`审查 #653 R4`。只改三类：含 `/t3-orchestrator`、`Act as`、`## ` 或换行的原文堆砌；宽度超过 20 个汉字；标识过期（PR 已建但标题里没号、换了段）。已经是短标题且无这些痕迹的当作用户自己起的，不动。状态、轮次、模型名不进标题：它们每轮都变，会让标题抖动，还会刷新 `updatedAt` 干扰停滞判定。

**完成标准**：每个候选都写出了一句具体在做什么；需要命名的线程都已按格式改完标题。

## 3. 判定并行动

每个线程按下表**从上往下**取第一条命中的规则，一个线程只采取一个动作。

消息正文见 [references/messages.md](references/messages.md)（M1–M13），`M<n>` 即取那条模板照发；收尾交接见 [references/handoff.md](references/handoff.md)。

**先过 `failedTopLevel`**：里面的每条都按判定表「run failed」那行处理——有工作树、任务没做完的直接恢复继续，不因为它在候选之外就跳过。

**再做监听体检，它不在判定表里**：快照里 `needsWatch` 为 true 的线程一律直接 `watch_pull_request` 代挂（传 `threadId`、`environmentId`、`url`，取 `needsWatchPrs`），报告里记一行。代挂不改变线程状态，与判定表选的「不打扰」并存：线程收轮时撤监听是常态，缺监听几乎每轮都会出现，等它停到能判「空等」再补已经晚了一整轮。因此扫描时先看 `needsWatch`，再看 PR 结论时间。

| 现状 | 动作 |
| --- | --- |
| 发过收敛审计后，PR 描述仍没有「交付范围」一节，或仍在逐条修范围外意见 | 第一次发 `M1`；再次命中列进「需要你决定」 |
| `needsConvergenceAudit` 为 true，且本线程 24 小时内没收到过收敛审计 | 数字取 `convergenceAuditPrs`，再按文件/日期分布取证，发 `M2`，报告单列 |
| 正在运行但空转：`distinctRecentCommands` 小于 5，或 `minutesSinceLastMessage` 超过 60 | 先看重复命令在查什么（能查到就自己查），`t3_thread_interrupt` 后发 `M3` |
| 正在运行（有活跃 run），`minutesSinceLastMessage` 小于 30，且 `needsConvergenceAudit` 不为 true | 不打扰。久审不收敛的线程恰恰“看起来最健康”，会永远停在这一档，所以上一条异常必须先命中 |
| 上一条消息是 `【巡检】`，之后没有新的提交或实质进展 | 不再重复推，列进「需要你决定」并附卡点 |
| 空等：PR 仍 open、线程已停超过 30 分钟、最新 HEAD 上已没有在途的审查者和检查 | 按尾部分流，一律发消息：已收敛 → `M10`；问技术取舍或遗留项 → 对应行；仍有未处理的审查意见 → `M9` |
| run failed / interrupted / cancelled，或最新 run 停在 queued 超过 30 分钟 | 连续两个 failed，或报错是额度/上下文耗尽类 → 换档后发 `M4`；其余瞬时失败 → `M12`；换过模型仍失败列「需要你决定」 |
| 在等用户做产品决策（用户看得见的行为、文案、交互要改） | 先按规则找依据（跨端怎么拆、收敛纪律、仓库约定、同类先例），找得到就定案并发进线程执行；规则打架或全无先例才列「需要你决定」 |
| 在请求原任务已覆盖的授权（提交、推送、按模板建 PR、复审、重挂监听） | `M5` |
| 在问遗留项怎么办（flaky、范围外缺陷、要不要跟进） | `M6` |
| 在问技术取舍（方案、范围、修在哪个 PR、要不要结构整改） | `M7` |
| 说在等审查，但没关联这个 PR（`pullRequests` 为空或不含它） | 巡逻侧有 `watch_pull_request` 就直接代挂，再发 `M8`，PR 号从它最近的汇报里取 |
| 说在等审查或子任务，但 PR 在它最后一条消息之后已有新结论/CI，线程没被唤醒（`prs` 标 `(stale)`；或 `completed` 停着、尾部自称在等，`latestAt` 晚于 `lastMsgAt`） | `M9` |
| PR 已收敛：在等的审查者都通过、检查全绿，主代理在等合并；尾部出现「交还给你」「等你合并」、`ready for merge`、`converged`、收尾清单同样算；CONFLICTING 只是 main 前进的计数/文档冲突也按收敛处理 | `M10` |
| PR 已合并、`$pr-finish` 已跑完（尾部是收尾汇报，或后续消息里给过交接提示词） | 按 [references/handoff.md](references/handoff.md) 交接并 settle，每轮重新看容量；已合并的线程一律走这一行，不归入「已交付」 |
| 在等监听或子任务 | 核 PR 实况：有审查者在途（未出结论且触发未超 40 分钟，或检查还在跑）→ 不打扰；没有 → 按「停滞」处理 |
| 等某个审查者出结论，但触发已超 40 分钟仍无结果 | `M11` |
| 停滞：线程已停超过 30 分钟，最后一条消息在问你或在等回复 | 先套上面各行（收敛→收尾、问技术取舍→按根治推进、问授权→同意）；都不适用才列「需要你决定」 |
| 没有 PR 的线程，代理说已经做完 | 先核原任务的验收门槛：首条消息里写了次数、证据、PR、台账这类硬条件的逐条对上才算交付，漂亮的结论表不等于交了活；缺一条就按「停滞」推它继续并点明缺哪条，全满足才列进「已交付」 |

**每轮都按本轮快照重新判定**。上一轮的报告、已发过的提醒和 PR 描述只是线索：判定一个线程前先看本轮快照里它的 `tail` 和最近 run，事实以最新一条代理消息为准。比如上一轮发过收敛审计、本轮 PR 描述里已有交付范围，只能说明路径落地了，不能说明线程还在推进。

**停滞与新鲜度一律用 `lastMsgAt` / `minutesSinceLastMessage` / run 结束时间**：改名标题（`t3_thread_update`）和环境同步都会刷新 `updatedAt`，凭它判「刚有活动」会把刚被你命名的死线程当成活的。

**拿不准时**：先按「在等产品决策」那行找依据，有依据就定案并落地；只有规则冲突、或要改用户可见的行为又无先例可循，才交给用户。

**完成标准**：候选清单上每个线程都有一个判定和一个动作（「不打扰」也算），`needsWatch` 为 true 的都已代挂监听，`needsConvergenceAudit` 为 true 的都发了收敛审计（或已有审计在落地中），`failedTopLevel` 为空或每条都有了处理，发出的每条消息都已成功返回。

## 4. 汇报

在本线程按环境分组输出，每个线程一行（每行带上它所项目的仓库名，侧栏就是按仓库分的；候选计数只算用户任务线程，代理派活的执行线程不进计数，也不代表这台机器在跑什么）：

```
- <线程 link>｜<具体在做什么>｜<现状：推进中/卡住原因/已收敛>｜<本轮动作>
```

本轮新建的交接线程、等待空位的交接和 settle 掉的线程单列一节，写明交接自哪个线程、发到哪台设备；等待空位的补上目标环境当前在跑的线程数。已交付、等用户验收的一次性任务另列一节「已交付」，每条一行。本轮发了收敛审计提醒的线程另列一节「久审未收敛」，附上取证的数字和你的判断。

首次运行或环境有增减时，在报告开头附上环境对照表。

最后单列一节「需要你决定」：只放规则之间冲突、没有先例可循的产品决策、超出授权的动作、待确认的环境、交接目标定不下来的线程和重复推过仍不动的线程，每条写清楚需要用户回答什么。没有就写「无」。按规则定案的不进这一节，另起一节「已定案」逐条写：定的是什么、依据哪条规则、已发进哪个线程执行。环境不可达写一行带过；没有候选线程的环境写「<label>：0 个候选」，数量必须是从 `candidates` 数组数出来的，不是印象。
