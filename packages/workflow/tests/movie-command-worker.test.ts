import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  FakeResourceProvider,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  queueMovieAcquisition,
  runQueuedMovieAcquisition,
  type MediaTitle,
} from "../src/index.js";

const fixedNow = () => "2026-06-13T00:00:00.000Z";

/** Throws if invoked — proves the already-present movie short-circuits before the agent. */
function throwingModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("model should not run when the movie is already present");
    },
  });
}

function movieTitle(): MediaTitle {
  return {
    id: "tmdb_movie_872585",
    tmdbId: 872585,
    type: "movie",
    title: "奥本海默",
    originalTitle: "Oppenheimer",
    year: 2023,
    aliases: ["Oppenheimer"],
  };
}

describe("movie acquisition command + worker", () => {
  it("queues a movie and blocks a duplicate while active (title lock)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const first = await queueMovieAcquisition({
      title: movieTitle(),
      keyword: "奥本海默 4K",
      repository,
      createWorkflowRunId: () => "run_movie_1",
      now: fixedNow,
    });
    expect(first.status).toBe("queued");
    const second = await queueMovieAcquisition({
      title: movieTitle(),
      keyword: "奥本海默 4K",
      repository,
      createWorkflowRunId: () => "run_movie_2",
      now: fixedNow,
    });
    expect(second.status).toBe("already_running");
  });

  it("worker claims, runs, and persists a movie acquisition (already-present → succeeded no-op)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title = movieTitle();
    await queueMovieAcquisition({
      title,
      keyword: "奥本海默 4K",
      repository,
      createWorkflowRunId: () => "run_movie",
      now: fixedNow,
    });
    const storage = new FakeStorageExecutor();
    // Verify-or-create resolves the canonical `Title (Year)` movie dir; seed it
    // with the film already present so the run is a succeeded no-op.
    const movieDir = await storage.createDirectory({ name: `${title.title} (${title.year})`, parentId: "movies_root" });
    storage.seedDirectoryFiles(movieDir, [
      {
        id: "oppen_v",
        storageDirectoryId: movieDir,
        name: "Oppenheimer.2023.mkv",
        sizeBytes: 8_000_000_000,
        episodeCode: null,
        providerFileId: "oppen_v",
      },
    ]);

    const result = await runQueuedMovieAcquisition({
      repository,
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage,
      model: throwingModel(),
      stagingParentDirectoryId: "movies_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
    });

    expect(result.status).toBe("ran");
    const saved = await repository.getWorkflowRunSnapshot("run_movie");
    expect(saved?.workflowRun.kind).toBe("movie_init");
    expect(saved?.workflowRun.status).toBe("succeeded");
    expect(saved?.title.type).toBe("movie");
  });
});
