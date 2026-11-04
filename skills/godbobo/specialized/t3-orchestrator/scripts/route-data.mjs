// 选择规则的唯一事实源。改选择行为只改这里，route.mjs 与 route.test.mjs 随之生效。
// 数据源与更新标准见 ../references/models.md「更新来源与标准」。
//
// 结构：
//   MODELS[key]  —— 一个逻辑模型：status（auto/advisor/named）、vision（视觉分数，见下）、
//                  tasks?（限定可进入的任务类型，缺省不限；行内、白名单递补与 check --role 都按它拦）、
//                  entries（该模型的 harness 入口，数组顺序 = harness 优先级）
//   vision       —— Roboflow Vision Evals 总分（playground.roboflow.com/evals，2026-10-13 版）；
//                  --vision 按它降序重排候选流，同分保持原顺序；缺省 = 0（不看图）。
//                  榜上没有的模型写估值并注明依据。
//   entries[]    —— { provider, id, options? }
//                  provider 是 delegate_task 的 providerInstanceId；id 是该 harness 上的模型 ID；
//                  options 是默认选项（路由行可用 options 覆盖/追加）
//   ROUTES[task] —— 任务类型 → 候选组合 { model, provider, options? }，数组顺序 = 尝试
//                  顺序。「模型+harness」是固定的组合单元：provider 必须命中
//                  MODELS[model].entries 里的条目，组合的 id/options 取自该条目。
//   白名单递补   —— 行内没点名的可调度模型照样可用：status:"auto" 的模型按 MODELS
//                  声明顺序、各自按 entries 顺序补在流末尾；ADVISOR_TASKS 里的任务
//                  额外放开 status:"advisor"。named 永不进自动调度流。
//
// 白名单即全部：select/named/check 只从 MODELS.entries 出目标，不维护反例清单；
// 清单外组合统一按「不在入口清单」处理（非点名 FAIL、用户点名 WARN）。
//
// harness 分工（用户定，2026-11-04）：pi 经 cliproxyapi 调 glm/deepseek/grok/gpt 系（cliproxyapi 的
// devin 订阅已移除，不再提供 opus/swe-2），仍是这些模型的首选入口；swe-2 只从 devin harness
// （acpRegistry_devin）选，opus 从 devin/droid 选（均用户定）；codex（只跑 GPT）是 gpt-6.1-sol
// 的备用入口，droid 是其余模型的备用入口。主代理不查额度，失败就换路。
//
// 用户级开关（只有用户能改）：
//   - status: "named"    仅用户点名才用，自动调度与换路一律跳过
//   - status: "advisor"  只承担审查/顾问咨询，不派 implementation
//   - tasks              模型只进这些任务类型（如 Opus 只做实现顾问）

export const PROVIDER_RULES = {
  acpRegistry_factory_droid: {
    // 一律注入；用户显式指定其他自治级别时按用户说的（check 里 warn）。
    forceOptions: { autonomy_level: "auto-high" },
    note: "droid 选项名是 reasoning_effort（snake_case），不是 reasoningEffort",
  },
  // 有 fastMode 选项的入口由 route.mjs 按目录选项描述符自动注入 fastMode:false；
  // codex serviceTier 保持 default。
};

// 档位标准：主代理派发默认 high；EFFORT_MEDIUM_MODELS 里的模型用 medium（用户定）。
// 每个入口显式声明一个档位选项（route.test.mjs 校验）；droid 目录现在也有 medium（2026-11-04 实时目录），
// 三个 medium 模型的 droid 入口同样用 medium。
export const EFFORT_STANDARD = "high";
export const EFFORT_MEDIUM = "medium";
export const EFFORT_MEDIUM_MODELS = ["opus-5.5", "gpt-6.1-sol", "grok-4.7"];
export const EFFORT_OPTION_IDS = ["thinking", "reasoningEffort", "reasoning_effort", "thought_level"];

