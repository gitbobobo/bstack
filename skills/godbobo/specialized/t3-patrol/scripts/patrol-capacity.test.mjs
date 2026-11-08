import { test } from "node:test";
import assert from "node:assert/strict";
import { capacityOf, freeFor, repoMatches, validateDevices } from "./patrol-capacity.mjs";

const id = (canonicalKey, origin) => ({ canonicalKey, ...(origin ? { origin: { canonicalKey: origin } } : {}) });
const projects = new Map([
  ["p-musiver", id("fj.frp.musiver.cn/fjbobo/musiver")],
  ["p-doc", id("github.com/liuyincs/musiver")],
  ["p-tma", id("fj.frp.musiver.cn/fjbobo/tma")],
  ["p-skills", id("github.com/gitbobobo/skills")],
  ["p-t3", id("github.com/pingdotgg/t3code", "github.com/gitbobobo/t3code")],
  ["p-none", null],
]);

test("仓库匹配：完整 key 精确比对，仓库名比对最后一段，含 fork 的 origin", () => {
  assert.ok(repoMatches("musiver", projects.get("p-musiver")));
  assert.ok(repoMatches("musiver", projects.get("p-doc")));
  assert.ok(repoMatches("FJ.frp.musiver.cn/fjbobo/musiver", projects.get("p-musiver")));
  assert.ok(!repoMatches("fj.frp.musiver.cn/fjbobo/musiver", projects.get("p-doc")));
  assert.ok(repoMatches("github.com/gitbobobo/t3code", projects.get("p-t3")));
  assert.ok(!repoMatches("musiver", null));
});

test("每个线程只进第一个匹配的池；审查线程只计设备总数；没有池匹配的只占设备名额", () => {
  const device = {
    device: "mac-mini",
    maxActiveThreads: 6,
    pools: [
      { repos: ["fj.frp.musiver.cn/fjbobo/musiver"], max: 2 },
      { repos: ["tma", "musiver"], max: 2 },
    ],
  };
  const threads = [
    { title: "a", projectId: "p-musiver" },
    { title: "b", projectId: "p-musiver" },
    { title: "c", projectId: "p-doc" },
    { title: "代码审查 · PR #1", projectId: "p-musiver", reviewBot: true },
    { title: "d", projectId: "p-skills" },
  ];
  const c = capacityOf({ threads, projects, device, maxActiveThreads: 5 });
  assert.equal(c.max, 6);
  assert.equal(c.used, 5);
  assert.equal(c.free, 1);
  assert.deepEqual(c.pools.map((p) => [p.used, p.free]), [[2, 0], [1, 1]]);
  assert.deepEqual(c.pools[1].occupying, ["c"]);
  assert.equal(c.freeByRepo["fj.frp.musiver.cn/fjbobo/musiver"], 0);
  assert.equal(c.freeByRepo["fj.frp.musiver.cn/fjbobo/tma"], 1);
  assert.equal(c.freeByRepo["github.com/gitbobobo/skills"], 1);
  assert.equal(c.freeOther, 1);
});

test("「*」池收其余仓库（含无仓库身份的项目）；没配设备时退回总上限", () => {
  const device = { device: "pc", pools: [{ repos: ["musiver"], max: 5 }, { repos: "*", max: 1 }] };
  const c = capacityOf({ threads: [{ title: "x", projectId: "p-none" }], projects, device, maxActiveThreads: 5 });
  assert.equal(c.pools[1].used, 1);
  assert.equal(c.freeByRepo["github.com/gitbobobo/skills"], 0);
  assert.equal(c.freeByRepo["github.com/liuyincs/musiver"], 4);
  assert.equal(c.freeOther, 0);
  assert.equal(freeFor(c, projects.get("p-t3")), 0);
  const bare = capacityOf({ threads: [], projects, device: undefined, maxActiveThreads: 5 });
  assert.deepEqual([bare.device, bare.free, bare.pools, bare.freeOther], [null, 5, [], 5]);
});

test("设备配置校验：坏条目丢弃并报警告", () => {
  const warnings = [];
  const out = validateDevices([
    { device: "pc", pools: [{ repos: ["musiver"], max: 5 }, { repos: [], max: 1 }, { repos: "*", max: -1 }] },
    { device: "pc", pools: [] },
    { pools: [] },
    { device: "linux", maxActiveThreads: 1.5 },
    { device: "mbp", maxActiveThreads: 3 },
  ], warnings);
  assert.deepEqual(out, [
    { device: "pc", pools: [{ repos: ["musiver"], max: 5 }] },
    { device: "mbp", maxActiveThreads: 3, pools: [] },
  ]);
  assert.equal(warnings.length, 5);
});
