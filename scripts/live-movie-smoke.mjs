#!/usr/bin/env node
// Full live movie acquisition chain: prepare from TMDB -> queue -> worker
// -> movie planning agent (real Mimo) -> real PanSou search -> real 115 share
// receive into a Movies dir under the 115 TEST ROOT. Never touches clawd-media.
// Run `npm run build:workflow` first.
//
// Usage:
//   node scripts/live-movie-smoke.mjs --tmdb 872585          # 奥本海默 (2023)
//   node scripts/live-movie-smoke.mjs --tmdb <movieId> --quality 1080p

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
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node scripts/live-movie-smoke.mjs --tmdb <movieId> [--quality 4K]");
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
  prepareMovieTarget,
  queueMovieAcquisition,
  runQueuedMovieAcquisition,
  SQLiteWorkflowRepository,
} = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));

const tmdbId = Number(args.tmdb ?? 872585);
const quality = args.quality ?? "4K";
// Movies land directly under the 115 test root for this smoke (never clawd-media).
const moviesParent = process.env.MEDIA_TRACK_MOVIES_PARENT_CID ?? process.env.MEDIA_TRACK_115_TEST_ROOT_CID;

const storage = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });

console.log(`[1/4] preparing movie target from TMDB movie/${tmdbId} ...`);
const target = await prepareMovieTarget({
  tmdbId,
  qualityPreference: quality,
  metadataProvider: createTmdbMetadataProviderFromEnv(),
});
console.log("      title:", target.title.title, `(${target.title.year})`, "type:", target.title.type, "keyword:", target.keyword);

const dbPath = path.join(repoRoot, ".media-track-live-smoke.sqlite");
const repository = new SQLiteWorkflowRepository(new DatabaseSync(dbPath));

console.log("[2/4] queueing movie acquisition ...");
const queued = await queueMovieAcquisition({ title: target.title, keyword: target.keyword, repository });
console.log("      request status:", queued.status, "workflowRunId:", queued.workflowRunId);

console.log("[3/4] running queued movie workflow with live agent + PanSou + 115 (test root) ...");
const startedAt = Date.now();
const result = await runQueuedMovieAcquisition({
  repository,
  resourceProvider: createPanSouResourceProviderFromEnv(),
  storage,
  agents: createAgentNodesFromEnv(process.env),
  stagingParentDirectoryId: moviesParent,
  moviesParentDirectoryId: moviesParent,
});
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`      worker result (${elapsed}s):`, JSON.stringify(result));

console.log("[4/4] verifying persisted run and physical files ...");
if (result.status === "ran") {
  const snapshot = await repository.getWorkflowRunSnapshot(result.workflowRunId);
  console.log("      workflow status:", snapshot?.workflowRun.status);
  console.log(
    "      searched keywords:",
    JSON.stringify([...new Set((snapshot?.resourceSnapshots ?? []).map((s) => s.keyword))]),
  );
  console.log(
    "      decisions:",
    JSON.stringify((snapshot?.decisions ?? []).map((d) => ({ selected: d.selectedCandidateIds, reason: d.reason }))),
  );
  console.log(
    "      transferAttempts:",
    JSON.stringify(
      (snapshot?.transferAttempts ?? []).map((t) => ({
        candidateId: t.candidateId,
        status: t.status,
        msg: t.providerMessage,
        materialized: t.materializedFileIds.length,
      })),
    ),
  );
  const movieDir = snapshot?.season.storageDirectoryId ?? "";
  console.log("      movie directory:", movieDir || "(none — no_coverage)");
  if (movieDir) {
    const landed = await storage.listVideoFiles(movieDir);
    console.log("      landed videos:", JSON.stringify(landed.map((f) => f.name)));
  }
  console.log("      notification:", snapshot?.notifications?.[0]?.body);
}
