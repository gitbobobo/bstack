---
name: t3-dispatch
description: 从问题来源挑问题，在各 T3 环境建工作树线程派活。用户要求给某台设备分配任务、巡检派活时使用。
---

# T3 派活

派活分两段，中间隔着一个**题库**（`~/.config/bstack/state/t3-dispatch-candidates.json`，每仓库按顺序排好的已研判题目）：

- **补货**：题库低于目标库存（可派设备所属池名额之和 × `stock.multiplier`）时，每个缺货仓库派一个补货子代理挑题入库。
- **出队**：有空位时按题库顺序弹出题目、复核来源后建线，不再现场挑题。

下文 `<技能目录>` 指本技能目录，`<t3-patrol>` 指同级的 t3-patrol 技能目录；容量计数沿用 t3-patrol。派活只看名额，磁盘与内存由新线程在重验证前自己查（t3-orchestrator「资源不足时」）。

## 1. 前提

1. `node <技能目录>/scripts/dispatch-config.mjs`：`errors` 非空就停下，把路径与报错交给用户；`warnings` 写进报告；`repos` 为空时请用户先经 bstack-setup 配置（[setup.md](references/setup.md)）。
2. **档位**：巡检调用按 `mode`（`off` 不派、`dry-run` 只出计划、`auto` 执行），`~/.config/bstack/PAUSE` 存在时不派，脚本自动判。用户当面要求派活（如「给 pc 再分两个任务」）就是授权，出队加 `--user`，按用户给的设备与数量执行。

### 派活模型

默认用配置的 `model`。巡检调用沿用本轮档位（`--model-tier`）；独立调用时额度失败按 [t3-patrol 故障恢复「模型优先级」](../t3-patrol/references/recovery.md#模型优先级) 判档。仅剩 `fallback` 档或普通档均已证实不可用时暂停新问题，只做恢复；单个默认模型额度不足本身不足以停派。用户或项目明确指定模型时以其为准。

## 2. 补货

巡检的 `patrol-round start` 已代跑这一步并给出切片路径。独立调用时：

```bash
node <t3-patrol>/scripts/patrol-snapshot.mjs --capacity-only > /tmp/t3-dispatch-capacity.json
node <技能目录>/scripts/dispatch-plan.mjs --capacity /tmp/t3-dispatch-capacity.json --brief-dir /tmp/t3-dispatch-briefs > /tmp/t3-dispatch-plan.json
```

`refill` 是各仓库的目标、库存与缺口；`briefs` 给每个缺货仓库一份切片。每份切片并行派一个补货子代理（`delegate_task`，`role:"research"`，`mode:"async"`），任务书：`派活补货：按 <技能目录>/references/refill.md 处理 <brief>。不再派子代理。` 子代理自己写题库，不需要你合并。

**完成标准**：每个缺货仓库都有 taskId，或写明启动失败的原因。

## 3. 出队

```bash
node <t3-patrol>/scripts/patrol-snapshot.mjs --capacity-only > /tmp/t3-dispatch-capacity.json
node <技能目录>/scripts/dispatch-queue.mjs --capacity /tmp/t3-dispatch-capacity.json [--model-tier <name>] [--user] > /tmp/t3-dispatch-queue.json
```

脚本先给待交接建线，再各仓库轮流弹出题目，按快照实际空位与 `limits.perRun`、`limits.perDay` 余量封顶；每条派出都经绑定身份核验、跨环境查重、认领、渲染模板、建工作树线程、记账与回读。用户点名具体问题时，改写计划文件直接跑 `dispatch-launch.mjs --plan <文件>`（格式见脚本头注释）。

### 出队结果

- `launched[].pending`：工作树还在准备，认领与台账已保留，算派出成功，下一轮巡检核对。
- `launched[].duplicate`：已有未结线程，题目已移出题库，报告附该线程 link。
- `launched[].error`：身份核验或查重失败时未认领；主问题认领失败说明已被认领。建线失败或 run 已失败时脚本已归还认领（见 `released`），题目留在题库；代理额度失败按「派活模型」换档，已建线程按 t3-patrol 故障恢复续跑，恢复后对归还的问题重新认领并 `record` 到原线程。建线请求报错且无法确认是否已创建时，先按编号查重。
- `dropped`：来源已关闭、出了 PR、离开准入或加了暂缓，已移出题库；`recheck`：来源有更新，已改回待核等下次补货。
- `idle`：还有空位但题库没有适配题目，按第 2 步补货。

**完成标准**：每条交接与派出都有 link 与回读状态，或 error 与归还情况；额度失败项已补救一次或记了无法补救的证据。

## 4. 报告

- **本轮派活**：所用模型与依据；每条写问题编号、标题、设备、线程 link 与推荐理由。`dry-run` 标明「未执行」。
- **题库**：各仓库库存/目标、本轮移出与转重核数，补货任务的 taskId。
- **空位**：按设备的重型/通用池写余位与去向（派出、交接占用、题库无适配题目）。
- **待办**：归还失败、准备失败的线程、配置警告、题库读写失败。
