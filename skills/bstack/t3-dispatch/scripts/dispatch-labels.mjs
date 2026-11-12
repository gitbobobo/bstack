// 用户意愿：来源适配器与派活排序共用，精确匹配保留标签名。
export const DISPATCH_LABELS = [
  { name: "bstack:priority", color: "D93F0B", description: "用户希望优先实现；仍需通过派活准入检查" },
  { name: "bstack:defer", color: "CFD3D7", description: "暂缓自动派活；移除此标签后恢复候选资格" },
];

export function labelPolicy(labels = []) {
  const names = new Set(labels.map((l) => String(l).toLowerCase()));
  const priority = names.has("bstack:priority");
  const deferred = names.has("bstack:defer");
  return { priority, deferred, conflict: priority && deferred };
}
