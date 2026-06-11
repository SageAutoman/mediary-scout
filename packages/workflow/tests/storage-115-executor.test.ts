import { describe, expect, it } from "vitest";
import {
  Storage115Executor,
  type Pan115ActionResult,
  type Pan115DirectoryInfo,
  type Pan115Item,
  type Pan115StorageApi,
  type ResourceCandidate,
} from "../src/index.js";

describe("Storage115Executor", () => {
  it("transfers a selected 115 candidate and verifies newly materialized video files", async () => {
    const api = new FakePan115Api({
      shareFiles: {
        abc123: [
          {
            fid: "file_1",
            n: "Show.S01E01.mkv",
            s: "1000000000",
          },
        ],
      },
    });
    const executor = new Storage115Executor({ api });

    const attempt = await executor.transfer({
      workflowRunId: "run_1",
      directoryId: "123",
      candidate: candidateFixture({
        type: "115",
        providerPayload: {
          url: "https://115.com/s/abc123?password=pw",
          rawType: "115",
        },
      }),
    });

    expect(api.receivedShares).toEqual([
      {
        shareCode: "abc123",
        receiveCode: "pw",
        directoryId: "123",
      },
    ]);
    expect(attempt).toMatchObject({
      workflowRunId: "run_1",
      candidateId: "candidate_1",
      status: "succeeded",
      providerMessage: "",
      materializedFileIds: ["file_1"],
    });
    await expect(executor.listVideoFiles("123")).resolves.toEqual([
      {
        id: "file_1",
        storageDirectoryId: "123",
        name: "Show.S01E01.mkv",
        sizeBytes: 1_000_000_000,
        episodeCode: "S01E01",
        providerFileId: "file_1",
      },
    ]);
  });

  it("records duplicate 115 transfers as no target change", async () => {
    const api = new FakePan115Api({
      receiveShareResults: {
        abc123: {
          ok: false,
          message: "资源已转存过(可能在其他目录)，目标目录未新增文件",
          alreadyTransferred: true,
        },
      },
    });
    const executor = new Storage115Executor({ api });

    const attempt = await executor.transfer({
      workflowRunId: "run_1",
      directoryId: "123",
      candidate: candidateFixture({
        type: "115",
        providerPayload: {
          url: "https://115.com/s/abc123?password=pw",
          rawType: "115",
        },
      }),
    });

    expect(attempt).toMatchObject({
      candidateId: "candidate_1",
      status: "no_target_change",
      providerMessage: "资源已转存过(可能在其他目录)，目标目录未新增文件",
      materializedFileIds: [],
    });
  });

  it("adds magnet candidates as offline tasks through 115", async () => {
    const api = new FakePan115Api();
    const executor = new Storage115Executor({ api });

    const attempt = await executor.transfer({
      workflowRunId: "run_1",
      directoryId: "123",
      candidate: candidateFixture({
        type: "magnet",
        providerPayload: {
          url: "magnet:?xt=urn:btih:abcdef",
          rawType: "magnet",
        },
      }),
    });

    expect(api.offlineTasks).toEqual([
      {
        url: "magnet:?xt=urn:btih:abcdef",
        directoryId: "123",
      },
    ]);
    expect(attempt).toMatchObject({
      status: "no_target_change",
      providerMessage: "offline task accepted; no target video materialized yet",
      materializedFileIds: [],
    });
  });

  it("rejects flattening protected directories", async () => {
    const executor = new Storage115Executor({
      api: new FakePan115Api(),
      protectedDirectoryIds: ["0", "tv_root"],
    });

    await expect(executor.flattenDirectory("tv_root")).rejects.toThrow(
      "SAFETY_VIOLATION: refusing to flatten protected directory cid=tv_root",
    );
  });

  it("moves nested videos to a safe season leaf and removes empty child folders", async () => {
    const api = new FakePan115Api({
      directories: {
        season_1: [
          {
            cid: "nested_1",
            n: "Pack",
            fc: "0",
          },
        ],
        nested_1: [
          {
            fid: "nested_file_1",
            n: "Show.S01E02.mkv",
            s: "2000000000",
          },
        ],
      },
      directoryInfo: {
        season_1: {
          state: true,
          path: [
            { cid: "0", name: "root" },
            { cid: "tv_root", name: "TV Shows" },
            { cid: "show_1", name: "Show" },
            { cid: "season_1", name: "Season 1" },
          ],
        },
      },
    });
    const executor = new Storage115Executor({ api, protectedDirectoryIds: ["0", "tv_root"] });

    const result = await executor.flattenDirectory("season_1");

    expect(api.moves).toEqual([
      {
        fileIds: ["nested_file_1"],
        targetDirectoryId: "season_1",
      },
    ]);
    expect(api.deletes).toEqual([
      {
        fileIds: ["nested_1"],
      },
    ]);
    expect(result).toEqual({
      moved: ["nested_file_1"],
      removed: ["nested_1"],
    });
  });
});

