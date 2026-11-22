# 模型参考

调研日期：2026-10-11；harness 收敛为 pi / codex / droid：2026-10-27；2026-11-04 cliproxyapi 的 devin 订阅移除，swe-2/opus 改走 devin（用户定）；2026-11-17 opus/grok 改为点名专用（用户定）；2026-11-20 gpt-6.1-sol 换为 gpt-6.2-sol（用户定）；2026-11-22 简化为实现/顾问两类池、思考强度固定（用户定）。模型 ID 以 `orchestrator_capabilities` 实时返回为准。

基准说明：FrontierCode（Cognition 维护，按代码能否合并评分）和 CursorBench 是第三方统一 harness 的榜单；Terminal-Bench、DeepSWE 多为厂商自报，不同版本不能横比。

## harness

| 实例 | 用途 | 说明 |
|---|---|---|
| `pi` | glm/deepseek/grok/gpt 系的首选入口 | 经 cliproxyapi（`~/.pi/agent/cliproxyapi.json`）调多个提供商，额度与渠道切换由 cliproxyapi 负责；模型 ID 形如 `cliproxyapi/<模型>`。目录里的 `opencode-go/*`、`commandcode/*`、`opendesign/*` 不走 cliproxyapi，不进路由 |
| `codex` | gpt-6.2-sol 的备用入口 | 仅跑 GPT |
| `acpRegistry_devin` | swe-2 与 opus（点名）的主入口（用户定） | 模型 ID 自带档位后缀（`swe-2-high`、`claude-opus-5-5-medium`） |
| `acpRegistry_factory_droid` | 其余模型的备用入口 | 目录没有 SWE-2。需 droid ≥0.234.0（[Factory-AI/factory#9](https://github.com/Factory-AI/factory/issues/9)） |

## 模型池

池的归属与思考强度只有用户能改（用户定，2026-11-22）。

| 模型 | 池 | 档位 | 关键数据 | 备注 |
|---|---|---|---|---|
| GLM 5.3 Flash | 实现（首选） | high | CursorBench max 36.8%，$0.39 | 便宜；原生多模态 |
| SWE-2 | 实现 | high | FrontierCode max 50.0%（$1.18） | 基于 Kimi K3，原生看图；多小时级终端长任务弱于 Opus |
| DeepSeek V4.1 Flash | 实现 | medium | Artificial Analysis MMMU-Pro 77% | 便宜、快；视觉弱于前两者 |
| GPT-6.2 Sol | 顾问 | medium | FrontierCode 43.8%（2026-11-20 换版后） | 审查与方案咨询，不写实现；顾问不够时 `advisor` 从实现池递补 |
| Opus 5.5 | 仅点名 | medium | FrontierCode medium 54.6% | 订阅额度受限 |
| Grok 4.7 | 仅点名 | medium | FrontierCode high 47.6%（$6.65） | 订阅额度受限；慢、输出 token 多 |

不用（不写进 `MODELS` 即不可选）：GLM 5.3（非 flash，max 档 token 极多、无视觉）、Composer 2.5、MiniMax-M3、glm-5.2、gpt-6-sol、gpt-6.1-sol、gpt-5.6 系、gemini flash 系、grok-4.6、claude-sonnet-5-5、gpt-6-luna、gpt-6-astra、claude-fable-5-1、kimi-k3。

## 数据在哪

`scripts/route-data.mjs`：`IMPLEMENTERS`、`ADVISORS`（顺序即优先级）、`MODELS`（`effort` 固定档位、`entries` 入口顺序即 harness 优先级）、`EFFORT_KEYS`（各 harness 的档位选项名：pi `thinking`、codex `reasoningEffort`、devin `thought_level`、droid `reasoning_effort`）。droid 一律注入 `autonomy_level:"auto-high"`；目录里有 `fastMode` 的入口注入 `false`；codex `serviceTier` 保持 default。用户配置 `~/.config/bstack/t3-orchestrator.json` 的覆盖规则见 `scripts/route-config.mjs` 文件头，`route.mjs table` 看生效值。

测试夹具 `scripts/fixtures/caps-trimmed.json` 只含 route-data 用到的 provider/模型。目录变化后重新生成：取实时 `orchestrator_capabilities`，按 entries 的 provider/模型 id 过滤（保留完整选项描述），`canRunChildTask`/`canRunCrossProviderChildTask` 归一化为 true、`constraints` 清空。

## 更新来源与标准

| 用途 | 来源 |
|---|---|
| 实际可用的模型 ID 与选项 | `orchestrator_capabilities`；cliproxyapi 可用模型另见 `~/.pi/agent/cliproxyapi-models.json`（`stale:false`） |
| 第三方统一榜 | FrontierCode：https://cognition.com/frontiercode；CursorBench：https://cursor.com/cursorbench |
| 厂商发布 | OpenAI https://openai.com/news；Anthropic https://www.anthropic.com/news；xAI https://x.ai/news；Cognition https://cognition.com/blog；智谱 https://docs.z.ai |
| 价格 | Codex https://help.openai.com（搜 Codex usage limits）；Factory https://factory.ai/pricing |
| 本机实际表现 | `~/.t3/userdata/statev2.sqlite`，只读打开（`sqlite3 "file:...?mode=ro"`），统计 `projection_thread_activities` 中 `runtime.error` 的按 provider 分布 |

标准：

1. 池归属、思考强度、点名专用、harness 分工（glm/deepseek/grok/gpt 首选 pi；swe-2 只走 devin、opus 走 devin/droid）只有用户能改；你只提建议。
2. 排序先看 FrontierCode 与 CursorBench 的分数和每任务成本；厂商自报只在第三方缺失或分数接近时参考，并注明「厂商」。
3. 建议换入实现池：cliproxyapi 能调，第三方分数比池内同位模型低不超过 5 分且更便宜，或分数更高、成本相近。建议移出：同厂商出了同价或更便宜的新版；分数落后池首 10 分以上；本机记录反复失败。
4. 每个数字写明来源。

流程：

1. 对比 `orchestrator_capabilities` 与 `route-data.mjs` 的 entries，找出新增、下线和改名的模型；选项规格变化后重新生成夹具。
2. 跑 `node scripts/route.mjs audit --caps-file <实时 caps>`，确认全部入口目录可查、选项合法。
3. 把建议列成表（模型、原池/档位、新池/档位、理由、来源）交给用户确认。
4. 确认后改 `route-data.mjs` 与本文件，跑 `node --test scripts/route.test.mjs scripts/route-config.test.mjs`，更新调研日期。只影响某台设备的偏好（如本机没有某个 harness）改用户配置，不改默认值。
