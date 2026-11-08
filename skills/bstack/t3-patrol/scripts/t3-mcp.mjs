// T3 MCP 的 HTTP 客户端：快照与补读脚本共用。
// T3 把 MCP 会话注入 harness 进程环境：ACP 类（droid、devin）给 T3_ACP_MCP_*（authorization 已带 Bearer 前缀），
// pi 给 T3_MCP_URL / T3_MCP_BEARER_TOKEN（裸 token）。Codex 的会话只写进自身 MCP 配置，shell 里拿不到。

const ACP = !!(process.env.T3_ACP_MCP_ENDPOINT && process.env.T3_ACP_MCP_AUTHORIZATION);
const URL_ = ACP ? process.env.T3_ACP_MCP_ENDPOINT : process.env.T3_MCP_URL;
const AUTH = ACP ? process.env.T3_ACP_MCP_AUTHORIZATION : process.env.T3_MCP_BEARER_TOKEN && `Bearer ${process.env.T3_MCP_BEARER_TOKEN}`;

export const hasSession = () => Boolean(URL_ && AUTH);
export const NO_SESSION =
  "缺少 T3 MCP 会话（T3_ACP_MCP_* 或 T3_MCP_URL / T3_MCP_BEARER_TOKEN，当前 harness 未向 shell 注入）：改用 MCP 工具按技能步骤手工取证。";

let sid = null;
let seq = 0;
export async function rpc(method, params, attempt = 0) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: AUTH,
  };
  if (sid) headers["mcp-session-id"] = sid;
  let res;
  try {
    res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }) });
  } catch (e) {
    // 传输层失败（ECONNRESET / fetch failed）重试一次；MCP 的读接口都可重放。
    if (attempt < 1) {
      await new Promise((r) => setTimeout(r, 800));
      return rpc(method, params, attempt + 1);
    }
    throw e;
  }
  sid = res.headers.get("mcp-session-id") || sid;
  const text = await res.text();
  const m = text.match(/^data: (.*)$/m);
  const msg = JSON.parse(m ? m[1] : text);
  if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
  return msg.result;
}

export async function connect(name) {
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "1" } });
}

export async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text ?? "error"}`);
  return r.structuredContent ?? JSON.parse(r.content[0].text);
}

// 有界并发：一次把所有候选线程同时展开会把 MCP 连接打满，
// 表现为部分线程「取详情失败、字段全空」，巡检据此误判成「还在推进」。
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
