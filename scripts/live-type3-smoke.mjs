#!/usr/bin/env node
// Live Type 3 repair: reconcile an existing 115 landing directory against
// metadata, search ONLY for the actionable gaps through the planning agent,
// transfer, verify, persist. Scoped to the 115 test root.
//
// Usage:
//   node scripts/live-type3-smoke.mjs --tmdb 289271 --season 1 --dir <landingDirCid>

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
if (args.help || !args.dir) {
  console.log("Usage: node scripts/live-type3-smoke.mjs --dir <landingDirCid> [--tmdb 289271] [--season 1] [--quality 4K]");
  process.exit(args.help ? 0 : 1);
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
  createEpisodeStates,
  createPanSouResourceProviderFromEnv,
  createProtectedPan115CookieStorageExecutorFromEnv,
  createTmdbMetadataProviderFromEnv,
  createAgentNodesFromEnv,
  prepareTrackingTarget,
  runType3MonitoringAndPersist,
  SQLiteWorkflowRepository,
} = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));

const tmdbId = Number(args.tmdb ?? 289271);
const seasonNumber = Number(args.season ?? 1);
const quality = args.quality ?? "4K";
const landingDirectoryId = args.dir;

const storage = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });

console.log(`[1/4] preparing tracking target from TMDB tv/${tmdbId} season ${seasonNumber} ...`);
const target = await prepareTrackingTarget({
  tmdbId,
  mediaType: "tv",
  seasonNumber,
  qualityPreference: quality,
  storageDirectoryId: landingDirectoryId,
  metadataProvider: createTmdbMetadataProviderFromEnv(),
});
console.log("      title:", target.title.title, `(${target.title.year})`);
console.log(
  "      season: total =", target.season.totalEpisodes,
  "latestAired =", target.season.latestAiredEpisode,
  "keyword =", target.keyword,
);

console.log("[2/4] building metadata episode states (Type 3 will reconcile against storage) ...");
const episodes = createEpisodeStates({
  trackedSeasonId: target.season.id,
  seasonNumber: target.season.seasonNumber,
  totalEpisodes: target.season.totalEpisodes,
  latestAiredEpisode: target.season.latestAiredEpisode,
});

const dbPath = path.join(repoRoot, ".media-track-live-smoke-type3.sqlite");
const repository = new SQLiteWorkflowRepository(new DatabaseSync(dbPath));
const startedAt = new Date().toISOString();
const runId = `live_type3_${Date.now()}`;

console.log("[3/4] running Type 3 monitoring with live agent + PanSou + 115 ...");
const start = Date.now();
const result = await runType3MonitoringAndPersist({
  title: target.title,
  season: target.season,
  episodes,
  keyword: target.keyword,
  resourceProvider: createPanSouResourceProviderFromEnv(),
  storage,
  agents: createAgentNodesFromEnv(process.env),
  repository,
  workflowRun: { id: runId, startedAt, finishedAt: new Date().toISOString() },
});
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`[4/4] result (${elapsed}s)`);
console.log("      status:", result.status);
console.log("      obtained:", JSON.stringify(result.obtainedEpisodes));
console.log("      providerAhead:", JSON.stringify(result.providerAheadEpisodes));
console.log(
  "      transferAttempts:",
  JSON.stringify(
    result.transferAttempts.map((attempt) => ({
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
    result.decisions.map((decision) => ({
      snapshotId: decision.snapshotId,
      selected: decision.selectedCandidateIds,
      episodeMapping: decision.episodeMapping,
      confidence: decision.confidence,
      reason: decision.reason,
    })),
    null,
    2,
  ),
);
console.log("      notification:", JSON.stringify(result.notification));
console.log("      audit event types:", JSON.stringify(result.auditEvents.map((event) => event.type)));

const finalFiles = await storage.listVideoFiles(landingDirectoryId);
console.log(
  "      physical files now:",
  JSON.stringify(
    finalFiles
      .map((file) => ({ episode: file.episodeCode, name: file.name, sizeGB: (file.sizeBytes / 1e9).toFixed(2) }))
      .sort((a, b) => a.episode.localeCompare(b.episode)),
    null,
    2,
  ),
);
console.log("\ndone. landing directory:", landingDirectoryId, "db:", dbPath);