class FakePan115Api implements Pan115StorageApi {
  readonly directories: Record<string, Pan115Item[]>;
  readonly shareFiles: Record<string, Pan115Item[]>;
  readonly receiveShareResults: Record<string, Pan115ActionResult>;
  readonly directoryInfo: Record<string, Pan115DirectoryInfo>;
  readonly receivedShares: Array<{ shareCode: string; receiveCode: string; directoryId: string }> = [];
  readonly offlineTasks: Array<{ url: string; directoryId: string }> = [];
  readonly moves: Array<{ fileIds: string[]; targetDirectoryId: string }> = [];
  readonly deletes: Array<{ fileIds: string[] }> = [];
  private nextFolder = 1;

  constructor(input: {
    directories?: Record<string, Pan115Item[]>;
    shareFiles?: Record<string, Pan115Item[]>;
    receiveShareResults?: Record<string, Pan115ActionResult>;
    directoryInfo?: Record<string, Pan115DirectoryInfo>;
  } = {}) {
    this.directories = cloneDirectories(input.directories ?? {});
    this.shareFiles = cloneDirectories(input.shareFiles ?? {});
    this.receiveShareResults = { ...(input.receiveShareResults ?? {}) };
    this.directoryInfo = { ...(input.directoryInfo ?? {}) };
  }

  async createFolder(input: { name: string; parentId: string }): Promise<string> {
    const id = `${input.parentId}_${input.name}_${this.nextFolder}`;
    this.nextFolder += 1;
    this.directories[id] = [];
    return id;
  }

  async listItems(input: { directoryId: string }): Promise<Pan115Item[]> {
    return [...(this.directories[input.directoryId] ?? [])];
  }

  async getDirectoryInfo(input: { directoryId: string }): Promise<Pan115DirectoryInfo | null> {
    return this.directoryInfo[input.directoryId] ?? {
      state: true,
      path: [
        { cid: "0", name: "root" },
        { cid: input.directoryId, name: "Season 1" },
      ],
    };
  }

  async receiveShare(input: {
    shareCode: string;
    receiveCode: string;
    directoryId: string;
  }): Promise<Pan115ActionResult> {
    this.receivedShares.push({ ...input });
    const configuredResult = this.receiveShareResults[input.shareCode];
    if (configuredResult) {
      return configuredResult;
    }
    const files = this.shareFiles[input.shareCode] ?? [];
    this.directories[input.directoryId] = [...(this.directories[input.directoryId] ?? []), ...files];
    return { ok: true, message: "" };
  }

  async addOfflineTask(input: { url: string; directoryId: string }): Promise<Pan115ActionResult> {
    this.offlineTasks.push({ ...input });
    return { ok: true, message: "offline task accepted" };
  }

  async moveItems(input: { fileIds: string[]; targetDirectoryId: string }): Promise<Pan115ActionResult> {
    this.moves.push({ fileIds: [...input.fileIds], targetDirectoryId: input.targetDirectoryId });
    const movedItems: Pan115Item[] = [];
    const wantedFileIds = new Set(input.fileIds);
    for (const [directoryId, items] of Object.entries(this.directories)) {
      const remaining: Pan115Item[] = [];
      for (const item of items) {
        const fileId = String(item.fid ?? item.file_id ?? item.id ?? "");
        if (wantedFileIds.has(fileId)) {
          movedItems.push(item);
        } else {
          remaining.push(item);
        }
      }
      this.directories[directoryId] = remaining;
    }
    this.directories[input.targetDirectoryId] = [
      ...(this.directories[input.targetDirectoryId] ?? []),
      ...movedItems,
    ];
    return { ok: true, message: "" };
  }

  async deleteItems(input: { fileIds: string[] }): Promise<Pan115ActionResult> {
    this.deletes.push({ fileIds: [...input.fileIds] });
    return { ok: true, message: "" };
  }
}

function candidateFixture(input: {
  type: ResourceCandidate["type"];
  providerPayload: Record<string, unknown>;
}): ResourceCandidate {
  return {
    id: "candidate_1",
    snapshotId: "snapshot_1",
    index: 0,
    title: "Show S01E01",
    type: input.type,
    source: "pansou",
    episodeHints: ["S01E01"],
    qualityHints: ["4K"],
    providerPayload: input.providerPayload,
  };
}

function cloneDirectories(input: Record<string, Pan115Item[]>): Record<string, Pan115Item[]> {
  return Object.fromEntries(
    Object.entries(input).map(([directoryId, items]) => [
      directoryId,
      items.map((item) => ({ ...item })),
    ]),
  );
}
