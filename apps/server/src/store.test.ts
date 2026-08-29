import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assignSequenceNumbers, JsonStore } from "./store.js";
import type { Channel, ChannelMessage, Database } from "./types.js";

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

  it("numbers messages per channel in arrival order and is idempotent", () => {
    const channel = (id: string): Channel => ({
      id,
      name: id,
      description: "",
      kind: "public",
      memberIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      lastMessageAt: null,
      lastSeq: undefined as unknown as number, // pre-seq database file
    });
    const message = (id: string, channelId: string, createdAt: string, seq?: number): ChannelMessage => ({
      id,
      channelId,
      authorId: "user",
      authorName: "You",
      authorKind: "user",
      kind: "message",
      content: id,
      runId: null,
      approvalId: null,
      seq: seq as unknown as number,
      traceId: id,
      parentMessageId: null,
      createdAt,
    });
    const database: Database = {
      version: 2,
      agents: [],
      channels: [channel("c1"), channel("c2")],
      messages: [
        message("b", "c1", "2026-01-01T00:00:02.000Z"),
        message("x", "c2", "2026-01-01T00:00:05.000Z", 7),
        message("a", "c1", "2026-01-01T00:00:01.000Z"),
        message("y", "c2", "2026-01-01T00:00:06.000Z"),
      ],
      runs: [],
      decisions: [],
      approvals: [],
    };
    assignSequenceNumbers(database);
    const seqOf = (id: string) => database.messages.find((item) => item.id === id)?.seq;
    expect([seqOf("a"), seqOf("b")]).toEqual([1, 2]);
    expect([seqOf("x"), seqOf("y")]).toEqual([7, 8]);
    expect(database.channels.map((item) => item.lastSeq)).toEqual([2, 8]);
    assignSequenceNumbers(database);
    expect([seqOf("a"), seqOf("b"), seqOf("x"), seqOf("y")]).toEqual([1, 2, 7, 8]);
  });
});
