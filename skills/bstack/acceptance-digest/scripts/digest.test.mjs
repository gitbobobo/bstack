import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("validateVerdicts 保留各仓库状态，项目内高风险排前", () => {
  const { errors, projects } = validateVerdicts(collected, {
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
  assert.equal(projects.length, 2);
  assert.deepEqual(projects[0].accept.map((a) => a.num), [2, 1]);
  assert.equal(projects[0].skip[0].title, "t3");
  assert.deepEqual(projects[1].accept, []);
  assert.deepEqual(projects[1].skip, []);
});

function runPublish(t, repos, projects, ...flags) {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-test-"));
  t.after(() => rmSync(dir, { recursive: true }));
  writeFileSync(join(dir, "prs.json"), JSON.stringify({ ...collected, repos }));
  const verdicts = join(dir, "verdicts.json");
  writeFileSync(verdicts, JSON.stringify({ projects }));
  const cli = fileURLToPath(new URL("./digest.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [cli, "publish", verdicts, ...flags], {
    encoding: "utf8", env: { ...process.env, HOME: dir, ACCEPTANCE_DIGEST_DIR: dir },
  });
  return { dir, output };
}

test("publish 把不同仓库的同号 PR 合并到唯一报告，并保留无待验收仓库的状态", (t) => {
  const [app, empty] = collected.repos;
  const active = (repo) => ({ ...app, repo, prs: [app.prs[0]] });
  const accept = [{ num: 1, risk: "high", summary: "s", why: "w", checks: ["c"] }];
  const skip = [{ num: 1, reason: "文档" }];
  const second = "github.com/other/app";
  const skipped = "github.com/o/skipped";
  const failed = { repo: "github.com/o/failed", prs: [], error: "取数出错原文" };
  const { dir, output } = runPublish(t, [active(app.repo), active(second), active(skipped), empty, failed], {
    [app.repo]: { accept }, [second]: { accept }, [skipped]: { skip },
  }, "--dry-run");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".html")), ["acceptance.html"]);
  assert.equal(output.match(/ → .*\.html/g)?.length, 1);
  assert.match(output, /验收总览：2 个项目，2 个 PR 待验收，2 个高风险/);
  assert.match(output, /skipped：1 个合并均免验收/);
  assert.match(output, /lib：窗口内无合并/);
  assert.match(output, /failed：取数失败（取数出错原文）/);
  const html = readFileSync(join(dir, "acceptance.html"), "utf8");
  const data = JSON.parse(html.match(/<script id="data"[^>]*>(.*?)<\/script>/s)[1]);
  assert.equal(data.until, collected.until);
  assert.deepEqual(data.projects.filter((p) => p.accept.length).map((p) => [p.repo, p.accept[0].num]), [[app.repo, 1], [second, 1]]);
  assert.equal(data.projects[2].skip[0].reason, "文档");
  assert.equal(data.projects[4].error, failed.error);
});

test("publish 无待验收项时不生成网页，也不需要上传配置", (t) => {
  const [app, empty] = collected.repos;
  const { dir, output } = runPublish(t, [app, empty], {
    [app.repo]: { skip: app.prs.map(({ num }) => ({ num, reason: "文档" })) },
  });
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".html")));
  assert.doesNotMatch(output, /验收总览/);
  assert.match(output, /3 个合并均免验收/);
});

test("renderPage 注入数据并转义 </script>", () => {
  const html = renderPage(readFileSync(TEMPLATE_PATH, "utf8"), { name: "</script><b>$&" });
  assert.ok(!html.includes("/*DATA*/null"));
  assert.ok(html.includes("\\u003c/script>\\u003cb>$&"));
});
