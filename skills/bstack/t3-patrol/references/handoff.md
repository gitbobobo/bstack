# 收尾之后：交接与 settle

命中「PR 已合并、`$pr-finish` 已跑完」、线程带 `pendingHandoff`，或输入条目是 `handoff` 时读这一篇。

## 待交接队列

交接完成的界限是**目标线程实际接手**。队列存在巡检状态文件的 `pendingHandoffs`，按来源环境＋线程去重；空位与建线由 dispatch-queue 负责：带 `launch` 的项在目标设备同池有空位时建线并回写 `launchedThreadLink`，没空位的项占住该池、同池不派新问题。研判只管入账、验收与销账。

- **入账**：决定交接后在研判结果写 `handoff`，字段：`sourceEnvironmentId`、`sourceThreadId`、`sourceLink`、`targetEnvironmentId`、`canonicalKey`（仓库身份）、`task`、`handoffRef`（可重读的收尾消息或提示词位置）、`waitingSince`（收尾时间，ISO）、`blocker`（当前阻塞或待验证项）、`launch: { projectId, title, message }`（按下文「有提示词时」写好）。更新已有项时原样带上 `launchedThreadLink`，最初的 `waitingSince` 自动保留。
- **每轮复核**：来源无派出归属时只报告「非巡检派出，暂停自动交接」。已建线的项读目标线程：实际接手（run 在目标工作树里有任务活动）就写 `handoffResolve` 并 settle 来源；准备失败或排队未启动按 [工作树准备失败](recovery.md#工作树准备失败) 处理，保留队列。未建线的项核 `blocker` 是否仍成立，缺 `launch` 就补齐。
- **销账**：`handoffResolve: { sourceEnvironmentId, sourceThreadId, outcome: "accepted" | "cancelled", evidenceRef }`，`evidenceRef` 指实际接手活动或来源撤销后续段的原文位置。launch 成功只是已建线，接手前保留。

**完成标准**：每个队列项都有本轮结果：仍阻塞（写明阻塞）、已建待接手，或有证据销账。

## 交付关联核对

本轮读到 PR 合并或收尾汇报、线程却没有 PR 关联时，先从原任务与汇报核对 PR URL、仓库及归属，加 `link_pull_request` 调用恢复关联，再核验收、交接与 settle；证据不够则保留线程并列缺口。标题含 PR 号只作线索。

## 有无交接

只看收尾汇报里「交接后续工作」那一项：`$pr-finish` 要求它给出交接提示词，或明确写「无后续段」。

- **按任务归属分流**：原需求明确必交的后续段入队；审查遗留、架构或体验等独立建议交 t3-dispatch 准入评估，不占交接队列。
- 写了「无后续段」，且任务书也没有后续段：没有交接。
- 列了条目但未区分必交与独立建议，或没写有无后续段：发消息请来源按原任务区分，必交段给完整交接提示词、来源依据及目标设备，否则写「无后续段」；来源本轮不 settle。

## 有提示词时

1. **定目标环境**：交接写了设备名就用；只写技术栈时查来源仓库文档的设备分工换算成设备；都没有就留在来源环境。设备不确定时本轮不交接、来源不 settle，需要用户辨认设备时写 `needsUser`。
2. **查重**：在目标环境用 `t3_thread_search` 搜 PR 号和来源线程 id，已有线程接过这段就不入账，直接验收它。
3. **写 `launch`**：
   - `projectId`：目标环境 `t3_project_list`（翻完分页）里 `repositoryIdentity.canonicalKey` 与来源仓库一致的项目；
   - `title`：按 [命名](naming.md)，用该项目以往标题的语言和写法；
   - `message`：原样贴交接提示词，开头的斜杠命令保持在第一行，末尾另起一行写 `> 交接自 <来源线程 link>`。多段接力（先 A 设备、合并后换新 PR 号再 B 设备）只建第一段，末尾再加 `> 后续：合并后按同一提示词换新 PR 号交接给 <下一台设备>`。
4. **settle 前确认没有后续段**：收尾汇报和**原任务首条消息 / 关联 issue** 两处都要看过。「跨端」「其他端」「后续平台」这类分工常只写在任务书里（INT-1280 只做了 Mac mini 段就 settle，断了 14.9 小时）。任务书有未做的后续段而汇报没给提示词，按上节请来源补；两处都确认没有后续段、或交接目标已实际接手，才加 `t3_thread_organize`（`action:"settle"`）调用。

收尾汇报里的遗留事项写进 `summary`，注明归属与去向（独立候选、用户撤销依据或必交段接手线程）。
