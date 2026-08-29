import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});

describe("JsonStore migration", () => {
  it("upgrades a v1 database to v2 with principals and legacy DM messages", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-migrate-"));
    temporaryDirectories.push(root);
    await mkdir(root, { recursive: true });
    const file = path.join(root, "db.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: "a1",
            name: "Old",
            description: "",
            instructions: "",
            status: "busy",
            workspacePath: "/tmp/a1",
            codexThreadId: "t1",
            lastError: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        messages: [
          { id: "m1", agentId: "a1", runId: "r1", role: "user", content: "hi", createdAt: "2026-01-01T00:00:01.000Z" },
        ],
        runs: [],
      }),
    );
    const store = new JsonStore(file);
    await store.initialize();
    const database = store.snapshot();
    expect(database.version).toBe(2);
    expect(database.agents[0]).toMatchObject({ kind: "principal", principalId: "a1", status: "ready" });
    expect(database.agents[0]?.policy.preset).toBe("worker");
    expect(database.messages[0]).toMatchObject({ channelId: "legacy-dm:a1", authorKind: "user" });
  });
});
