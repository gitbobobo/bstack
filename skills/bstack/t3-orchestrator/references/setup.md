---
config: t3-orchestrator.json
version: 1
---

# t3-orchestrator 初始化

由 bstack-setup 调用，写 `t3-orchestrator.json`：本机可用的 harness 与模型、各任务类型的候选顺序。默认值是 [scripts/route-data.mjs](../scripts/route-data.mjs)，加载与校验规则见 [scripts/route-config.mjs](../scripts/route-config.mjs) 文件头。

## 1. 看现状

1. 调 `orchestrator_capabilities`，把返回的 JSON 存到 `/tmp/t3-caps.json`。
2. 跑 `node <技能目录>/scripts/route.mjs audit --caps-file /tmp/t3-caps.json` 和 `route.mjs table`。
3. 向用户说明：默认路由里哪些入口在本机不可用（audit 的 PROBLEM），以及各任务类型当前的候选顺序。

## 2. 询问偏好

每项先说默认值，用户说「默认」就跳过：

- **模型状态** `models.<key>.status`：`auto` 进自动调度；`advisor` 只做审查与实现顾问；`named` 仅点名时用。
- **任务限定** `models.<key>.tasks`：模型只进这些任务类型（`general` / `design` / `review`）。
- **入口** `models.<key>.entries`：该模型可走哪些 harness，数组顺序就是 harness 优先级，整组替换。每项 `{ provider, id, options }`，`provider` 与 `id` 从 capabilities 里取，`options` 至少带一个档位选项（见 [models.md](models.md)「选项与档位」）。
- **新增模型**：新 key 须带 `label`、`status`、`entries`，可选 `tasks`、`vision`（视觉分数，缺省 0）。
- **候选顺序** `routes.<task>`：`{ model, provider }` 组合的尝试顺序，整行替换；行里没列的可调度模型会自动补在末尾。
- **换路上限** `maxAttempts`。

用户的 harness 与默认一致时，这一步通常什么都不用写。

## 3. 写入与验证

1. 按 bstack-setup「写配置」规则写 `t3-orchestrator.json`。
2. 跑 `route.mjs table`：首行是配置文件路径，且没有 `WARN 配置` 行。
3. 跑 `route.mjs audit --caps-file /tmp/t3-caps.json`：没有 PROBLEM，或剩下的 PROBLEM 都是用户确认可接受的。
4. 对 `general`、`design`、`review` 各跑一次 `route.mjs select --task <task> --caps-file /tmp/t3-caps.json`，把 PICK 给用户确认。

**完成标准**：三个任务类型的 PICK 都是用户认可的入口；table 无配置警告。
