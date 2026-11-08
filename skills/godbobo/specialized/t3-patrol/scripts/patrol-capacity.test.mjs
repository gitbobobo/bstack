import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capacityOf, repoMatches, validateDevices, withDisk } from "./patrol-capacity.mjs";

const SCRIPT = fileURLToPath(new URL("./patrol-capacity.mjs", import.meta.url));
const NOW = Date.parse("2026-11-08T12:00:00Z");
const ago = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const CFG = { maxActiveThreads: 5, minFreeDiskGB: 20, defaultFootprintGB: 0, growthWindowHours: 2 };
const id = (canonicalKey, origin) => ({ canonicalKey, ...(origin ? { origin: { canonicalKey: origin } } : {}) });
const projects = new Map([
  ["p-musiver", id("fj.frp.musiver.cn/fjbobo/musiver")],
  ["p-doc", id("github.com/liuyincs/musiver")],
  ["p-tma", id("fj.frp.musiver.cn/fjbobo/tma")],
  ["p-skills", id("github.com/gitbobobo/skills")],
  ["p-t3", id("github.com/pingdotgg/t3code", "github.com/gitbobobo/t3code")],
  ["p-none", null],
]);
const MUSIVER = "fj.frp.musiver.cn/fjbobo/musiver";

test("仓库匹配：完整 key 精确比对，仓库名比对最后一段，含 fork 的 origin", () => {
  assert.ok(repoMatches("musiver", projects.get("p-musiver")));
  assert.ok(repoMatches("musiver", projects.get("p-doc")));
  assert.ok(repoMatches("FJ.frp.musiver.cn/fjbobo/musiver", projects.get("p-musiver")));
  assert.ok(!repoMatches(MUSIVER, projects.get("p-doc")));
  assert.ok(repoMatches("github.com/gitbobobo/t3code", projects.get("p-t3")));
  assert.ok(!repoMatches("musiver", null));
});

test("设备总上限缺省为各池之和，两个池可以同时用满；审查线程只计设备总数", () => {
  const device = { device: "pc", pools: [{ repos: [MUSIVER], max: 5 }, { repos: "*", max: 4 }] };
  const threads = [
    ...["a", "b", "c", "d"].map((title) => ({ title, projectId: "p-musiver", createdAt: ago(5) })),
    { title: "代码审查 · PR #1", projectId: "p-musiver", reviewBot: true, createdAt: ago(0.1) },
  ];
  const c = capacityOf({ threads, projects, device, cfg: CFG, now: NOW });
  assert.equal(c.max, 9);
  assert.equal(c.free, 4);
  assert.deepEqual(c.pools.map((p) => [p.used, p.free]), [[4, 1], [0, 4]]);
  assert.equal(c.freeByRepo[MUSIVER], 1);
  assert.equal(c.freeByRepo["github.com/gitbobobo/skills"], 4);
  assert.equal(c.freeOther, 4);
  assert.equal(capacityOf({ threads, projects, device: { ...device, maxActiveThreads: 6 }, cfg: CFG, now: NOW }).freeByRepo["github.com/gitbobobo/skills"], 1);
  const bare = capacityOf({ threads: [], projects, device: undefined, cfg: CFG, now: NOW });
  assert.deepEqual([bare.device, bare.max, bare.pools, bare.freeOther], [null, 5, [], 5]);
});

test("每个线程只进第一个匹配的池；没有池匹配的只占设备名额", () => {
  const device = { device: "mac-mini", maxActiveThreads: 6, pools: [{ repos: [MUSIVER], max: 2 }, { repos: ["tma", "musiver"], max: 2 }] };
  const threads = ["p-musiver", "p-musiver", "p-doc", "p-skills"].map((projectId, i) => ({ title: `t${i}`, projectId, createdAt: ago(9) }));
  const c = capacityOf({ threads, projects, device, cfg: CFG, now: NOW });
  assert.deepEqual(c.pools.map((p) => p.occupying), [["t0", "t1"], ["t2"]]);
  assert.equal(c.freeByRepo[MUSIVER], 0);
  assert.equal(c.freeByRepo["fj.frp.musiver.cn/fjbobo/tma"], 1);
  assert.equal(c.freeByRepo["github.com/gitbobobo/skills"], 2);
});

