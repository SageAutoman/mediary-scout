#!/usr/bin/env node
// Read-only: report whether a 115 cid is alive and resolves to itself, or is
// gone (silently falls back to the account root). Usage:
//   node scripts/probe-115-resolve.mjs <cid> [<cid> ...]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const line of readFileSync(path.join(repoRoot, ".env"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i < 0) continue;
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
  process.env[t.slice(0, i).trim()] = v;
}
const db = new DatabaseSync(path.join(repoRoot, ".media-track-live-series.sqlite"));
const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("pan115.cookie");
db.close();
if (row && row.value) process.env.PAN115_COOKIE = String(row.value);
const { createPan115CookieClientFromEnv } = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const client = createPan115CookieClientFromEnv(process.env);
for (const cid of process.argv.slice(2)) {
  const info = await client.getDirectoryInfo({ directoryId: cid });
  const leaf = info?.path?.[info.path.length - 1];
  console.log(`${cid}: state=${info?.state} leaf=${JSON.stringify(leaf)} -> ${info?.state && String(leaf?.cid) === cid ? "ALIVE (resolves to itself)" : "GONE / not-found"}`);
}
