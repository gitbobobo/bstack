---
config: t3-orchestrator.json
version: 2
---

# t3-orchestrator 初始化

由 bstack-setup 调用，写 `t3-orchestrator.json`：本机的两类模型池与各模型入口。默认值是 [scripts/route-data.mjs](../scripts/route-data.mjs)，加载与校验规则见 [scripts/route-config.mjs](../scripts/route-config.mjs) 文件头。

## 1. 看现状

1. 调 `orchestrator_capabilities`，把返回的 JSON 存到 `/tmp/t3-caps.json`。
2. 跑 `node <技能目录>/scripts/route.mjs audit --caps-file /tmp/t3-caps.json` 和 `route.mjs table`。
3. 向用户说明：默认入口里哪些在本机不可用（audit 的 PROBLEM），以及两类池当前的模型与档位。旧版（version 1）配置里的 `routes`、`status`、`tasks`、`vision` 已废弃，按本文重新询问后整份重写。

## 2. 询问偏好

每项先说默认值，用户说「默认」就跳过：

- **实现池** `implementers` / **顾问池** `advisors`：`MODELS` 的 key，顺序即优先级，整组替换；同一模型不能两边都在。不在两池里的模型只在用户点名时用。
- **入口** `models.<key>.entries`：该模型可走哪些 harness，顺序即 harness 优先级，整组替换。每项 `{ provider, id, options? }`，`provider` 与 `id` 从 capabilities 取；`options` 只放档位以外的附加选项。
- **档位** `models.<key>.effort`：该模型固定的思考强度。
- **新增模型**：新 key 须带 `label`、`effort`、`entries`。
- **换路上限** `maxAttempts`。

用户的 harness 与默认一致时，这一步通常什么都不用写。

## 3. 写入与验证

1. 按 bstack-setup「写配置」规则写 `t3-orchestrator.json`。
2. 跑 `route.mjs table`：首行是配置文件路径，且没有 `WARN 配置` 行。
3. 跑 `route.mjs audit --caps-file /tmp/t3-caps.json`：没有 PROBLEM，或剩下的都是用户确认可接受的。
4. 跑 `route.mjs impl --caps-file /tmp/t3-caps.json` 与 `route.mjs advisor --caps-file /tmp/t3-caps.json`，把 PICK 给用户确认。

**完成标准**：impl 与 advisor 的 PICK 都是用户认可的入口；table 无配置警告。
