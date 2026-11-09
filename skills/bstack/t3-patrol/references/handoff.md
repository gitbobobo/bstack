# 收尾之后：交接与 settle

命中「PR 已合并、`$pr-finish` 已跑完」，或快照 `pendingHandoffs` 非空时读这一篇。

## 待交接队列

交接完成的界限是**目标线程实际接手**，容量不足只是阻塞状态。待办存于 `patrol-state.mjs` 的 `pendingHandoffs`，每轮由快照与摘要原样带出；来源候选带 `pendingHandoff` 时保持有事。队列独立于候选：来源被过滤、归档或目标不可达时，仍逐条复核并报告。

- **入账**：交接目标已确认后、容量判断前，用 `node <技能目录>/scripts/patrol-state.mjs handoff-put --file <UTF-8 JSON 文件>` 写入一项。字段：`sourceEnvironmentId`、`sourceThreadId`、`sourceLink`、`targetEnvironmentId`、`canonicalKey`（仓库身份）、`task`、`handoffRef`（可重读的收尾消息/提示词位置）、`waitingSince`（收尾时间，ISO 日期）、`blocker`（当前阻塞或待验证项）。以来源环境＋线程去重，更新保留最初等待时间。新建后补 `launchedThreadLink`，准备失败或未启动时保留它供查重。
- **每轮复核**：按 `waitingSince` 先后，读取目标设备及仓库池的本轮容量，再按下文第 2–5 步查重、建线与验收；已有建线先核其接手情况。来源没有新活动也照常复核，设备占用总数变化不作为前提。仍无空位则更新 `blocker`；有空位就交接。第 4 步动作释放空位后，派新问题前再核尚未接手的项。
- **销账**：目标实际接手，或来源明确撤销后续段时，用 `handoff-resolve --file <UTF-8 JSON 文件>`。文件含 `sourceEnvironmentId`、`sourceThreadId`、`outcome`（`accepted` / `cancelled`）、`evidenceRef`（实际接手活动或撤销原文位置）。launch 成功只是已建线，验收前保留队列与来源。
- **补旧账**：首次启用队列的快照自动全量（`triage.reason` 为「待交接队列首次对账」），从未 settle 的已合并来源核收尾与原任务，把未交接项入账；旧报告中的「等待空位」只作发现线索，核当前去向后再入账。

**完成标准**：每个队列项都有本轮目标容量与结果：仍阻塞、已建待接手，或有证据销账。状态文件写入/读取失败列阻塞，恢复前暂停新问题派活，保留待办证据。

## 有无交接

收尾汇报里可能带一段交接提示词（`$pr-finish` 第 6 步），交给下一段工作，例如跨端对齐的下一个平台。

交接项只看收尾汇报里「交接后续工作」那一项：`$pr-finish` 要求它给出交接提示词，或明确写「无后续段」。收尾前的过程消息、工具或页面的提示语不算交接项。

- 写了「无后续段」，且第 5 步核过任务书也没有后续段：没有交接。
- 这一项列了条目却没给提示词，或既没提示词也没写「无后续段」：先发 `M13`（见 [messages.md](messages.md)），下一轮再交接。写进 issue summary 只是登记了事项，不替代提示词；是不是后续段由来源线程自己答，不由巡检定性。来源线程回复只是遗留登记、不需要新线程，才算没有交接。

## 有提示词时按顺序处理

