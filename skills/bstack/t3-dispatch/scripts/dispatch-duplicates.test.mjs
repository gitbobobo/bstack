import { test } from "node:test";
import assert from "node:assert/strict";
import { findOpenThread } from "./dispatch-duplicates.mjs";
import { searchDupes, selectionOf } from "./dispatch-plan.mjs";

const scope = { environmentId: "pc", projectId: "mus" };
const hit = (threadId, extra = {}) => ({ threadId, title: "INT-1827 桌面设置共识", source: "title", link: `<${threadId}>`, ...extra });
function fixture(matches, threads) {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === "t3_thread_search") return { matches };
    assert.equal(args.environmentId, "pc");
    if (threads[args.threadId] instanceof Error) throw threads[args.threadId];
    return { thread: { threadId: args.threadId, ...threads[args.threadId] } };
  };
  return { call, calls };
}

test("INT-1827 回放：历史搜索命中已 settle 的共识线程，候选保留", async () => {
  const { call, calls } = fixture([hit("discussion")], { discussion: { settled: true, archived: false, title: "INT-1827 桌面设置共识" } });
  const plan = { repos: [{ repo: "host/mus", shortlist: [{ id: "issue", ref: "INT-1827" }], reviewed: [], excluded: [] }] };
  await searchDupes(plan, { environments: [{ environmentId: "pc", projects: [{ id: "mus", canonicalKey: "host/mus" }] }] }, call);
  assert.equal(plan.repos[0].shortlist.length, 1);
  assert.deepEqual(plan.repos[0].excluded, []);
  assert.equal(calls.filter((c) => c.name === "t3_thread_read").length, 1);
});

test("仅有未结命中也必须进入挑题分工复核范围", async () => {
  const { call } = fixture([hit("discussion")], { discussion: { settled: false, archived: false } });
  const plan = { slots: 1, repos: [{ repo: "host/mus", slots: 1, shortlist: [{ id: "issue", ref: "INT-1827" }], reviewed: [], excluded: [] }] };
  await searchDupes(plan, { environments: [{ environmentId: "pc", projects: [{ id: "mus", canonicalKey: "host/mus" }] }] }, call);
  assert.equal(plan.repos[0].excluded[0].duplicateReview, true);
  assert.equal(plan.repos[0].shortlist.length, 0);
  const assignment = selectionOf(plan).assignments[0];
  assert.equal(assignment.pendingCount, 1);
  assert.equal(assignment.mode, "lead", "不能把待复核项当成无候选跳过");
});

test("跳过终结命中后继续查，保留真正未结线程及环境身份", async () => {
  for (const closed of [{ settled: true }, { archived: true }, { status: "deleted" }]) {
    const { call } = fixture([hit("old"), hit("live")], { old: closed, live: { settled: false, archived: false } });
    const result = await findOpenThread("INT-1827", [scope], call);
    assert.equal(result.threadId, "live");
    assert.equal(result.environmentId, "pc");
  }
});

test("代理顺口提及和编号前缀不算命中；同一线程只回读一次", async () => {
  const { call, calls } = fixture([hit("aside", { source: "assistant" }), hit("prefix", { title: "INT-18270" }), hit("old"), hit("old")], { old: { settled: true } });
  assert.equal(await findOpenThread("INT-1827", [scope], call), null);
  assert.equal(calls.filter((c) => c.name === "t3_thread_read").length, 1);
});

test("回读失败或状态缺失是待核，不伪装成重复或查无重复", async () => {
  for (const state of [{}, new Error("离线")]) {
    const { call } = fixture([hit("unknown")], { unknown: state });
    await assert.rejects(findOpenThread("INT-1827", [scope], call));
    const plan = { repos: [{ repo: "host/mus", shortlist: [{ ref: "INT-1827" }], reviewed: [], excluded: [] }] };
    await searchDupes(plan, { environments: [{ environmentId: "pc", projects: [{ id: "mus", canonicalKey: "host/mus" }] }] }, call);
    assert.ok(plan.repos[0].shortlist[0].duplicateCheckError);
    assert.deepEqual(plan.repos[0].excluded, []);
  }
  await assert.rejects(findOpenThread("INT-1827", [scope], async () => { throw new Error("搜索离线"); }), /搜索离线/);
});
