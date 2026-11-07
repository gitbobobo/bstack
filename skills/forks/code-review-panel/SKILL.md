---
name: code-review-panel
description: "Before pushing a non-trivial change, spawn read-only subagents on two different model families to adversarially review the same diff in parallel, then merge the findings yourself. Use for \"multi-model review\", \"adversarial review\", \"challenge this\", or a pre-push review of a large or risky diff — not for small or low-risk changes, which don't justify the cost of a panel. Once a PR exists, cloud bot feedback is handled by `pr-review-loop`, not this skill."
---

# Code Review Panel

Use two reviewers for high-risk changes (concurrency, cancellation, playback, security, or public interfaces). Small changes stay with the lead; routine changes needing independent review use one reviewer from a different family. Spawn one reviewer per selected model to adversarially review code changes. Each model gets the same prompt and rubric. The adversarial signal comes from model diversity, not assigned personas.

The deliverable is a synthesized verdict. Do NOT auto-apply changes.

## Step 1, Determine Scope

Identify what to review from context:

- If the user points at specific files or a diff, use that
- If on a feature branch, run `git diff main...HEAD` (or the appropriate base branch) for the full changeset
- If the user's message references recent work, gather the relevant files

Package the diff (or file contents) plus any surrounding context files the reviewers need to understand the code.

## Step 2, State the Intent

Before spawning reviewers, state the intent explicitly. Derive this from:

- The user's message
- Commit messages
- PR description if one exists
- The code itself

Write one clear paragraph. If you're unsure about the intent, ask the user before proceeding.

## Step 3, Spawn Reviewers

Pick reviewer models with the `t3-orchestrator` skill's `route.mjs select --task review`; pick the second with `--exclude-model <first reviewer's model=>` so the panel spans two different models, not one model on two harnesses. The same filled template goes to all reviewers, so every model applies the code-quality lens.

Reviewers read code and existing raw evidence by default. Route requests for heavy checks through the single final verification owner; reviewers do not start duplicate builds. Dispatch each reviewer as a read-only subagent — via the t3-code MCP `delegate_task`, or the harness's own read-only subagent mechanism for work that runs no commands.

If a model is unavailable or its run fails, follow the re-routing rules in `t3-orchestrator` — do not invent a separate fallback chain here.

Read `references/reviewer-prompt.md` and fill in the template with:
1. The stated intent
2. The diff or file contents
3. The review rubric from `references/rubric.md`
4. The code-quality lens from `references/code-quality-review.md`
5. Raw evidence paths and source state, the final verification owner, and prior findings/responses/unresolved objections plus the changed scope (or mark the first round).

A qualifying panel is the final local review for that round; do not add another reviewer for the same diff. Follow-up rounds review repaired findings, changed scope, and related regressions, expanding only for new risk. Pass the original intent, prior findings, responses, and unresolved objections in full. In T3, create a fresh `delegate_task` for every round with a distinct clientRequestId (stable on retries), retain its taskId, and use async completion events.

## Step 4, Synthesize

As results come back, build a unified picture:

1. **Parse all findings** from the reviewers
2. **Identify consensus**. Findings raised by 2+ models independently are highest signal.
3. **Identify lone-model findings**. Still worth reading, but weight accordingly.
4. **Deduplicate**. Different models may describe the same issue differently. Merge these and note which models raised it.
5. **Note disagreements**. If one model flags something and another explicitly says the opposite, that's useful context for the verdict.

## Step 5, Lead Judgment

You are the lead reviewer, a pragmatic senior engineer, not a neutral aggregator.

Read `references/lead-judgment.md` for the full framework.

Categorize every finding using these buckets:

- **Act on**. Real issues affecting correctness, security, or maintainability given the actual goals. These would block a real PR.
- **Consider**. Legitimate points, but you're not sure they outweigh the cost of addressing them right now. Worth the user's attention.
- **Noted**. Technically valid but not actionable. Context-dependent, premature optimization, or low-impact given the current stage.
- **Dismissed**. Wrong, nitpicky, or missing context. Brief explanation why.

For each finding, include:
- Which model(s) raised it
- The category (act on / consider / noted / dismissed)
- A one-line rationale for the categorization

## Division of labor with pr-review-loop

This skill runs before the push, while the change is still local. Once a PR exists, repeat local panels only at the user’s request or when the change materially expands risk. Review comments left on the PR by review bots are handled by the convergence rules in `pr-review-loop`.

## Output Format

Present the verdict in this structure:

### Intent
> [The stated intent paragraph from Step 2]

### Reviewers
- Reviewer [label]: [model name], [N findings] (one bullet per reviewer)

### Act On
[Findings that should be addressed. For each: description, which models raised it, why it matters.]

### Consider
[Findings worth thinking about. For each: description, which models raised it, tradeoff involved.]

### Noted
[Valid but low-priority. Brief list.]

### Dismissed
[Rejected findings with brief rationale.]

### Agreement Map
[Where did models agree, where did they diverge, and what does the pattern of agreement/disagreement tell us?]