1. **定目标环境**：交接里写了设备名就直接用；只写技术栈（如「Android + Rust」）时，查来源仓库文档里的设备分工，换算成设备；交接没指定设备，仓库也没有设备分工，就留在来源线程所在的环境。设备按 [SKILL.md「0. 前提」](../SKILL.md#0-前提)的环境对照表找到环境。

   目标设备、环境或仓库项目未确认时，本轮不交接、来源线程先不 settle。先补核设备分工与环境项目；不可达列「阻塞」及恢复条件，需要用户辨认设备、指定仓库或决定「以后再安排」的时机才列「需要你决定」。

2. **查重**：在目标环境用 `t3_thread_search` 搜 PR 号和来源线程 id，已有线程接过这段工作就跳过新建。

3. **看容量**：读快照里目标环境的 `environments[].capacity`（下称「容量」；配置项写作 `config.capacity.*`）。巡检只管名额，磁盘与负载由新线程在重验证前自己查（t3-orchestrator「资源不足时」）。占用名额的是：有活跃 run 或有子代理在跑的顶层线程（含「代码审查 / 视觉审查 · PR #N」线程，不含子代理线程本身和探测线程；父线程派出子代理后自己会 completed，等子代理唤醒，工作树仍在用），以及 PR 仍 open、最近一次 run 在 `config.capacity.occupyWindowHours` 内结束的线程——等审查的线程在两轮之间会暂时 completed，但工作树和编译资源还占着。PR 已合并或关闭（工作树已回收）、没有 PR 又没在跑的线程不占名额，所以来源线程本身通常不算。

   - **设备总数**：容量的 `used` / `max`，占用者在 `occupying`。上限取该设备在 `config.capacity.devices` 里的 `maxActiveThreads`；没写时是各池 `max` 之和（各池可以同时用满）；设备没配池时用 `config.capacity.maxActiveThreads`。
   - **仓库池**：在 `config.capacity.devices` 里配置过的设备还按仓库分池（容量的 `pools`，每个占用线程只进第一个匹配的池，审查线程不占池）。
   - **两道闸**：容量带 `blocked` 时这台设备一律不建——本机磁盘（快照实测 `disk.freeGB`）低于 `config.capacity.minFreeDiskGB`，或设备上有线程停在 `【等待资源】`。
   - **可建数**：目标仓库的 `canonicalKey` 在容量的 `freeByRepo` 里查，它已是设备空位与所属池空位的较小值，被闸住时为 0；项目没有仓库身份时用 `freeOther`。容量带 `projectsError` 时池归类不可信，只按设备总数判断，并在「例行复核」记一笔。

   可建数为 0 就本轮不建，在队列的 `blocker` 写明卡在设备总数、哪个池还是哪道闸，并报告「等待空位」；来源线程先不 settle，后续每轮由队列重新检查。空位先给等待中的交接；同一环境有多个交接在等时，按来源线程收尾的先后顺序建，每建一个从对应设备与池的空位里减一，建到为 0 为止。

4. **新建线程**（前提：第 3 步写出了目标环境的容量占用与目标仓库的可建数，且可建数大于 0）：

   - `t3_thread_launch` 带上目标环境的 `environmentId`；
   - `projectId` 取目标环境里同一仓库的项目（`t3_thread_list` 找同仓库的近期线程，用它的 `projectId`）；
   - `modelSelection` 按 [故障恢复「模型优先级」](recovery.md#模型优先级) 判定，从本轮 modelLadder 取 instanceId/model/options；按 t3_thread_launch 当前参数格式转换 options，不在此另存模型参数；
   - `workspaceStrategy` 取 `{type:"worktree", baseRef:<仓库默认分支>, startFromOrigin:true}`；
   - 标题按 [naming.md](naming.md) 的格式，用该项目以往标题的语言和写法；
   - `message` 原样贴交接提示词，开头如有斜杠命令就保持在第一行，末尾另起一行写 `> 交接自 <来源线程 link>`。

   交接写的是多段接力（如「先发 A 设备，合并后换新 PR 号再发 B 设备」），本轮只建第一段，并在 message 末尾再加一行 `> 后续：合并后按同一提示词换新 PR 号交接给 <下一台设备>`，让新线程收尾时给出下一段的交接。

5. **settle 前确认没有后续段**，再 settle：两处都要看过——收尾汇报，和**原任务首条消息 / 关联 issue**。「跨端」「其他端」「后续平台」「再发 Windows 段」这类分工常常只写在任务书里，收尾汇报不一定重复；只看汇报就 settle，会把「这条还差一段」一起关掉，空窗期没人接手（INT-1280 周三段只做了 Mac mini 段，settle 后断了 14.9 小时）。

   任务书里有没做完的后续段、而汇报没给提示词：按 `M13` 先问，来源线程本轮不 settle。两处都确认没有后续段、或交接线程已实际接手，才用 `t3_thread_organize`（`action:"settle"`，带来源环境的 `environmentId`）。实际接手按 [工作树准备失败](recovery.md#工作树准备失败) 的完成标准验收；launch 返回成功仅记已建线，准备失败或排队未启动时保留来源。

   收尾汇报里提到的遗留事项照抄进报告，并写明各自去向（登记文档、新建 issue 链接、交接线程）；汇报列了条目但去向里没有新线程、也没先问过提示词的，不算已有去向——按上面「缺提示词」先发给来源线程，来源线程本轮不 settle。