test("磁盘：扣掉保底与在建预留后按池的单线程占用折算；未知磁盘只按名额", () => {
  const device = { device: "pc", pools: [{ repos: [MUSIVER], max: 5, footprintGB: 30 }, { repos: "*", max: 4, footprintGB: 5 }] };
  const threads = [
    { title: "新建重型", projectId: "p-musiver", createdAt: ago(0.5) },
    { title: "老重型", projectId: "p-musiver", createdAt: ago(10) },
    { title: "新建轻型", projectId: "p-skills", createdAt: ago(1) },
  ];
  const c = capacityOf({ threads, projects, device, cfg: CFG, now: NOW, diskFreeGB: 100 });
  assert.equal(c.disk.reserveGB, 35);
  assert.deepEqual(c.disk.growing, ["新建重型", "新建轻型"]);
  assert.equal(c.disk.spareGB, 45);
  assert.equal(c.freeByRepo[MUSIVER], 1);
  assert.equal(c.freeByRepo["github.com/gitbobobo/skills"], 3);
  assert.equal(withDisk(c, 40).freeByRepo[MUSIVER], 0);
  assert.equal(withDisk(c, 40).freeByRepo["github.com/gitbobobo/skills"], 0);
  const unknown = capacityOf({ threads, projects, device, cfg: CFG, now: NOW });
  assert.equal(unknown.disk.freeGB, null);
  assert.equal(unknown.freeByRepo[MUSIVER], 3);
});

test("footprintGB 为 0 时只要求剩余不低于保底，等于旧行为", () => {
  const c = capacityOf({ threads: [], projects, device: undefined, cfg: CFG, now: NOW, diskFreeGB: 21 });
  assert.equal(c.freeOther, 5);
  assert.equal(withDisk(c, 19).freeOther, 0);
});

test("CLI：按快照里的容量与探测到的剩余空间重算", () => {
  const dir = mkdtempSync(join(tmpdir(), "patrol-cap-"));
  try {
    const device = { device: "linux", pools: [{ repos: [MUSIVER], max: 1, footprintGB: 25 }, { repos: "*", max: 4, footprintGB: 3 }] };
    const capacity = capacityOf({ threads: [], projects, device, cfg: CFG, now: NOW });
    const file = join(dir, "snap.json");
    writeFileSync(file, JSON.stringify({ environments: [{ environmentId: "env-linux", alias: "linux", capacity }] }));
    const r = spawnSync(process.execPath, [SCRIPT, "--snapshot", file, "--env", "linux", "--disk-free", "40"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.freeByRepo[MUSIVER], 0);
    assert.equal(out.freeByRepo["github.com/gitbobobo/skills"], 4);
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--snapshot", file, "--env", "nope", "--disk-free", "1"]).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("设备配置校验：坏条目丢弃并报警告", () => {
  const warnings = [];
  const out = validateDevices([
    { device: "pc", pools: [{ repos: ["musiver"], max: 5, footprintGB: 30 }, { repos: [], max: 1 }, { repos: "*", max: -1 }, { repos: "*", max: 1, footprintGB: "5" }] },
    { device: "pc", pools: [] },
    { pools: [] },
    { device: "linux", maxActiveThreads: 1.5 },
    { device: "mbp", maxActiveThreads: 3 },
  ], warnings);
  assert.deepEqual(out, [
    { device: "pc", pools: [{ repos: ["musiver"], max: 5, footprintGB: 30 }] },
    { device: "mbp", maxActiveThreads: 3, pools: [] },
  ]);
  assert.equal(warnings.length, 6);
});