export const MODELS = {
  "opus-5.5": {
    label: "Opus 5.5",
    status: "advisor",
    // 用户定：只做实现顾问（--task design），不做代码审查与安全复核
    tasks: ["design"],
    vision: 82.0,
    entries: [
      // 用户定（2026-11-04）：opus 从 devin/droid 选择；cliproxyapi 的 devin 订阅已移除，pi 不再提供 opus
      // claude 系 harness 优先级：devin > droid
      { provider: "acpRegistry_devin", id: "claude-opus-5-5-medium", options: { thought_level: "medium" } },
      { provider: "acpRegistry_factory_droid", id: "claude-opus-5-5", options: { reasoning_effort: "medium" } },
    ],
  },
  "gpt-6.1-sol": {
    label: "GPT-6.1 Sol",
    status: "advisor",
    vision: 81.7,
    entries: [
      // pi 入口经 cliproxyapi 的 codex 订阅提供（devin 版已随 devin 订阅移除，2026-11-04）
      { provider: "pi", id: "cliproxyapi/gpt-6.1-sol", options: { thinking: "medium" } },
      { provider: "codex", id: "gpt-6.1-sol", options: { reasoningEffort: "medium" } },
      { provider: "acpRegistry_factory_droid", id: "gpt-6.1-sol", options: { reasoning_effort: "medium" } },
    ],
  },
  "swe-2": {
    label: "SWE-2",
    status: "auto",
    // 榜上无 SWE-2，取基座 Kimi K3 的 56.0；Cognition 只做了编码向后训练，未发布视觉数据。
    vision: 56.0,
    // 用户定（2026-11-04）：swe-2 只从 devin 选；pi 的 swe-2 来自已移除的 devin 订阅，droid 目录也没有 SWE-2。
    entries: [{ provider: "acpRegistry_devin", id: "swe-2-high", options: { thought_level: "high" } }],
  },
  "grok-4.7": {
    label: "Grok 4.7",
    status: "advisor",
    vision: 63.5,
    entries: [
      { provider: "pi", id: "cliproxyapi/grok-4.7", options: { thinking: "medium" } },
      { provider: "acpRegistry_factory_droid", id: "grok-4.7", options: { reasoning_effort: "medium" } },
    ],
  },
  "glm-5.3-flash": {
    label: "GLM 5.3 Flash",
    status: "auto",
    vision: 55.8,
    entries: [
      { provider: "pi", id: "cliproxyapi/glm-5.3-flash", options: { thinking: "high" } },
      { provider: "acpRegistry_factory_droid", id: "glm-5.3-flash", options: { reasoning_effort: "high" } },
    ],
  },
  "deepseek-v4.1-flash": {
    label: "DeepSeek V4.1 Flash",
    status: "auto",
    // 估值：榜上无该模型。Artificial Analysis MMMU-Pro 77%（同榜 Opus 5.5 88%），
    // 而 GLM 5.3 Flash / Kimi K3 在 Vals MMMU-Pro 为 86.0% / 88.2%，明显落后二者，取略低于 GLM。
    vision: 50,
    entries: [
      { provider: "pi", id: "cliproxyapi/deepseek-v4.1-flash", options: { thinking: "high" } },
      { provider: "acpRegistry_factory_droid", id: "deepseek-v4.1-flash", options: { reasoning_effort: "high" } },
    ],
  },
};

// 白名单递补额外放开 status:"advisor" 的任务（见文件头）。select 的 --task 取值即 TASKS 的 key。
// design / review 与 delegate_task 的 role 同名，check --role 直接按它套用 MODELS.tasks 限定。
export const ADVISOR_TASKS = ["review", "design"];

export const TASKS = {
  general: "普通任务：写代码、修 bug、架构、机械与批量改动、调研与文档、UI 与前端视觉（重视觉加 --vision）",
  design: "实现顾问：审主代理的方案/设计稿、修不收敛时要第二意见（UI/UX 方案加 --vision）",
  review: "审查：代码审查、安全复核；要两个不同模型就跑两次（第二次 --exclude-model 第一次 PICK 的 model=）",
};

// 每行先排各模型的 pi 入口（模型优先级），再排备用 harness。
export const ROUTES = {
  // 用户确认首选 GLM flash，其次 SWE-2（swe-2 走 devin，用户定）
  general: [
    { model: "glm-5.3-flash", provider: "pi" },
    { model: "swe-2", provider: "acpRegistry_devin" },
    { model: "deepseek-v4.1-flash", provider: "pi" },
    { model: "glm-5.3-flash", provider: "acpRegistry_factory_droid" },
    { model: "deepseek-v4.1-flash", provider: "acpRegistry_factory_droid" },
  ],
  // 审查：Opus 不做审查（tasks 限定）。
  review: [
    { model: "gpt-6.1-sol", provider: "pi" },
    { model: "grok-4.7", provider: "pi" },
    { model: "gpt-6.1-sol", provider: "codex" },
    { model: "gpt-6.1-sol", provider: "acpRegistry_factory_droid" },
    { model: "grok-4.7", provider: "acpRegistry_factory_droid" },
  ],
  // 实现顾问：Opus 首选（用户定），走 devin/droid（用户定）。
  design: [
    { model: "opus-5.5", provider: "acpRegistry_devin" },
    { model: "gpt-6.1-sol", provider: "pi" },
    { model: "grok-4.7", provider: "pi" },
    { model: "gpt-6.1-sol", provider: "codex" },
    { model: "opus-5.5", provider: "acpRegistry_factory_droid" },
    { model: "gpt-6.1-sol", provider: "acpRegistry_factory_droid" },
    { model: "grok-4.7", provider: "acpRegistry_factory_droid" },
  ],
};

export const MAX_ATTEMPTS = 4;
