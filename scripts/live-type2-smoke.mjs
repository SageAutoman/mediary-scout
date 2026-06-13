#!/usr/bin/env node
// Full live Type 2 chain: queue -> worker -> planning agent (real Mimo)
// -> real PanSou search -> real 115 share receive, scoped to the 115 test
// root. Never touches clawd-media. Run `npm run build:workflow` first.
//
// Usage:
//   node scripts/live-type2-smoke.mjs --tmdb 289271 --season 1

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") {
      args.help = true;
      continue;
    }
    if (!key.startsWith("--")) {
      continue;
    }
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

function loadDotEnv(envPath) {
  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node scripts/live-type2-smoke.mjs --tmdb <id> [--season 1] [--quality 4K]");
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv(path.join(repoRoot, ".env"));

for (const key of ["AGENT_MODEL_API_KEY", "PANSOU_BASE_URL", "PAN115_COOKIE", "TMDB_READ_TOKEN", "MEDIA_TRACK_115_TEST_ROOT_CID"]) {
  if (!process.env[key]) {
    console.error(`${key} is not set. Aborting.`);
    process.exit(1);
  }
}

const {
  createPanSouResourceProviderFromEnv,
  createProtectedPan115CookieStorageExecutorFromEnv,
  createTmdbMetadataProviderFromEnv,
  createAgentNodesFromEnv,
  prepareTrackingTarget,
  queueTrackingInitialization,
  runQueuedType2Workflow,
  SQLiteWorkflowRepository,
} = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));

const tmdbId = Number(args.tmdb ?? 289271);
const seasonNumber = Number(args.season ?? 1);
const quality = args.quality ?? "4K";
const testRoot = process.env.MEDIA_TRACK_115_TEST_ROOT_CID;

const storage = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
console.log(`[1/5] creating landing directory under 115 test root ${testRoot} ...`);
const landingDirectoryId = await storage.createDirectory({
  name: `live-type2-${tmdbId}-s${seasonNumber}-${stamp}`,
  parentId: testRoot,
});
console.log("      landing directory:", landingDirectoryId);

console.log(`[2/5] preparing tracking target from TMDB tv/${tmdbId} season ${seasonNumber} ...`);
const target = await prepareTrackingTarget({
  tmdbId,
  mediaType: "tv",
  seasonNumber,
  qualityPreference: quality,
  storageDirectoryId: landingDirectoryId,
  metadataProvider: createTmdbMetadataProviderFromEnv(),
});
console.log("      title:", target.title.title, `(${target.title.year})`, "aliases:", target.title.aliases);
console.log(
  "      season: total =", target.season.totalEpisodes,
  "latestAired =", target.season.latestAiredEpisode,
  "keyword =", target.keyword,
);

const dbPath = path.join(repoRoot, ".media-track-live-smoke.sqlite");
const repository = new SQLiteWorkflowRepository(new DatabaseSync(dbPath));

console.log("[3/5] queueing tracking initialization ...");
const queued = await queueTrackingInitialization({
  title: target.title,
  season: target.season,
  keyword: target.keyword,
  repository,
});
console.log("      request status:", queued.status, "workflowRunId:", queued.workflowRunId);

console.log("[4/5] running queued Type 2 workflow with live agent + PanSou + 115 ...");
const startedAt = Date.now();
const result = await runQueuedType2Workflow({
  repository,
  resourceProvider: createPanSouResourceProviderFromEnv(),
  storage,
  agents: createAgentNodesFromEnv(process.env),
});
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`      worker result (${elapsed}s):`, JSON.stringify(result));

console.log("[5/5] verifying persisted run and physical files ...");
if (result.status === "ran") {
  const snapshot = await repository.getWorkflowRunSnapshot(result.workflowRunId);
  console.log("      workflow status:", snapshot?.workflowRun.status);
  console.log("      obtained episodes:", JSON.stringify(snapshot?.obtainedEpisodes ?? []));
  console.log(
    "      transfer attempts:",
    JSON.stringify(
      (snapshot?.transferAttempts ?? []).map((attempt) => ({
        candidateId: attempt.candidateId,
        status: attempt.status,
        message: attempt.providerMessage,
      })),
      null,
      2,
    ),
  );
  console.log(
    "      decisions:",
    JSON.stringify(
      (snapshot?.decisions ?? []).map((decision) => ({
        node: decision.node,
        snapshotId: decision.snapshotId,
        selected: decision.selectedCandidateIds,
        confidence: decision.confidence,
        reason: decision.reason,
      })),
      null,
      2,
    ),
  );
  const notifications = snapshot?.notifications ?? [];
  console.log("      notification:", JSON.stringify(notifications.at(-1) ?? null));
  const auditTypes = (snapshot?.workflowRun.auditEvents ?? []).map((event) => event.type);
  console.log("      audit event types:", JSON.stringify(auditTypes));
}
const finalFiles = await storage.listVideoFiles(landingDirectoryId);
console.log(
  "      physical files in landing directory:",
  JSON.stringify(
    finalFiles.map((file) => ({ name: file.name, episode: file.episodeCode, sizeGB: (file.sizeBytes / 1e9).toFixed(2) })),
    null,
    2,
  ),
);
console.log("\ndone. landing directory:", landingDirectoryId, "db:", dbPath);
