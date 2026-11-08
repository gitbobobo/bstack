---
config: t3-dispatch.json
version: 1
---

# t3-dispatch 初始化

由 bstack-setup 调用，写 `t3-dispatch.json` 与派活模板。默认值见 [config.defaults.json](config.defaults.json)，键的含义见 SKILL.md 引用它们的段落。

## 0. 前提

- `environments.json` 已由 t3-patrol 初始化写好；设备容量池也在 t3-patrol 的配置里，这里不重复问。
- fast-ship 技能能读到 `~/.config/fast-ship/config.yaml`（缺失时按 fast-ship 技能「首次使用」配置）。

## 1. 可派活仓库

1. 跑 `node <t3-patrol 技能目录>/scripts/patrol-snapshot.mjs --capacity-only`，列出各环境 `projects` 的 `canonicalKey`，请用户选可派活的仓库。
2. 每个仓库问：
   - `source`：问题来源，目前只有 `fast-ship`。
   - `statuses`：准入的工作流状态，默认 `unset`（未设置）与 `todo`（待处理）。
   - `devices`：只派到哪些设备（environments.json 别名）；不写就是所有有该仓库项目的设备。
   - `template`：用哪份模板，默认 `default`。
   - `baseRef`：工作树从哪个分支起，默认 `main`；仓库默认分支不是 `main` 时要写。
3. Fast Ship 项目按代码主仓地址自动匹配。写完后跑 `node <技能目录>/scripts/issue-source.mjs list --repo <repo> --excerpt 0`：确认 `project` 是用户认的那个项目、候选数大致符合预期。匹配不到或匹配到多个时，按报错在该仓库条目里写 `project`。

## 2. 模板

先展示 [templates/default.md](templates/default.md)，问用户要不要换成自己的。用户给了就写到 `~/.config/bstack/templates/<名>.md`，正文必须含一行 `{{source_block}}`（来源附加块插在这里），斜杠命令放第一行。

## 3. 其他偏好

- **模型** `model`：派活线程用的 `instanceId`、`model`、`options`，整组替换。
- **运行模式** `runtimeMode`：默认 `full-access`。
- **节流** `limits`：每次最多派几个（`perRun`）、最近 24 小时最多派几个（`perDay`，缺省 0 即不限，并发只由各设备名额约束）、同一问题最多派几次（`maxAttempts`，线程没交付就结束时归还重派，到上限后交给用户）。
- **可信作者** `trustedUsers`：GitHub 导入的问题只有这些作者开的才派；默认为空，即不派 GitHub 导入的问题。
- **档位** `mode`：巡检调用时 `off` / `dry-run` / `auto`，先用 `dry-run`。用户当面要求派活不受它限制。

## 4. 写配置并试跑

1. 按 bstack-setup「写配置」规则写 `t3-dispatch.json`，跑 `node <技能目录>/scripts/dispatch-config.mjs`：退出码 0，`warnings` 为空。
2. 试跑：按 SKILL.md 走到第 2 步，只出计划不认领，交给用户过目。用户对挑选有异议时，把规则缺口记成「建议改技能」，或调整 `statuses`、`devices`。
