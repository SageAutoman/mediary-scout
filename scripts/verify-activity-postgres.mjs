// Live-verify the NEW Postgres code paths the InMemory unit tests can't cover:
// updateWorkflowRunProgress (single-row JSONB write + monotonic clamp) and
// cancelQueuedWorkflowRun (deletes run + tracked_seasons + orphan media_titles →
// vanishes from the library). Uses a clearly-fake test title on the dev DB; cancel
// cleans it up. Does NOT run any agent / touch 115.
//   npm run build:workflow && node scripts/verify-activity-postgres.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./_lib/pan115-cookie.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv();
const conn =
  process.env.MEDIA_TRACK_POSTGRES_URL ?? "postgresql://mediatrack:mediatrack@localhost:5432/media_track";
const mod = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const repo = mod.createPostgresWorkflowRepositorySync({ connectionString: conn });

const stamp = Date.now();
const title = {
  id: `test_cancel_${stamp}`,
  tmdbId: 990000 + (stamp % 1000),
  type: "tv",
  title: `__ACTIVITY_TEST__ ${stamp}`,
  originalTitle: "test",
  year: 2026,
  aliases: [],
};
const season = {
  id: `${title.id}_s1`,
  mediaTitleId: title.id,
  seasonNumber: 1,
  status: "active",
  qualityPreference: "4K",
  storageDirectoryId: "",
  totalEpisodes: 12,
  latestAiredEpisode: 6,
  latestAiredSource: "metadata",
};

const reservation = await mod.queueTrackingInitialization({ title, season, keyword: "test", repository: repo });
const runId = reservation.workflowRunId;
console.log("queued:", reservation.status, "run:", runId);

// --- progress write + monotonic clamp ---
await repo.updateWorkflowRunProgress(runId, { activity: "正在转存到网盘…", phase: "transfer", percent: 40, updatedAt: "t1" });
await repo.updateWorkflowRunProgress(runId, { activity: "整理(回退测试)", phase: "organize", percent: 25, updatedAt: "t2" });
const snap = await repo.getWorkflowRunSnapshot(runId);
const p = snap?.workflowRun?.progress;
console.log("progress after writes:", JSON.stringify(p));
const progressOk = p && p.percent === 40 && p.activity === "整理(回退测试)";
console.log("progress clamp+text:", progressOk ? "OK" : "FAIL");

// --- present in library before cancel ---
const before = await repo.listTrackedSeasonStates();
const presentBefore = before.some((s) => s.season.id === season.id);
console.log("in library before cancel:", presentBefore);

// --- cancel removes run + tracking + orphan title ---
const cancelResult = await repo.cancelQueuedWorkflowRun(runId);
console.log("cancel:", cancelResult.status);
const after = await repo.listTrackedSeasonStates();
const presentAfter = after.some((s) => s.season.id === season.id);
const runGone = (await repo.getWorkflowRunSnapshot(runId)) === null;
console.log("run gone:", runGone, "| in library after cancel:", presentAfter);

const allOk = progressOk && presentBefore && cancelResult.status === "cancelled" && runGone && !presentAfter;
console.log("\n==> ALL OK:", allOk);
await repo.close?.();
process.exit(allOk ? 0 : 1);
