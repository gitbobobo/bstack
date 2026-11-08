# 收尾之后：交接与 settle

判定表命中「PR 已合并、`$pr-finish` 已跑完」时读这一篇。其余轮次用不到。

## 有无交接

收尾汇报里可能带一段交接提示词（`$pr-finish` 第 6 步），交给下一段工作，例如跨端对齐的下一个平台。

交接项只看收尾汇报里「交接后续工作」那一项：`$pr-finish` 要求它给出交接提示词，或明确写「无后续段」。收尾前的过程消息、工具或页面的提示语不算交接项。

- 写了「无后续段」，且第 5 步核过任务书也没有后续段：没有交接。
- 这一项列了条目却没给提示词，或既没提示词也没写「无后续段」：先发 `M13`（见 [messages.md](messages.md)），下一轮再交接。写进 issue summary 只是登记了事项，不替代提示词；是不是后续段由来源线程自己答，不由巡检定性。来源线程回复只是遗留登记、不需要新线程，才算没有交接。

## 有提示词时按顺序处理

1. **定目标环境**：交接里写了设备名就直接用；只写技术栈（如「Android + Rust」）时，查来源仓库文档里的设备分工，换算成设备；交接没指定设备，仓库也没有设备分工，就留在来源线程所在的环境。设备按 [SKILL.md「0. 前提」](../SKILL.md#0-前提)的环境对照表找到环境。

   目标设备、环境或仓库项目未确认时，本轮不交接、来源线程先不 settle。先补核设备分工与环境项目；不可达列「阻塞」及恢复条件，需要用户辨认设备、指定仓库或决定「以后再安排」的时机才列「需要你决定」。

2. **查重**：在目标环境用 `t3_thread_search` 搜 PR 号和来源线程 id，已有线程接过这段工作就跳过新建。

3. **看容量**：读快照里目标环境的 `environments[].capacity`（下称「容量」；配置项写作 `config.capacity.*`）。名额按占用线程算；磁盘本机由快照实测，远程环境要先做[资源探测](#资源探测)。占用名额的是：有活跃 run 或有子代理在跑的顶层线程（含「代码审查 / 视觉审查 · PR #N」线程，不含子代理线程本身和探测线程；父线程派出子代理后自己会 completed，等子代理唤醒，工作树仍在用），以及 PR 仍 open、最近一次 run 在 `config.capacity.occupyWindowHours`（2 小时）内结束的线程——等审查的线程在两轮之间会暂时 completed，但工作树和编译资源还占着。PR 已合并或关闭（工作树已回收）、没有 PR 又没在跑的线程不占名额，所以来源线程本身通常不算。

   - **设备总数**：容量的 `used` / `max`，占用者在 `occupying`。上限取该设备在 `config.capacity.devices` 里的 `maxActiveThreads`；没写时是各池 `max` 之和（各池可以同时用满）；设备没配池时用 `config.capacity.maxActiveThreads`（5 个）。
   - **仓库池**：在 `config.capacity.devices` 里配置过的设备还按仓库分池（容量的 `pools`，每个占用线程只进第一个匹配的池，审查线程不占池）。
   - **磁盘**：容量的 `disk`。`freeGB` 是工作树所在盘的剩余空间；`growing` 是 `config.capacity.growthWindowHours`（2 小时）内新建、多半还在构建的线程，`reserveGB` 按它们所在池的 `footprintGB`（缺省 `config.capacity.defaultFootprintGB`，5 GB）给它们预留；`spareGB` = 剩余 − `config.capacity.minFreeDiskGB`（20 GB）− 预留。远程环境的 `freeGB` 为 null，本轮要往那里建线程时先做资源探测，再重算容量。
   - **可建数**：目标仓库的 `canonicalKey` 在容量的 `freeByRepo` 里查，它已是设备空位、所属池空位与磁盘可容纳数（`spareGB` 除以池的 `footprintGB`）三者的最小值；项目没有仓库身份时用 `freeOther`。`disk.freeGB` 为 null 时它只反映名额，不能直接用来建线程。容量带 `projectsError` 时池归类不可信，只按设备总数判断，并在「例行复核」记一笔。
   - **磁盘不够时回收**：可建数被磁盘卡成 0、而名额还有空时，在该环境做一次带回收的资源探测（本机直接跑 `node <技能目录>/scripts/env-probe.mjs --reclaim`），按回收后的剩余空间重算。回收只删已终结线程留下的孤儿工作树，以及保留工作树里可重建的构建产物，判定交给 t3-code 技能的 `t3-worktree-gc.mjs`。每个环境每轮最多回收一次。
   - **自主判断**：这些数字是上限，不是指标。快照或探测显示某台设备上的线程比 `footprintGB` 预估的大（例如剩余空间一轮内掉得很快），或机器上有用户手动开的大构建，可以少建并在报告里写原因；不能多于可建数。

   可建数为 0 就本轮不建，把这次交接记成「等待空位」并写明卡在设备总数、哪个池还是磁盘：来源线程先不 settle，下一轮重新检查。空位先给等待中的交接；同一环境有多个交接在等时，按来源线程收尾的先后顺序建，每建一个从对应设备与池的空位里减一、从 `spareGB` 里减去该池的 `footprintGB`，建到为 0 为止。

4. **新建线程**（前提：第 3 步写出了目标环境的容量占用、磁盘剩余与目标仓库的可建数，且可建数大于 0）：

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

## 资源探测

远程环境的磁盘只能派线程去量。一轮里每个环境最多探测一次（含回收的那次）；用 `delegate_task`：

- `mode:"wait"`，`timeoutMs` 300000，`title:"资源探测"`，`role:"research"`；
- `target` 带该环境的 `environmentId`、该环境任一项目的 `projectId`（`t3_project_list`），模型取本轮 modelLadder 首档，思考档位放到最低；
- `task` 原样用下面的文字，要回收时把第 1 步的命令换成带 `--reclaim` 的：

```
资源探测：不提交，不改动任何文件（命令带 --reclaim 时由脚本自己回收，你不另删东西）。
1. 执行 `node "$HOME/.agents/skills/t3-patrol/scripts/env-probe.mjs"`，把输出的 JSON 原样作为回复。
2. 这个脚本不存在时不要回收，改量 ~/.t3/worktrees（不存在就量主目录）所在的磁盘：POSIX 跑 `df -Pk <目录>`，Windows 用 PowerShell 跑 `Get-PSDrive -PSProvider FileSystem`；回复一行 JSON：{"source":"fallback","path":"<目录>","raw":"<命令输出的表头和数据行>"}。
回复只含 JSON，不加解释。
```

拿到回复后：

1. 取剩余空间：env-probe 的 `diskFreeGB`；回退结果自己从 `raw` 换算（`df -Pk` 的 Available 列是 KB，乘 1024 再除以 10⁹；`Get-PSDrive` 的 Free 是字节）。
2. 重算：`node <技能目录>/scripts/patrol-capacity.mjs --snapshot <快照文件> --env <environmentId> --disk-free <GB>`，输出的 `freeByRepo` 取代快照里的值。
3. 回收结果在 `reclaim`：`freedGB` 是腾出的空间，`summary` 是 t3-worktree-gc 的汇总行，`failed` 列出删除失败的目录。`ok` 为 false 时把 `error` 或 `failed` 写进「阻塞」。
4. 用 `t3_thread_organize`（`action:"settle"`，带 `remoteChild.environmentId` 与 `remoteChild.threadId`）settle 探测线程。

探测超时、失败或回复不是 JSON：该环境本轮不新建，交接记「等待空位」，原因写「磁盘未知」，并把探测线程的 link 写进「阻塞」。
