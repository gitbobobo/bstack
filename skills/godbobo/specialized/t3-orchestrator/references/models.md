# 模型参考

调研日期：2026-10-11；harness 收敛为 pi / codex / droid：2026-10-27；2026-11-04 cliproxyapi 的 devin 订阅移除，devin harness 回归，swe-2/opus 改走 devin（用户定）。模型 ID 以 `orchestrator_capabilities` 实时返回为准，这里的 ID 只是当时的快照。更新方法见文末「更新来源与标准」。

基准说明：FrontierCode（Cognition 维护，按代码能否合并评分）和 CursorBench 是第三方统一 harness 的榜单；Terminal-Bench、DeepSWE 多为厂商自报，不同版本不能横比。

## harness

| 实例 | 用途 | 说明 |
|---|---|---|
| `pi` | glm/deepseek/grok/gpt 系的首选入口 | 经 cliproxyapi（`~/.pi/agent/cliproxyapi.json`）调多个提供商，额度与渠道切换由 cliproxyapi 负责；模型 ID 形如 `cliproxyapi/<模型>`。2026-11-04 起 devin 订阅已移除，不再提供 opus/swe-2。pi 目录里的 `opencode-go/*`、`commandcode/*`、`opendesign/*` 不走 cliproxyapi，不进路由 |
| `codex` | gpt-6.1-sol 的备用入口 | 仅跑 GPT；也经 cliproxyapi 向 pi 提供 gpt-6.1-sol |
| `acpRegistry_devin` | swe-2 与 opus 的主入口（用户定） | 模型 ID 自带档位后缀（`swe-2-high`、`claude-opus-5-5-medium`）；另有 `gpt-6-1-sol-medium` 可人工点名，不进自动路由 |
| `acpRegistry_factory_droid` | 其余模型的备用入口 | 目录没有 SWE-2。需 droid ≥0.234.0（修复 acp-daemon `--mcp-servers`，[Factory-AI/factory#9](https://github.com/Factory-AI/factory/issues/9)） |

## 模型画像

状态：**自动** = 可以自动选；**顾问** = 自动用于审查和咨询，不承担写代码的实现任务；**点名** = 只有用户点名才用；**不用** = 不在 `MODELS`（白名单外），`check` 按「不在入口清单」拦。

| 模型 | 状态 | 定位 | 关键数据 | 擅长 | 短板 |
|---|---|---|---|---|---|
| Opus 5.5 | 顾问（仅实现顾问） | 前沿，综合第一 | FrontierCode 第 1（medium 54.6%，$0.80）；CursorBench high 56.0% | 方案咨询、视觉判断、长时程规划意见 | 不写实现；不做代码审查与安全复核，只走 `--task design`（用户定，`tasks: ["design"]`）；安全、生物、ML kernel 类任务会被静默回退到旧模型 |
| GPT-6.1 Sol | 顾问 | 审查与咨询主力 | FrontierCode medium 50.2%，$0.36，性价比最高 | 审查（首选）、方案咨询、调试思路 | 不写实现；输出比 6 Sol 多 10–30% |
| SWE-2 | 自动 | 接近前沿，便宜 | FrontierCode max 50.0%（$1.18） | 端到端测试覆盖；被质疑时会重新推导；探索聚焦；基于 Kimi K3，原生看图 | 多小时级终端长任务弱于 Opus；无官方视觉数据 |
| Grok 4.7 | 顾问 | 前沿，长任务 | FrontierCode high 47.6%（$6.65）；CursorBench xhigh 46.3% | 审查（用户实测适合）、长时程任务、自我验证、文档类知识工作 | 慢（小任务均 177s，Opus 34s），输出 token 约 4.5 倍；UI 口碑一般；500k 上下文双倍价 |
| GLM 5.3 Flash | 自动，低难度优先 | 便宜 | CursorBench max 36.8%，$0.39 | 低难度、批量；原生多模态，能看截图 | 能力有上限 |
| DeepSeek V4.1 Flash | 自动 | 便宜、快 | Artificial Analysis MMMU-Pro 77% | general 行尾备选；原生多模态 | 视觉弱于 GLM 5.3 Flash 与 SWE-2 |
| GLM 5.3（非 flash） | 不用 | 开源旗舰 | FrontierCode max 40.1%，但 $16.91 | 安全 | 没有视觉能力；max 档 token 极多 |
| Composer 2.5 | 不用 | 便宜、快 | FrontierCode 25.6% | — | 已过时 |
| MiniMax-M3 | 不用 | 便宜 | FrontierCode 14.7% | — | 能力太差 |
| 其他旧模型 | 不用 | — | — | — | glm-5.2、gpt-6-sol、gpt-5.6 系列、gemini flash 系列（步数极多）；grok-4.6、claude-sonnet-5-5、gpt-6-luna、gpt-6-astra、claude-fable-5-1、kimi-k3（2026-10-18 用户移出路由） |

## 路由规则在哪里

路由数据（模型状态与入口、ROUTES 组合优先级行、白名单递补）的唯一事实源是 `scripts/route-data.mjs`，结构见其文件头；`route.mjs table` 查看当前生效数据。画像表「状态」列对应 `MODELS.status`：自动 → `auto`、顾问 → `advisor`、点名 → `named`；「不用」即不写进 `MODELS`。括注的任务限定（如「仅实现顾问」）对应 `MODELS.tasks`。

## 选项与档位

各 harness 的思考档选项名不同（2026-10-27 按实时目录核对）：

| harness | 选项名 | 备注 |
|---|---|---|
| pi | `thinking` | 取值集随模型而异（glm/deepseek 只到 high） |
| codex | `reasoningEffort` | 另有 `serviceTier`，保持 default 不用 priority |
| devin | `thought_level` | 取值 medium/high/max；另有 `mode`、`speed`，保持默认不设 |
| droid | `reasoning_effort` | snake_case；另有必传的 `autonomy_level`（调度一律 auto-high） |

档位取值规则（用户定）：**主代理派发默认 `high`；Opus 5.5、GPT-6.1 Sol、Grok 4.7 用 `medium`**（`route-data.mjs` 的 `EFFORT_MEDIUM_MODELS`）。droid 的 `reasoning_effort` 没有 medium，这三个模型的 droid 入口仍用 `high`。每个入口显式声明一个档位选项，由 `route.test.mjs` 校验。

`fastMode` 不写进路由数据：`route.mjs` 只在目录规格里确实存在该选项时自动注入 `fastMode:false`。

### 持续校验：`route.mjs audit`

```bash
node scripts/route.mjs audit --caps-file /tmp/t3-caps.json   # 有问题逐条打印并 exit 1
```

审计 `route-data.mjs` 全部 entries 与 ROUTES 候选的合并 options：provider/模型在目录里、选项名存在、取值在生效集内。`check --caps-file` 对手工拼的组合做同样的取值校验；select 时对注入后的最终 options 也跑一遍，非法入口直接进 skipped。

测试用的裁剪夹具 `scripts/fixtures/caps-trimmed.json` 只含 route-data 用到的 provider/模型/选项。目录变化后重新生成：取实时 `orchestrator_capabilities` 落盘，按 `route-data.mjs` 里 entries 的 provider/模型 id 过滤 providers 与 models（保留模型完整选项描述），并把 `canRunChildTask`/`canRunCrossProviderChildTask` 归一化为 true、`constraints` 清空后写回该文件。

## 更新来源与标准

### 来源

| 用途 | 来源 |
|---|---|
| 实际可用的模型 ID 与选项 | `orchestrator_capabilities`；cliproxyapi 可用模型另见 `~/.pi/agent/cliproxyapi-models.json`（`stale:false` 的条目） |
| 第三方统一榜（排序主依据） | FrontierCode：https://cognition.com/frontiercode；CursorBench：https://cursor.com/cursorbench |
| 视觉分数（`MODELS.vision`） | Roboflow Vision Evals 总分：https://playground.roboflow.com/evals；榜上缺的模型按 MMMU-Pro（Vals、Artificial Analysis）估值并在 `route-data.mjs` 注明 |
| 厂商发布与系统卡 | OpenAI https://openai.com/news 与 https://deploymentsafety.openai.com；Anthropic https://www.anthropic.com/news；xAI https://x.ai/news；Cognition https://cognition.com/blog；智谱 https://docs.z.ai |
| 价格 | Codex https://help.openai.com（搜 Codex usage limits）；Factory https://factory.ai/pricing |
| 本机实际表现 | `~/.t3/userdata/statev2.sqlite`，必须以只读方式打开（`sqlite3 "file:...?mode=ro"`），统计 `projection_thread_activities` 中 `runtime.error` 的按 provider 分布 |

### 标准

1. **只有用户能改的规则**：快速模式、点名专用（`status:"named"`）、harness 分工（glm/deepseek/grok/gpt 系首选 pi；swe-2 只走 devin、opus 走 devin/droid，均用户定；codex/droid 备用）、顾问定位（`status:"advisor"` 不写实现）、任务限定（`MODELS.tasks`）这几类限制由用户决定。更新时可以提出建议，不能自行改动。模型不入选不需要登记——不写进 `MODELS` 即不可选。
2. **排序依据**：先看 FrontierCode 和 CursorBench 的分数和每任务成本；厂商自报数字只用来在第三方数据缺失或分数接近时参考，并在表里注明「厂商」。
3. **加入自动路由**，须同时满足：
   - cliproxyapi 能调（pi 入口排首位；swe-2/opus 例外，用户定走 devin），codex/droid 有同模型时补为备用入口；
   - 第三方榜上的分数比该行现有候选低不超过 5 分，且每任务成本更低；或者分数更高、成本相近；
   - 不属于用户限定的模型。
4. **降级或移出**，满足任一即可：
   - 同厂商出了价格相同或更低的新版本；
   - 第三方分数落后该行第一名 10 分以上；
   - 本机记录显示该入口反复失败。
5. **每个数字都要能追溯**：写明来源；调研日期写在文件开头。

### 流程

1. 对比 `orchestrator_capabilities` 的模型列表和 `scripts/route-data.mjs` 的 entries，找出新增、下线和改名的模型；选项规格变化后重新生成 `scripts/fixtures/caps-trimmed.json`。
2. 按上面的来源核对新增模型与价格变化；核对完跑 `route.mjs audit --caps-file <实时 caps>` 确认全部入口目录可查、选项合法。
3. 把建议的改动列成表（模型、原状态、新状态、理由、来源）交给用户确认。
4. 用户确认后改 `scripts/route-data.mjs` 与本文件（画像表同步状态列），跑 `node --test scripts/route.test.mjs`，并更新调研日期。
