// 搜索仅提供线索；线程当前状态必须从目标环境回读，缺失状态视为取证失败。
export const refRe = (ref) => new RegExp(`(^|[^\\w-])${String(ref).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i");

export async function findOpenThread(ref, scopes, call) {
  for (const scope of scopes) {
    const result = await call("t3_thread_search", { ...scope, query: ref, limit: 100 });
    if (!Array.isArray(result?.matches)) throw new Error(`查重搜索结果缺失：${scope.environmentId}`);
    const seen = new Set();
    for (const hit of result.matches) {
      if (hit.source === "assistant" || !refRe(ref).test(`${hit.title ?? ""} ${hit.snippet ?? ""}`)) continue;
      if (!hit.threadId) throw new Error("查重命中缺少 threadId");
      if (seen.has(hit.threadId)) continue;
      seen.add(hit.threadId);
      const read = await call("t3_thread_read", { environmentId: scope.environmentId, threadId: hit.threadId, limit: 1 });
      const t = read?.thread;
      if (!t || t.threadId !== hit.threadId) throw new Error(`查重回读身份不符：${hit.threadId}`);
      if (t.settled === true || t.archived === true || t.settledAt || t.archivedAt || t.deletedAt || ["settled", "archived", "deleted"].includes(t.status)) continue;
      if (t.settled !== false || t.archived !== false) throw new Error(`查重回读缺少当前终结状态：${hit.threadId}`);
      return { ...t, environmentId: scope.environmentId, link: t.link ?? hit.link };
    }
  }
  return null;
}
