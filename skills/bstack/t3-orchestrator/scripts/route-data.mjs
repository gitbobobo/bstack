// 选择规则的默认值。用户配置 ~/.config/bstack/t3-orchestrator.json 可覆盖两类池、模型入口与换路上限，
// 合并规则见 route-config.mjs；route.mjs 读合并后的生效值，route.test.mjs 据本文件校验不变量。
// 数据源与更新标准见 ../references/models.md。
//
// 两类池（用户定，2026-11-22）：
//   IMPLEMENTERS —— 实现模型，承担写代码等一切非顾问任务；数组顺序 = 模型优先级
//   ADVISORS     —— 顾问模型，只做方案咨询与审查，不写实现；顾问不够用时由 route.mjs 从实现池递补
//   其余写在 MODELS 里的模型只在用户点名时使用（route.mjs named）
//
// MODELS[key]：{ label, effort, entries }
//   effort   —— 固定思考强度（用户定），route.mjs 按 EFFORT_KEYS 写进对应 harness 的选项名
//   entries  —— { provider, id, options? }，数组顺序 = harness 优先级；options 只放档位以外的附加选项
//
// harness 分工（用户定，2026-11-04）：pi 经 cliproxyapi 调 glm/deepseek/grok/gpt 系，是这些模型的首选入口；
// swe-2 只走 devin，opus 走 devin/droid；codex（只跑 GPT）与 droid 是备用入口。主代理不查额度，失败就换路。

export const PROVIDER_RULES = {
  // 一律注入；用户显式指定其他自治级别时按用户说的（check 里 warn）。
  acpRegistry_factory_droid: { forceOptions: { autonomy_level: "auto-high" } },
  // 有 fastMode 选项的入口由 route.mjs 按目录选项描述符自动注入 fastMode:false；codex serviceTier 保持 default。
};

// 各 harness 的思考强度选项名（2026-10-27 按实时目录核对）
export const EFFORT_KEYS = {
  pi: "thinking",
  codex: "reasoningEffort",
  acpRegistry_devin: "thought_level",
  acpRegistry_factory_droid: "reasoning_effort",
};

export const IMPLEMENTERS = ["glm-5.3-flash", "swe-2", "deepseek-v4.1-flash"];
export const ADVISORS = ["gpt-6.2-sol"];

export const MODELS = {
  "glm-5.3-flash": {
    label: "GLM 5.3 Flash",
    effort: "high",
    entries: [
      { provider: "pi", id: "cliproxyapi/glm-5.3-flash" },
      { provider: "acpRegistry_factory_droid", id: "glm-5.3-flash" },
    ],
  },
  "swe-2": {
    label: "SWE-2",
    effort: "high",
    // pi 的 swe-2 来自已移除的 devin 订阅，droid 目录没有 SWE-2
    entries: [{ provider: "acpRegistry_devin", id: "swe-2-high" }],
  },
  "deepseek-v4.1-flash": {
    label: "DeepSeek V4.1 Flash",
    effort: "medium",
    entries: [
      { provider: "pi", id: "cliproxyapi/deepseek-v4.1-flash" },
      { provider: "acpRegistry_factory_droid", id: "deepseek-v4.1-flash" },
    ],
  },
  "gpt-6.2-sol": {
    label: "GPT-6.2 Sol",
    effort: "medium",
    entries: [
      { provider: "pi", id: "cliproxyapi/gpt-6.2-sol" },
      { provider: "codex", id: "gpt-6.2-sol" },
      { provider: "acpRegistry_factory_droid", id: "gpt-6.2-sol" },
    ],
  },
  // 以下仅用户点名（订阅额度受限，用户定 2026-11-17）
  "opus-5.5": {
    label: "Opus 5.5",
    effort: "medium",
    entries: [
      { provider: "acpRegistry_devin", id: "claude-opus-5-5-medium" },
      { provider: "acpRegistry_factory_droid", id: "claude-opus-5-5" },
    ],
  },
  "grok-4.7": {
    label: "Grok 4.7",
    effort: "medium",
    entries: [
      { provider: "pi", id: "cliproxyapi/grok-4.7" },
      { provider: "acpRegistry_factory_droid", id: "grok-4.7" },
    ],
  },
};

export const MAX_ATTEMPTS = 4;
