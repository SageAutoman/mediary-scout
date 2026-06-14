#!/usr/bin/env node
// Read-only: dump the raw 115 /files response keys + breadcrumb for a cid, to
// see whether /files alone carries the ancestor path (could replace category/get).
//   node scripts/probe-115-raw-files.mjs <cid>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new DatabaseSync(path.join(repoRoot, ".media-track-live-series.sqlite"));
const cookie = String(db.prepare("SELECT value FROM app_settings WHERE key = ?").get("pan115.cookie").value);
db.close();
const cid = process.argv[2];
const url = `https://webapi.115.com/files?aid=1&cid=${cid}&offset=0&limit=2&show_dir=1&format=json`;
const res = await fetch(url, { headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0" } });
const json = await res.json();
console.log("top-level keys:", Object.keys(json).join(", "));
console.log("echoed cid:", json.cid, "| count:", json.count);
console.log("path/breadcrumb:", JSON.stringify(json.path ?? json.paths ?? "(none)"));
