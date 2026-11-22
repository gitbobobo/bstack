import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { factOf, parseRepoKey, renderPage, repoList, TEMPLATE_PATH, validateVerdicts } from "./digest.mjs";

const collected = {
  since: "2026-11-21T00:00:00.000Z",
  until: "2026-11-22T00:00:00.000Z",
  repos: [
    { repo: "github.com/o/app", web: "https://github.com/o/app", prs: [1, 2, 3].map((num) => factOf({ num, title: `t${num}`, url: `u${num}`, mergedAt: "2026-11-21T08:00:00.000Z" })) },
    { repo: "fj.example.com/o/lib", web: "https://fj.example.com/o/lib", prs: [] },
  ],
};

test("repoList 合并去重并统一小写", () => {
  assert.deepEqual(repoList(["GitHub.com/O/App"], ["github.com/o/app", "fj.example.com/o/lib"]), ["github.com/o/app", "fj.example.com/o/lib"]);
  assert.throws(() => parseRepoKey("o/app"));
});

test("factOf 摘出验收豁免原文、放过 lint 豁免并截断正文", () => {
  const f = factOf({ num: 1, body: "x".repeat(2000), comments: [{ by: "bot", body: "按巡检授权豁免人工验收，实体设备未测" }] });
  assert.equal(f.waiverHints.length, 1);
  assert.match(f.waiverHints[0], /实体设备未测/);
  assert.ok(f.body.length <= 1501);
  assert.deepEqual(factOf({ num: 2, body: "`UserMessaging.ets` 唯一永久豁免；kotlin-test-hygiene 定点豁免" }).waiverHints, []);
});

test("validateVerdicts 要求每个 PR 恰好判定一次", () => {
  const { errors } = validateVerdicts(collected, {
    projects: {
      "github.com/o/app": { accept: [{ num: 1, summary: "s", why: "w", checks: [] }], skip: [{ num: 1, reason: "r" }, { num: 9, reason: "r" }] },
      "github.com/o/ghost": {},
    },
  });
  assert.ok(errors.some((e) => e.includes("o/ghost")));
  assert.ok(errors.some((e) => e.includes("#1：同时出现")));
  assert.ok(errors.some((e) => e.includes("#9：不是窗口内")));
  assert.ok(errors.some((e) => e.includes("#1：accept 缺 checks")));
  assert.ok(errors.some((e) => e.includes("#2：未判定")));
});

test("validateVerdicts 只为有待验收的项目出页，高风险排前", () => {
  const { errors, pages } = validateVerdicts(collected, {
    projects: {
      "github.com/o/app": {
        accept: [
          { num: 1, summary: "s", why: "w", checks: ["c"] },
          { num: 2, risk: "high", summary: "s", why: "w", checks: ["c"] },
        ],
        skip: [{ num: 3, reason: "文档" }],
      },
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].accept.map((a) => a.num), [2, 1]);
  assert.equal(pages[0].skip[0].title, "t3");
});

test("renderPage 注入数据并转义 </script>", () => {
  const html = renderPage(readFileSync(TEMPLATE_PATH, "utf8"), { name: "</script><b>$&" });
  assert.ok(!html.includes("/*DATA*/null"));
  assert.ok(html.includes("\\u003c/script>\\u003cb>$&"));
});
