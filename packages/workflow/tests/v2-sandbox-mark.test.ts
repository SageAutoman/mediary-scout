import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";

async function setupWithSeasonFile() {
  const provider = new FakeResourceProviderV2({
    results: { show: [{ id: "cand", title: "Show", episodeHints: [], qualityHints: [] }] },
  });
  const storage = new Storage115Simulator({ packs: { cand: { files: [{ path: "Show - 01.mkv", sizeBytes: 1 }] } } });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({ provider, storage, stagingDirectoryId, targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId } });
  const search = await sandbox.searchResources("show");
  const transfer = await sandbox.transferCandidate({ snapshotId: search.snapshot!.id, candidateId: "cand" });
  const moved = await sandbox.moveToSeason({ fileIds: transfer.staging.map((f) => f.id), season: 1 });
  return { sandbox, seasonFileId: moved.season[0]!.id };
}

describe("TaskSandbox — markObtained (§12: fresh reread, files exist now)", () => {
  it("marks an episode obtained when its backing file is present in the season dir now", async () => {
    const { sandbox, seasonFileId } = await setupWithSeasonFile();

    const result = await sandbox.markObtained({ episodes: [{ code: "S01E01", fileId: seasonFileId }] });

    expect(result.confirmed.map((e) => e.code)).toEqual(["S01E01"]);
  });

  it("refuses to mark an episode whose backing file is not in the season dir (no DB lying)", async () => {
    const { sandbox } = await setupWithSeasonFile();

    await expect(
      sandbox.markObtained({ episodes: [{ code: "S01E01", fileId: "ghost_file" }] }),
    ).rejects.toThrow(/FILE_NOT_PRESENT/);
  });
});
