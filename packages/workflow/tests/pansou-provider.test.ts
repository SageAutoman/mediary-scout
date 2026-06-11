import { describe, expect, it } from "vitest";
import { PanSouResourceProvider } from "../src/index.js";

describe("PanSouResourceProvider", () => {
  it("maps PanSou 115 and magnet links into a resource snapshot", async () => {
    const provider = new PanSouResourceProvider({
      baseURL: "https://pansou.example",
      now: () => "2026-06-11T00:00:00.000Z",
      fetchJson: async (url, init) => {
        expect(url).toBe("https://pansou.example/api/search");
        expect(init).toMatchObject({
          method: "POST",
          body: JSON.stringify({ kw: "翘楚 4K", res: "all" }),
        });
        return {
          code: 0,
          data: {
            results: [
              {
                title: "翘楚 S01E01 4K",
                channel: "telegram-a",
                links: [
                  {
                    type: "115",
                    url: "https://115.com/s/abc",
                    password: "pw1",
                    datetime: "2026-06-11",
                  },
                  {
                    type: "magnet",
                    url: "magnet:?xt=urn:btih:abc",
                  },
                ],
              },
              {
                title: "翘楚 第2集 1080p",
                channel: "telegram-b",
                links: [
                  {
                    type: "115",
                    url: "https://115.com/s/def",
                  },
                  {
                    type: "115",
                    url: "https://115.com/s/def",
                  },
                ],
              },
            ],
          },
        };
      },
    });

    const snapshot = await provider.search({ keyword: "翘楚 4K" });

    expect(snapshot).toMatchObject({
      id: "pansou_98b071819f50",
      provider: "pansou",
      keyword: "翘楚 4K",
      createdAt: "2026-06-11T00:00:00.000Z",
    });
    expect(snapshot.candidates).toEqual([
      expect.objectContaining({
        id: "pansou_98b071819f50_candidate_1",
        snapshotId: "pansou_98b071819f50",
        index: 0,
        title: "翘楚 S01E01 4K",
        type: "115",
        source: "telegram-a",
        episodeHints: ["S01E01"],
        qualityHints: ["4K"],
        providerPayload: {
          url: "https://115.com/s/abc",
          password: "pw1",
          datetime: "2026-06-11",
          rawType: "115",
        },
      }),
      expect.objectContaining({
        id: "pansou_98b071819f50_candidate_2",
        index: 1,
        title: "翘楚 S01E01 4K",
        type: "magnet",
        episodeHints: ["S01E01"],
        qualityHints: ["4K"],
        providerPayload: {
          url: "magnet:?xt=urn:btih:abc",
          password: "",
          datetime: "",
          rawType: "magnet",
        },
      }),
      expect.objectContaining({
        id: "pansou_98b071819f50_candidate_3",
        index: 2,
        title: "翘楚 第2集 1080p",
        type: "115",
        source: "telegram-b",
        episodeHints: ["S01E02"],
        qualityHints: ["1080p"],
      }),
    ]);
  });

  it("returns an empty snapshot when PanSou reports a non-zero code", async () => {
    const provider = new PanSouResourceProvider({
      baseURL: "https://pansou.example",
      now: () => "2026-06-11T00:00:00.000Z",
      fetchJson: async () => ({ code: 400, message: "bad request" }),
    });

    const snapshot = await provider.search({ keyword: "翘楚" });

    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.provider).toBe("pansou");
    expect(snapshot.keyword).toBe("翘楚");
  });
});
