import { execFileSync } from "node:child_process";
const sha = /^[a-f0-9]{40}$/i;
function git(...args) { return execFileSync("git", args, { encoding: "utf8", timeout: 30000 }).trim(); }
function fail(message) { throw new Error(message); }
async function check() {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const candidate = process.env.CANDIDATE_SHA ?? "";
  const ciName = process.env.DEV_CI_WORKFLOW ?? "";
  const approved = process.env.DEV_E2E_APPROVED_SHA ?? "";
  const liveUrl = process.env.DEV_PUBLIC_HEALTH_URL ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo) || !sha.test(candidate) || !token || !ciName) fail("Invalid release inputs");
  git("fetch", "--no-tags", "origin", "develop");
  const devSha = git("rev-parse", "FETCH_HEAD");
  if (!sha.test(devSha)) fail("DEV HEAD is invalid");
  git("fetch", "--no-tags", "origin", candidate);
  try { git("merge-base", "--is-ancestor", devSha, candidate); }
  catch { fail("Candidate is not descended from current tested DEV"); }
  if (approved !== devSha) fail("Missing DEV E2E acceptance for exact DEV commit");
  if (!/^https:\/\//i.test(liveUrl)) fail("Missing public HTTPS DEV health URL");
  const health = await fetch(liveUrl, { signal: AbortSignal.timeout(15000) });
  if (health.status !== 200) fail("DEV live health HTTP " + health.status);
  const liveSha = (health.headers.get("x-cst-commit-sha") || health.headers.get("x-deploy-sha") || "").trim();
  if (liveSha !== devSha) fail("DEV live SHA differs from tested develop HEAD");
  const response = await fetch("https://api.github.com/repos/" + repo + "/actions/runs?branch=develop&head_sha=" + devSha + "&per_page=100", {
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) fail("GitHub DEV evidence unavailable: " + response.status);
  const runs = (await response.json()).workflow_runs || [];
  if (!runs.some(r => r.name === ciName && r.head_sha === devSha && r.head_branch === "develop" && r.status === "completed" && r.conclusion === "success" && ["push","workflow_dispatch"].includes(r.event))) {
    fail("Required CI not green at exact DEV SHA: " + ciName);
  }
  console.log("DEV_FIRST_PROMOTION=PASS candidate=" + candidate + " dev=" + devSha);
}
check().catch(e => { console.error("DEV_FIRST_PROMOTION=BLOCKED " + e.message); process.exitCode = 1; });
