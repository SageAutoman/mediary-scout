#!/usr/bin/env node
// Reset the dev DB's test DATA (media titles, tracked seasons, episodes,
// workflow runs, resource snapshots, decisions, transfer attempts, notifications,
// tmdb cache, ...) while PRESERVING app_settings — the 115 cookie + push config —
// so the user NEVER has to re-QR-login. Credentials are backed up first.
//
//   node scripts/reset-dev-db.mjs          # dry run: back up creds + show plan
//   node scripts/reset-dev-db.mjs --apply  # wipe data rows, keep app_settings

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.join(repoRoot, ".media-track-live-series.sqlite");
const PRESERVE = new Set(["app_settings"]);

const db = new DatabaseSync(dbPath);

// 1. Back up every setting (cookie, cookieMeta, push_*) to a gitignored file.
const settings = db.prepare("SELECT key, value FROM app_settings").all();
const backupPath = path.join(repoRoot, ".media-track-credentials-backup.json");
writeFileSync(backupPath, JSON.stringify({ savedAt: new Date().toISOString(), settings }, null, 2));
const cookie = settings.find((s) => s.key === "pan115.cookie");
console.log(
  `backed up ${settings.length} settings -> ${path.basename(backupPath)} ` +
    `(115 cookie: ${cookie ? "PRESENT len=" + String(cookie.value).length : "MISSING"})`,
);

// 2. Plan: every table except the preserved ones.
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((r) => r.name);
const toReset = tables.filter((t) => !PRESERVE.has(t));
console.log("\nall tables:", tables.join(", "));
console.log("will RESET:", toReset.join(", "));
console.log("will KEEP :", tables.filter((t) => PRESERVE.has(t)).join(", "));

const apply = process.argv.includes("--apply");
if (!apply) {
  console.log("\n(dry run) cookie backed up. pass --apply to wipe data rows.");
  db.close();
  process.exit(0);
}

// Full wipe — drop FK enforcement so parent/child delete order doesn't matter.
db.exec("PRAGMA foreign_keys = OFF");
for (const t of toReset) {
  const before = db.prepare(`SELECT count(*) AS c FROM "${t}"`).get().c;
  db.prepare(`DELETE FROM "${t}"`).run();
  console.log(`  reset ${t}: ${before} -> 0`);
}
db.exec("PRAGMA foreign_keys = ON");

const after = db.prepare("SELECT value FROM app_settings WHERE key='pan115.cookie'").get();
console.log(
  `\napp_settings preserved; 115 cookie still present: ${
    after ? "YES len=" + String(after.value).length : "MISSING (restore from backup!)"
  }`,
);
db.close();
