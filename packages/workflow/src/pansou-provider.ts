import { createHash } from "node:crypto";
import type {
  ResourceCandidate,
  ResourceSnapshot,
  ResourceType,
} from "./domain.js";
import type { ResourceProvider } from "./ports.js";

export interface PanSouFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export type PanSouFetchJson = (url: string, init: PanSouFetchInit) => Promise<unknown>;

export interface PanSouResourceProviderOptions {
  baseURL: string;
  fetchJson?: PanSouFetchJson;
  now?: () => string;
}

interface PanSouLinkFact {
  title: string;
  source: string;
  type: ResourceType;
  rawType: string;
  url: string;
  password: string;
  datetime: string;
}

export class PanSouResourceProvider implements ResourceProvider {
  private readonly baseURL: string;
  private readonly fetchJson: PanSouFetchJson;
  private readonly now: () => string;

  constructor(options: PanSouResourceProviderOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, "");
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async search(input: { keyword: string }): Promise<ResourceSnapshot> {
    const response = await this.fetchJson(`${this.baseURL}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "clawd-media-track/1.0",
      },
      body: JSON.stringify({ kw: input.keyword, res: "all" }),
    });
    const facts = isPanSouSuccessResponse(response) ? collectLinkFacts(response.data.results) : [];
    const snapshotId = createSnapshotId(input.keyword, facts);
    const candidates: ResourceCandidate[] = facts.map((fact, index) => ({
      id: `${snapshotId}_candidate_${index + 1}`,
      snapshotId,
      index,
      title: fact.title,
      type: fact.type,
      source: fact.source,
      episodeHints: extractEpisodeHints(fact.title),
      qualityHints: extractQualityHints(fact.title),
      providerPayload: {
        url: fact.url,
        password: fact.password,
        datetime: fact.datetime,
        rawType: fact.rawType,
      },
    }));

    return {
      id: snapshotId,
      provider: "pansou",
      keyword: input.keyword,
      candidates,
      createdAt: this.now(),
    };
  }
}

export function createPanSouResourceProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PanSouResourceProvider {
  const baseURL = env.PANSOU_BASE_URL;
  if (!baseURL) {
    throw new Error("PANSOU_BASE_URL is required to create PanSouResourceProvider");
  }
  return new PanSouResourceProvider({ baseURL });
}

async function defaultFetchJson(url: string, init: PanSouFetchInit): Promise<unknown> {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  if (!response.ok) {
    throw new Error(`PanSou search failed with HTTP ${response.status}`);
  }
  return response.json();
}

function isPanSouSuccessResponse(value: unknown): value is {
  code: 0;
  data: {
    results: unknown[];
  };
} {
  if (!isRecord(value) || value["code"] !== 0 || !isRecord(value["data"])) {
    return false;
  }
  return Array.isArray(value["data"]["results"]);
}

function collectLinkFacts(results: unknown[]): PanSouLinkFact[] {
  const facts: PanSouLinkFact[] = [];
  const seenUrls = new Set<string>();

  for (const result of results) {
    if (!isRecord(result)) {
      continue;
    }
    const title = stringValue(result["title"]);
    const source = stringValue(result["channel"]);
    const links = Array.isArray(result["links"]) ? result["links"] : [];
    for (const link of links) {
      if (!isRecord(link)) {
        continue;
      }
      const rawType = stringValue(link["type"]);
      const url = stringValue(link["url"]);
      const type = normalizeResourceType(rawType, url);
      if (!type || !url || seenUrls.has(url)) {
        continue;
      }
      seenUrls.add(url);
      facts.push({
        title,
        source,
        type,
        rawType,
        url,
        password: stringValue(link["password"]),
        datetime: stringValue(link["datetime"]),
      });
    }
  }

  return facts;
}

function normalizeResourceType(rawType: string, url: string): ResourceType | null {
  if (rawType === "115") {
    return "115";
  }
  if (url.startsWith("magnet:")) {
    return "magnet";
  }
  return null;
}

function extractEpisodeHints(text: string): string[] {
  const hints = new Set<string>();
  const seasonEpisodePattern = /[Ss](\d{1,2})[Ee](\d{1,3})/g;
  for (const match of text.matchAll(seasonEpisodePattern)) {
    const season = Number(match[1]);
    const episode = Number(match[2]);
    if (Number.isFinite(season) && Number.isFinite(episode)) {
      hints.add(`S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`);
    }
  }

  const chineseEpisodePattern = /第\s*(\d{1,3})\s*集/g;
  for (const match of text.matchAll(chineseEpisodePattern)) {
    const episode = Number(match[1]);
    if (Number.isFinite(episode)) {
      hints.add(`S01E${String(episode).padStart(2, "0")}`);
    }
  }

  return Array.from(hints);
}

function extractQualityHints(text: string): string[] {
  const hints = new Set<string>();
  const patterns = [
    /\b4K\b/i,
    /\b2160p\b/i,
    /\b1080p\b/i,
    /\b720p\b/i,
    /\bHDR\b/i,
    /\bDV\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      hints.add(match[0]);
    }
  }
  return Array.from(hints);
}

function createSnapshotId(keyword: string, facts: PanSouLinkFact[]): string {
  const material = JSON.stringify(
    facts.map((fact) => ({
      keyword,
      title: fact.title,
      type: fact.type,
      rawType: fact.rawType,
      url: fact.url,
      password: fact.password,
      datetime: fact.datetime,
      source: fact.source,
    })),
  );
  return `pansou_${createHash("sha1").update(material).digest("hex").slice(0, 12)}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
