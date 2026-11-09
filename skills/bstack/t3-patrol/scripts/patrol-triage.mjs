// 分诊：把候选分成「有事」与「静默」，巡检只对有事的线程做完整取证。
//
// 每小时一轮、二十来个候选，多数结论是「在跑，不打扰」或「上轮后没变化」。逐条深读把一轮拖到 20 分钟以上，
// 却不改变动作。分诊按「上一轮以来的变化」与「跨过阈值」判定：线程有新活动、PR 有新事件、某个等待在两轮之间超时，
// 都会让它变成有事；巡检发出的消息会触发目标线程的新 run，下一轮自然回到有事，动作验证不会漏。
// 未结 PR 的停驻与 pending 超时是持续条件，每轮复核；fullEveryHours 全量只兜住其余漏项。

const FAILED = new Set(["failed", "interrupted", "cancelled"]);
const QUEUED = new Set(["preparing", "queued", "starting"]);
const RUNNING = new Set(["running", "waiting"]);

const ms = (iso) => Date.parse(iso ?? "") || 0;

// 本轮是否全量：首轮、上一轮太久以前、或距上次全量已超过 fullEveryHours。
export function fullRoundOf(lastRound, { fullEveryHours }, now = Date.now()) {
  if (!lastRound?.snapshotAt) return { full: true, reason: "没有上一轮记录" };
  const since = ms(lastRound.snapshotAt);
  const lastFull = ms(lastRound.lastFullAt ?? lastRound.snapshotAt);
  if (now - since > 3 * 3600 * 1000) return { full: true, reason: "上一轮距今超过 3 小时" };
  if (lastRound.lastFullAt == null || now - lastFull >= fullEveryHours * 3600 * 1000) return { full: true, reason: `距上次全量已满 ${fullEveryHours} 小时` };
  return { full: false, since: lastRound.snapshotAt };
}

// 只凭明确的 POSIX `nohup … &` 启动加工具超时判 bgKills；cmd 的 `&` 是顺序分隔符。
// 缺少 shell 元数据时保守识别，其余后台/存活问题交给持续停驻超时分支核验。
// items 是 activity 条目，text 形如 "$ <命令>\n<输出>"；屏蔽引号与转义里的字面量。
const BG_LAUNCH = /(?<![&>|])&(?![&>])/;
const NOHUP = /(?:^|[;&|])\s*(?:\/\S*\/)?nohup\s/;
const shellCode = (cmd) => cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\\./g, " ");
export function bgKillsOf(items) {
  const hits = (items ?? []).filter((i) => {
    if (i.type !== "command_execution") return false;
    const [cmd, ...out] = String(i.text ?? "").replace(/^\$ /, "").split("\n");
    const code = shellCode(cmd);
    return NOHUP.test(code) && BG_LAUNCH.test(code) && /timed out/i.test(out.join("\n"));
  });
  if (!hits.length) return null;
  return { count: hits.length, lastAt: hits.at(-1).updatedAt ?? null, sample: String(hits.at(-1).text).split("\n")[0].slice(0, 200) };
}

// 线程停在资源不足时按约定留下的标记（t3-orchestrator「资源不足时」）：最后一条消息首行以它开头。
export const WAIT_MARK = "【等待资源】";

