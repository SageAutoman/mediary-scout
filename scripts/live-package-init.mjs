#!/usr/bin/env node
// Live series package initialization: normalize a complete-series pack
// already sitting in a 115 staging directory (inside the test root) into
// canonical `Title (Year)/Season N/`, verify per season, persist tracked
// seasons. Rejected files stay in staging; nothing is ever deleted.
//
// Usage:
//   node scripts/live-package-init.mjs --tmdb 1396 --staging <cid> --seasons 5

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

function loadDotEnv(envPath) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.tmdb || !args.staging) {
  console.log("Usage: node scripts/live-package-init.mjs --tmdb <id> --staging <cid> [--seasons 5] [--quality 4K]");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv(path.join(repoRoot, ".env"));

for (const key of ["AGENT_MODEL_API_KEY", "PAN115_COOKIE", "TMDB_READ_TOKEN", "MEDIA_TRACK_115_TEST_ROOT_CID"]) {
  if (!process.env[key]) {
    console.error(`${key} is not set. Aborting.`);
    process.exit(1);
  }
}

const {
  createProtectedPan115CookieStorageExecutorFromEnv,
  createTmdbMetadataProviderFromEnv,
  createAgentNodesFromEnv,
  prepareTrackingTarget,
  runSeriesPackageInitializationAndPersist,
  SQLiteWorkflowRepository,
} = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));

const tmdbId = Number(args.tmdb);
const seasonCount = Number(args.seasons ?? 5);
const metadataProvider = createTmdbMetadataProviderFromEnv();

console.log(`[1/4] fetching TMDB metadata for tv/${tmdbId}, seasons 1..${seasonCount} ...`);
let title = null;
const seasons = [];
for (let n = 1; n <= seasonCount; n += 1) {
  const target = await prepareTrackingTarget({
    tmdbId,
    mediaType: "tv",
    seasonNumber: n,
    qualityPreference: args.quality ?? "4K",
    metadataProvider,
  });
  title ??= target.title;
  seasons.push({
    seasonNumber: n,
    totalEpisodes: target.season.totalEpisodes,
    latestAiredEpisode: target.season.latestAiredEpisode,
  });
  console.log(`      S${n}: total=${target.season.totalEpisodes} latestAired=${target.season.latestAiredEpisode}`);
}
console.log("      title:", title.title, `(${title.year})`);

const storage = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });
const repository = new SQLiteWorkflowRepository(
  new DatabaseSync(path.join(repoRoot, ".media-track-live-package.sqlite")),
);

console.log(`[2/4] running series package initialization from staging ${args.staging} ...`);
const startedAt = new Date().toISOString();
const start = Date.now();
const result = await runSeriesPackageInitializationAndPersist({
  title,
  seasons,
  stagingDirectoryId: args.staging,
  storageParentDirectoryId: process.env.MEDIA_TRACK_115_TEST_ROOT_CID,
  storage,
  agents: createAgentNodesFromEnv(process.env),
  repository,
  workflowRun: { id: `live_pack_${Date.now()}`, startedAt, finishedAt: new Date().toISOString() },
});
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`[3/4] result (${elapsed}s)`);
console.log("      status:", result.status);
for (const seasonResult of result.seasons) {
  console.log(
    `      S${seasonResult.season.seasonNumber}: obtained ${seasonResult.obtainedEpisodes.length}/${seasonResult.season.totalEpisodes} -> dir ${seasonResult.season.storageDirectoryId}`,
  );
}
console.log(
  "      rejected (stay in staging):",
  JSON.stringify(result.rejectedFiles.map((file) => ({ path: file.sourcePath, reason: file.reason })), null, 2),
);
console.log("      warnings:", JSON.stringify(result.warnings));
console.log("      notification:", result.notification.body);
console.log("      audit:", JSON.stringify(result.auditEvents.map((event) => event.type)));

console.log("[4/4] verifying staging remainder ...");
const remainder = await storage.listTree({ directoryId: args.staging });
console.log(
  `      staging now has ${remainder.length} files:`,
  JSON.stringify(remainder.map((file) => file.path), null, 2),
);
console.log("\ndone.");