// c 是快照候选（含 prHealth 判定字段、waitingResources）；since 是上一轮快照时间（全量时为 null）；
// deviceFreed 表示这台设备的占用比上一轮少了（有线程结束，资源可能已释放）。
export function triageOf(c, { since, thresholds, now = Date.now(), deviceFreed = false, resourceWakeHours = 3 }) {
  const reasons = [];
  const s = since ? ms(since) : null;
  const after = (iso) => s !== null && ms(iso) > s;
  const overdue = (iso, minutes) => ms(iso) > 0 && now - ms(iso) >= minutes * 60000;
  const crossed = (iso, minutes) => {
    // 截止时间落在 (上一轮, 本轮] 之间：等待在两轮之间超时。
    const due = ms(iso) + minutes * 60000;
    return ms(iso) > 0 && due <= now && (s === null || due > s);
  };

  if (s === null) reasons.push("全量");
  // 交接是未销账的工作，不依赖来源消息变化或来源设备释放资源。
  if (c.pendingHandoff) reasons.push("待交接未销账");
  if (c.incomplete || c.error) reasons.push("取证失败");
  if (FAILED.has(c.status)) reasons.push("失败");
  if ((c.pendingRequestCount ?? 0) > 0) reasons.push("待答请求");
  if (QUEUED.has(c.status) && ms(c.lastRunEndedAt) && now - ms(c.lastRunEndedAt) > thresholds.queuedMinutes * 60000) reasons.push("排队超时");
  // 不论在跑还是停着：每次都白白丢掉一轮验证，上一轮以来出现过就叫醒。
  if (c.bgKills && (s === null || after(c.bgKills.lastAt))) reasons.push("后台进程随超时被杀");

  if (RUNNING.has(c.status)) {
    if ((c.recentToolCalls ?? 0) >= 10 && (c.distinctRecentCommands ?? 99) < thresholds.minDistinctCommands) reasons.push("疑似空转");
    if ((c.minutesSinceLastMessage ?? 0) > thresholds.silenceMinutes) reasons.push("消息沉默");
  } else if (!QUEUED.has(c.status)) {
    if (after(c.lastMsgAt) || after(c.lastRunEndedAt)) reasons.push("上轮后有新活动");
    const hasOpenPr = (c.prHealth ?? []).length > 0 || (c.prs ?? []).some((p) => /:open\b/.test(p));
    const lastActivity = Math.max(ms(c.lastMsgAt), ms(c.lastRunEndedAt));
    if (hasOpenPr && lastActivity > 0 && now - lastActivity >= thresholds.silenceMinutes * 60000) reasons.push("未结 PR 停驻超时");
    for (const h of c.prHealth ?? []) {
      if (after(h.latestAt) || after(h.headAt)) reasons.push(`${h.pr} 有新事件`);
      // 结论可能是 HEAD 上的 review，也可能是检查状态（审查服务常写成提交状态）。
      for (const ck of (h.checks ?? []).filter((x) => x.state === "pending")) {
        if (overdue(ck.at, thresholds.reviewWaitMinutes)) reasons.push(`${h.pr} ${ck.name} 久未出结论`);
      }
      if (!h.headReview && !(h.checks ?? []).length && overdue(h.headAt, thresholds.reviewWaitMinutes)) reasons.push(`${h.pr} HEAD 无审查与检查`);
    }
    if ((c.prs ?? []).some((p) => p.includes("(stale)"))) reasons.push("结论未消费");
    if ((c.prs ?? []).some((p) => p.includes("(health-unavailable)"))) reasons.push("PR 实况缺失");
    if (crossed(c.lastMsgAt, thresholds.idleQuestionMinutes) && /[？?]\s*$/.test(String(c.tail?.at(-1) ?? ""))) reasons.push("提问久未答");
    // 等资源的线程靠巡检叫醒：设备空出名额，或等待在两轮之间满 resourceWakeHours。
    if (c.waitingResources) {
      if (deviceFreed) reasons.push("设备空出名额，资源可能已释放");
      if (crossed(c.waitingResources.at, resourceWakeHours * 60)) reasons.push(`等待资源已满 ${resourceWakeHours} 小时`);
    }
  }

  // 久审本身不叫醒线程：M2 有重发窗口，上一轮已审计且没有新变化时再看一遍只是重复。有别的变化或全量时才一并审。
  if (c.needsConvergenceAudit && reasons.length) reasons.push("久审");
  const uniq = [...new Set(reasons)];
  if (uniq.length) return { triage: "hot", triageReasons: uniq };
  return { triage: "quiet", triageReasons: [RUNNING.has(c.status) || QUEUED.has(c.status) ? "在跑，信号正常" : c.waitingResources ? "等待资源" : "上轮后无变化"] };
}
