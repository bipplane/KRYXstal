import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService, MAX_CONFLICTS_PER_TURN } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { presetPolicy } from "./policy.js";
import { JsonStore } from "./store.js";
import { channelKey, createInMemorySync, type SyncBackend } from "./sync.js";
import type { AgentRunner, RunIdentity, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ),
  );
});

const idleRunner: AgentRunner = {
  run: async () => ({ output: "unused", threadId: null, usage: null }),
  cancel: async () => false,
  isAvailable: async () => true,
};

async function makeService(
  runner: AgentRunner = idleRunner,
  sync: SyncBackend = createInMemorySync(),
  env: Record<string, string> = {},
): Promise<{ service: AgentService; sync: SyncBackend }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-sync-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...env,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    null,
    sync,
  );
  await service.initialize();
  return { service, sync };
}

const identity = (agentId: string, runId = "run-" + agentId.slice(0, 8)): RunIdentity => ({
  agentId,
  runId,
  expiresAt: Date.now() + 60_000,
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("expected the call to be rejected");
}

describe("Channel synchronisation: post_message", () => {
  it("accepts exactly one of several concurrent posts and tells the losers who won", async () => {
    const { service, sync } = await makeService();
    const agents = [];
    for (const name of ["AgentA", "AgentB", "AgentC"]) agents.push(await service.createAgent({ name }));
    const general = service.getChannelByName("general");
    for (const agent of agents) await service.agentReadChannel(identity(agent.id), "general", 30);

    const results = await Promise.allSettled(
      agents.map((agent) => service.agentPostMessage(identity(agent.id), "general", "10")),
    );
    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);
    const winnerName = agents[results.findIndex((result) => result.status === "fulfilled")]?.name;
    for (const loser of losers) {
      const error = (loser as PromiseRejectedResult).reason as HttpError;
      expect(error).toBeInstanceOf(HttpError);
      expect(error.statusCode).toBe(409);
      expect(error.message).toContain(winnerName + ' posted "10"');
      expect(error.message).toContain("Re-read #general");
      expect(error.message).toContain('Your rejected post was: "10"');
      expect(error.details?.conflict).toMatchObject({
        cause: "stale",
        winnerName,
        winnerContent: "10",
        rejectedContent: "10",
        attempt: 1,
        limit: MAX_CONFLICTS_PER_TURN,
      });
    }
    const messages = service.getMessages(general.id);
    expect(messages.filter((m) => m.kind === "message" && m.content === "10")).toHaveLength(1);
    const notices = messages.filter((m) => m.kind === "conflict");
    expect(notices).toHaveLength(2);
    expect(notices[0]?.content).toContain(winnerName + " got there first");
    const sync_rows = service.getDecisions().filter((d) => d.source === "sync");
    expect(sync_rows.map((d) => d.effect).sort()).toEqual(["allow", "conflict", "conflict"]);
    expect(sync.locks.holderOf(channelKey(general.id))).toBeNull();
  });

  it("rejects a stale post, rejects the identical retry, and accepts it after a re-read", async () => {
    const { service } = await makeService();
    const a = await service.createAgent({ name: "AgentA" });
    const b = await service.createAgent({ name: "AgentB" });
    await service.agentReadChannel(identity(a.id), "general", 30);
    await service.agentReadChannel(identity(b.id), "general", 30);
    await service.agentPostMessage(identity(a.id), "general", "hello");

    const first = await rejection(service.agentPostMessage(identity(b.id), "general", "hi"));
    expect(first.statusCode).toBe(409);
    expect(first.message).toContain('AgentA posted "hello"');
    // Feedback shows the unseen messages but does not count as having read them.
    const again = await rejection(service.agentPostMessage(identity(b.id), "general", "hi"));
    expect(again.statusCode).toBe(409);
    expect((again.details?.conflict as { attempt: number }).attempt).toBe(2);

    await service.agentReadChannel(identity(b.id), "general", 30);
    const posted = await service.agentPostMessage(identity(b.id), "general", "hi");
    expect(posted.content).toBe("hi");
    const state = service.getMessages(service.getChannelByName("general").id).map((m) => m.kind + ":" + m.content);
    expect(state.filter((line) => line.startsWith("message:"))).toEqual(["message:hello", "message:hi"]);
    expect(state.filter((line) => line.startsWith("conflict:"))).toHaveLength(2);
  });

  it("keeps a policy denial and a lost race distinguishable everywhere", async () => {
    const { service } = await makeService();
    const worker = await service.createAgent({ name: "Worker" });
    const reader = await service.createAgent({ name: "Reader", policy: presetPolicy("reader") });
    const general = service.getChannelByName("general");
    await service.agentReadChannel(identity(worker.id), "general", 30);
    await service.agentReadChannel(identity(reader.id), "general", 30);
    await service.postUserMessage(general.id, "moving the channel on");

    const denied = await rejection(service.agentPostMessage(identity(reader.id), "general", "x"));
    const lost = await rejection(service.agentPostMessage(identity(worker.id), "general", "y"));
    expect(denied.statusCode).toBe(403);
    expect(denied.message).toMatch(/^Denied:/);
    expect(denied.details).toBeNull();
    expect(lost.statusCode).toBe(409);
    expect(lost.message).toContain("changed since you last read it");
    expect(lost.message).toContain("You posted");
    expect(lost.details?.conflict).toBeTruthy();

    const rows = service.getDecisions().filter((d) => d.tool === "post_message");
    expect(rows.map((d) => d.agentName + ":" + d.source + ":" + d.effect)).toEqual([
      "Worker:sync:conflict",
      "Worker:api:allow",
      "Reader:api:deny",
    ]);
    // Notices render as different message kinds: the denial in the reader's DM (no run
    // channel for an ad-hoc identity), the lost race inline in the channel it happened in.
    expect(service.getMessages(reader.dmChannelId as string).at(-1)?.kind).toBe("denial");
    const generalKinds = service.getMessages(general.id).map((m) => m.kind);
    expect(generalKinds).toContain("conflict");
    expect(generalKinds).not.toContain("denial");
  });

  it("caps lost races per turn and tells the agent to stop", async () => {
    const { service } = await makeService();
    const a = await service.createAgent({ name: "AgentA" });
    const b = await service.createAgent({ name: "AgentB" });
    await service.agentReadChannel(identity(a.id), "general", 30);
    await service.agentPostMessage(identity(a.id), "general", "first");
    const turn = identity(b.id, "run-b-turn");
    for (let attempt = 1; attempt <= MAX_CONFLICTS_PER_TURN; attempt += 1) {
      const error = await rejection(service.agentPostMessage(turn, "general", "stale"));
      expect(error.message).toContain("conflict " + String(attempt) + " of " + String(MAX_CONFLICTS_PER_TURN));
    }
    const capped = await rejection(service.agentPostMessage(turn, "general", "stale"));
    expect(capped.statusCode).toBe(409);
    expect(capped.message).toContain("Conflict limit reached");
    const general = service.getChannelByName("general");
    expect(service.getMessages(general.id).at(-1)?.content).toContain("AgentB stops here");
    expect(service.getDecisions()[0]?.reason).toContain("conflict limit reached");
  });

  it("waits briefly for the lock, then reports the channel as busy", async () => {
    const sync = createInMemorySync({ waitMs: 100, leaseMs: 10_000 });
    const { service } = await makeService(idleRunner, sync);
    const a = await service.createAgent({ name: "AgentA" });
    const general = service.getChannelByName("general");
    await service.agentReadChannel(identity(a.id), "general", 30);

    const held = await sync.locks.acquire(channelKey(general.id), "someone-else");
    setTimeout(() => held.release(), 30);
    const posted = await service.agentPostMessage(identity(a.id), "general", "after a short wait");
    expect(posted.content).toBe("after a short wait");

    const stuck = await sync.locks.acquire(channelKey(general.id), "stuck");
    const busy = await rejection(service.agentPostMessage(identity(a.id), "general", "never"));
    stuck.release();
    expect(busy.statusCode).toBe(409);
    expect(busy.message).toContain("busy");
    expect(busy.details?.conflict).toMatchObject({ cause: "busy", winnerName: "stuck" });
    expect(service.getDecisions()[0]).toMatchObject({ source: "sync", effect: "conflict" });
  });
});

describe("Channel synchronisation: automatic reply", () => {
  it("rejects a reply that lost a race and regenerates it with feedback", async () => {
    let service!: AgentService;
    const prompts = new Map<string, string[]>();
    const runner: AgentRunner = {
      run: async (request: RunnerRequest): Promise<RunnerResult> => {
        const me = service.getAgent(request.agentId);
        const seen = prompts.get(me.name) ?? [];
        seen.push(request.prompt);
        prompts.set(me.name, seen);
        // Each agent answers the human once; a later turn (turn-taking) has nothing to add.
        if (seen.length > 2 || (me.name === "AgentA" && seen.length > 1)) {
          return { output: "[no reply]", threadId: me.name, usage: null };
        }
        if (me.name === "AgentA") return { output: "10", threadId: "a", usage: null };
        if (seen.length === 1) {
          // AgentB is slower: it only answers once AgentA's "10" has landed.
          await expect
            .poll(() => service.getMessages(service.getChannelByName("general").id).some((m) => m.content === "10"), {
              timeout: 5_000,
            })
            .toBe(true);
          return { output: "10", threadId: "b", usage: null };
        }
        return { output: "9", threadId: "b", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner));
    const a = await service.createAgent({ name: "AgentA" });
    const b = await service.createAgent({ name: "AgentB" });
    const general = service.getChannelByName("general");
    await service.postUserMessage(general.id, "@AgentA @AgentB count down from 10, take turns");

    await expect
      .poll(() => service.getRuns(b.id).filter((run) => run.status === "completed").length, { timeout: 5_000 })
      .toBe(2);
    const lines = service
      .getMessages(general.id)
      .filter((m) => m.kind !== "system")
      .map((m) => m.kind + ":" + m.authorName + ":" + m.content.slice(0, 40));
    expect(lines[1]).toBe("message:AgentA:10");
    expect(lines[2]).toContain("conflict:AgentB:AgentB's reply \"10\" was not posted");
    expect(lines[3]).toBe("message:AgentB:9");
    expect(lines).toHaveLength(4);

    const [regenerate, first] = service.getRuns(b.id);
    expect(first).toMatchObject({ trigger: "channel", conflicts: 1, status: "completed", output: "10" });
    expect(first?.conflict).toMatchObject({ winnerName: "AgentA", winnerContent: "10", rejectedContent: "10", attempt: 1 });
    expect(first?.events.at(-1)).toMatchObject({ type: "conflict", status: "conflict" });
    expect(regenerate).toMatchObject({ trigger: "conflict", conflicts: 1, output: "9", conflict: null });
    const aPost = service.getMessages(general.id).find((m) => m.authorName === "AgentA" && m.kind === "message");
    expect(regenerate?.triggerMessageId).toBe(aPost?.id);
    expect(regenerate?.traceId).toBe(aPost?.traceId);
    const secondPrompt = prompts.get("AgentB")?.[1] ?? "";
    expect(secondPrompt).toContain("was NOT posted");
    expect(secondPrompt).toContain('AgentA posted "10"');
    expect(secondPrompt).toContain('Your rejected reply was: "10"');
    expect(secondPrompt).toContain("do not repeat your rejected reply");
    expect(secondPrompt).toContain("[no reply]");
    expect(service.getAgent(a.id).status).toBe("ready");
    expect(service.getAgent(b.id).status).toBe("ready");
    const rows = service.getDecisions().filter((d) => d.tool === "auto_post");
    expect(rows.map((d) => d.agentName + ":" + d.effect).sort()).toEqual([
      "AgentA:allow",
      "AgentB:allow",
      "AgentB:conflict",
    ]);
  });

  it("posts nothing and wakes nobody for a [no reply] turn", async () => {
    let service!: AgentService;
    const runner: AgentRunner = {
      run: async (request) => ({
        output: service.getAgent(request.agentId).name === "Quiet" ? "[no reply]" : "hello @Quiet",
        threadId: null,
        usage: null,
      }),
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner));
    await service.createAgent({ name: "Loud" });
    const quiet = await service.createAgent({ name: "Quiet" });
    const general = service.getChannelByName("general");
    await service.postUserMessage(general.id, "@Loud say hi to Quiet");
    await expect.poll(() => service.getRuns(quiet.id).filter((run) => run.status === "completed").length, { timeout: 5_000 }).toBe(1);
    const run = service.getRuns(quiet.id)[0];
    expect(run).toMatchObject({ silent: true, output: "[no reply]", conflict: null });
    expect(
      service
        .getMessages(general.id)
        .filter((m) => m.kind !== "system")
        .map((m) => m.authorName + ":" + m.content),
    ).toEqual(["You:@Loud say hi to Quiet", "Loud:hello @Quiet"]);
    expect(service.getDecisions().filter((d) => d.agentName === "Quiet")).toHaveLength(0);
  });

  it("gives up regenerating after the per-turn conflict limit and says so", async () => {
    let service!: AgentService;
    let bRuns = 0;
    const runner: AgentRunner = {
      run: async (request) => {
        const me = service.getAgent(request.agentId);
        if (me.name === "AgentA") return { output: "a", threadId: "a", usage: null };
        bRuns += 1;
        // Every time AgentB answers, AgentA has slipped another message in first.
        const a = service.listAgents().find((agent) => agent.name === "AgentA");
        if (a) {
          await service.agentReadChannel(identity(a.id), "general", 30);
          await service.agentPostMessage(identity(a.id), "general", "a" + String(bRuns));
        }
        return { output: "b" + String(bRuns), threadId: "b", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner));
    await service.createAgent({ name: "AgentA" });
    const b = await service.createAgent({ name: "AgentB" });
    const general = service.getChannelByName("general");
    await service.postUserMessage(general.id, "@AgentB go");
    await expect.poll(() => service.getAgent(b.id).status === "ready" && bRuns >= MAX_CONFLICTS_PER_TURN + 1, { timeout: 5_000 }).toBe(true);
    await expect.poll(() => service.getMessages(general.id).at(-1)?.content, { timeout: 5_000 }).toContain("AgentB stops here");
    expect(bRuns).toBe(MAX_CONFLICTS_PER_TURN + 1);
    const runs = service.getRuns(b.id);
    expect(runs.map((run) => run.trigger)).toEqual(["conflict", "conflict", "conflict", "channel"]);
    expect(runs[0]?.conflict?.attempt).toBe(MAX_CONFLICTS_PER_TURN + 1);
    expect(service.getMessages(general.id).filter((m) => m.authorName === "AgentB" && m.kind === "message")).toHaveLength(0);
  });

  it("releases the channel lock when the commit throws", async () => {
    const sync = createInMemorySync();
    const { service } = await makeService(idleRunner, sync);
    const a = await service.createAgent({ name: "AgentA" });
    const general = service.getChannelByName("general");
    await service.agentReadChannel(identity(a.id), "general", 30);
    // Sabotage persistence so the mutation under the lock fails.
    const store = (service as unknown as { store: { filePath: string } }).store;
    const original = store.filePath;
    store.filePath = path.join(original, "..", "missing", "db.json");
    await expect(service.agentPostMessage(identity(a.id), "general", "boom")).rejects.toThrow();
    store.filePath = original;
    expect(sync.locks.holderOf(channelKey(general.id))).toBeNull();
    const posted = await service.agentPostMessage(identity(a.id), "general", "after recovery");
    expect(posted.content).toBe("after recovery");
  });
});

describe("Turn-taking (TURN_TAKING=on)", () => {
  it("wakes the next participant of a collaboration without a mention, and nobody outside it", async () => {
    let service!: AgentService;
    const runner: AgentRunner = {
      run: async (request) => {
        const me = service.getAgent(request.agentId);
        if (request.prompt.includes("step 2")) return { output: "[no reply]", threadId: null, usage: null };
        if (me.name === "AgentA") return { output: "step 1", threadId: null, usage: null };
        if (request.prompt.includes("step 1")) return { output: "step 2", threadId: null, usage: null };
        return { output: "[no reply]", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner, createInMemorySync(), { TURN_TAKING: "on" }));
    const a = await service.createAgent({ name: "AgentA" });
    const b = await service.createAgent({ name: "AgentB" });
    const c = await service.createAgent({ name: "AgentC" });
    const general = service.getChannelByName("general");
    const root = await service.postUserMessage(general.id, "@AgentA @AgentB take turns");
    await expect.poll(() => service.getTrace(root.id).live === false && service.getRuns(a.id).length === 2, { timeout: 5_000 }).toBe(true);
    await sleep(50);
    expect(service.getRuns(a.id).map((run) => run.trigger)).toEqual(["channel", "channel"]);
    expect(service.getRuns(b.id)).toHaveLength(2);
    expect(service.getRuns(c.id)).toHaveLength(0);
    expect(
      service
        .getMessages(general.id)
        .filter((m) => m.kind === "message")
        .map((m) => m.authorName + ":" + m.content),
    ).toEqual(["You:@AgentA @AgentB take turns", "AgentA:step 1", "AgentB:step 2"]);
    // The turn after "step 2" went to AgentA, who had nothing to add; the round ended there.
    expect(service.getRuns(a.id)[0]).toMatchObject({ silent: true, output: "[no reply]" });
    expect(service.getMessages(general.id).some((m) => m.content.startsWith("Paused"))).toBe(false);
  });

  it("is off by default: an unmentioned reply wakes nobody", async () => {
    let service!: AgentService;
    const runner: AgentRunner = {
      run: async (request) => ({
        output: service.getAgent(request.agentId).name === "AgentA" ? "step 1" : "[no reply]",
        threadId: null,
        usage: null,
      }),
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner));
    const a = await service.createAgent({ name: "AgentA" });
    const b = await service.createAgent({ name: "AgentB" });
    const general = service.getChannelByName("general");
    const root = await service.postUserMessage(general.id, "@AgentA @AgentB take turns");
    await expect.poll(() => !service.getTrace(root.id).live, { timeout: 5_000 }).toBe(true);
    await sleep(100);
    expect(service.getRuns(a.id)).toHaveLength(1);
    expect(service.getRuns(b.id)).toHaveLength(1);
    expect(service.getTrace(root.id).runs).toHaveLength(2);
  });
});

describe("Passing the turn (TURN_TAKING=on)", () => {
  it("hands a silent turn to the next participant and ends the round after a full circle", async () => {
    let service!: AgentService;
    const general = () => service.getChannelByName("general").id;
    const posted = (content: string) => service.getMessages(general()).some((m) => m.content === content);
    const runner: AgentRunner = {
      run: async (request) => {
        const me = service.getAgent(request.agentId);
        // The human's message appears as a "] You: …" line; later prompts only quote it as chain context.
        const fromHuman = /\] You: .*go/.test(request.prompt);
        if (fromHuman && me.name !== "AgentA") {
          // B and C answer the human only after A's "one" has landed, so the order is stable.
          await expect.poll(() => posted("one"), { timeout: 5_000 }).toBe(true);
        }
        if (me.name === "AgentA" && fromHuman) return { output: "one", threadId: null, usage: null };
        if (me.name === "AgentC" && request.prompt.includes("one")) return { output: "three", threadId: null, usage: null };
        return { output: "[no reply]", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner, createInMemorySync(), { TURN_TAKING: "on" }));
    const a = await service.createAgent({ name: "AgentA" });
    const b = await service.createAgent({ name: "AgentB" });
    const c = await service.createAgent({ name: "AgentC" });
    const root = await service.postUserMessage(general(), "@AgentA @AgentB @AgentC go");
    await expect.poll(() => posted("three") && !service.getTrace(root.id).live, { timeout: 5_000 }).toBe(true);
    await sleep(100);
    expect(
      service
        .getMessages(general())
        .filter((m) => m.kind === "message" && m.authorKind !== "user")
        .map((m) => m.authorName + ":" + m.content),
    ).toEqual(["AgentA:one", "AgentC:three"]);
    // B passed, so the turn went on to C, who had something to say; after "three" both A and B
    // passed and the round ended without a budget pause.
    const one = service.getMessages(general()).find((m) => m.content === "one");
    const three = service.getRuns(c.id).find((run) => run.output === "three");
    expect(three?.triggerMessageId).toBe(one?.id);
    expect(service.getRuns(a.id).length).toBe(2);
    expect(service.getRuns(b.id).length).toBeGreaterThanOrEqual(2);
    expect(service.getRuns(c.id).length).toBe(2);
    expect(service.getMessages(general()).some((m) => m.content.startsWith("Paused"))).toBe(false);
    expect(service.getTrace(root.id).runs.every((run) => run.status === "completed")).toBe(true);
  });
});

describe("Reply lineage", () => {
  it("hangs a reply off the newest message the agent had seen, not the message that woke it", async () => {
    let service!: AgentService;
    const general = () => service.getChannelByName("general").id;
    const posted = (content: string) => service.getMessages(general()).some((m) => m.content === content);
    const runner: AgentRunner = {
      run: async (request) => {
        if (service.getAgent(request.agentId).name === "AgentA") return { output: "one", threadId: null, usage: null };
        // AgentB was woken by the same prompt but answers only after re-reading the channel with A's "one" in it.
        await expect.poll(() => posted("one"), { timeout: 5_000 }).toBe(true);
        await service.agentReadChannel(identity(request.agentId, request.runId), "general", 30);
        return { output: "two", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner));
    await service.createAgent({ name: "AgentA" });
    const b = await service.createAgent({ name: "AgentB" });
    const root = await service.postUserMessage(general(), "@AgentA @AgentB go");
    await expect.poll(() => posted("two") && !service.getTrace(root.id).live, { timeout: 5_000 }).toBe(true);
    const one = service.getMessages(general()).find((m) => m.content === "one");
    const two = service.getMessages(general()).find((m) => m.content === "two");
    expect(one?.parentMessageId).toBe(root.id);
    expect(two?.parentMessageId).toBe(one?.id);
    expect(two?.traceId).toBe(root.id);
    // What woke the run is still recorded on the run itself.
    expect(service.getRuns(b.id)[0]).toMatchObject({ triggerMessageId: root.id, conflicts: 0 });
  });

  it("moves a turn into the newer chain it answered after reading it mid-turn", async () => {
    let service!: AgentService;
    const general = () => service.getChannelByName("general").id;
    let turns = 0;
    const runner: AgentRunner = {
      run: async (request) => {
        turns += 1;
        if (turns > 1) return { output: "[no reply]", threadId: null, usage: null };
        // Woken by the first prompt, the agent sees a second one arrive, re-reads, and answers that instead.
        await expect
          .poll(() => service.getMessages(general()).filter((m) => m.authorKind === "user").length, { timeout: 5_000 })
          .toBe(2);
        await service.agentReadChannel(identity(request.agentId, request.runId), "general", 30);
        return { output: "67 @everyone", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner));
    const a = await service.createAgent({ name: "AgentA" });
    const first = await service.postUserMessage(general(), "@AgentA count down from 10");
    await expect.poll(() => service.getAgent(a.id).status, { timeout: 5_000 }).toBe("busy");
    const second = await service.postUserMessage(general(), "@everyone count down from 67 instead");
    await expect
      .poll(() => service.getRuns(a.id).filter((run) => run.status === "completed").length, { timeout: 5_000 })
      .toBe(2);
    const reply = service.getMessages(general()).find((m) => m.content.startsWith("67"));
    expect(reply).toMatchObject({ traceId: second.id, parentMessageId: second.id });
    // The wake is unchanged; the turn, and every decision it made, now belong to the chain it answered.
    const turn = service.getRuns(a.id).find((run) => run.output === "67 @everyone");
    expect(turn).toMatchObject({ triggerMessageId: first.id, traceId: second.id });
    const trace = service.getTrace(second.id);
    expect(trace.runs.map((run) => run.id)).toContain(turn?.id);
    expect(trace.decisions.filter((d) => d.runId === turn?.id).map((d) => d.tool + ":" + d.effect)).toEqual([
      "read_channel:allow",
      "auto_post:allow",
    ]);
    expect(service.getTrace(first.id).runs).toHaveLength(0);
  });

  it("keeps a reply in its own chain when the newer message did not address the agent", async () => {
    let service!: AgentService;
    const general = () => service.getChannelByName("general").id;
    const posted = (content: string) => service.getMessages(general()).some((m) => m.content === content);
    const runner: AgentRunner = {
      run: async (request) => {
        if (service.getAgent(request.agentId).name === "AgentB") return { output: "on it", threadId: null, usage: null };
        // AgentA sees an unrelated prompt for AgentB land while it works, re-reads, and finishes its own task.
        await expect.poll(() => posted("on it"), { timeout: 5_000 }).toBe(true);
        await service.agentReadChannel(identity(request.agentId, request.runId), "general", 30);
        return { output: "done", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner));
    const a = await service.createAgent({ name: "AgentA" });
    await service.createAgent({ name: "AgentB" });
    const first = await service.postUserMessage(general(), "@AgentA tidy the workspace");
    const second = await service.postUserMessage(general(), "@AgentB check the build");
    await expect
      .poll(() => posted("done") && !service.getTrace(first.id).live && !service.getTrace(second.id).live, { timeout: 5_000 })
      .toBe(true);
    const done = service.getMessages(general()).find((m) => m.content === "done");
    const onIt = service.getMessages(general()).find((m) => m.content === "on it");
    expect(done).toMatchObject({ traceId: first.id, parentMessageId: first.id });
    expect(onIt).toMatchObject({ traceId: second.id, parentMessageId: second.id });
    expect(service.getRuns(a.id)[0]?.traceId).toBe(first.id);
    expect(service.getTrace(first.id).messages.map((m) => m.content)).toEqual(["@AgentA tidy the workspace", "done"]);
    expect(service.getTrace(second.id).messages.map((m) => m.content)).toEqual(["@AgentB check the build", "on it"]);
  });

  it("still wakes the asker when the answer followed a later message than the question", async () => {
    let service!: AgentService;
    const general = () => service.getChannelByName("general").id;
    const posted = (content: string) => service.getMessages(general()).some((m) => m.content === content);
    let askerTurns = 0;
    const runner: AgentRunner = {
      run: async (request) => {
        const who = identity(request.agentId, request.runId);
        if (service.getAgent(request.agentId).name === "Asker") {
          askerTurns += 1;
          if (askerTurns > 1) return { output: "Answerer says 5.", threadId: "asker", usage: null };
          await service.agentPostMessage(who, "general", "@Answerer what is X?");
          await service.agentPostMessage(who, "general", "No rush, Answerer.");
          return { output: "Asked Answerer; waiting.", threadId: "asker", usage: null };
        }
        // Answerer replies only after the follow-up, so its answer follows that rather than the question.
        await expect.poll(() => posted("No rush, Answerer."), { timeout: 5_000 }).toBe(true);
        await service.agentReadChannel(who, "general", 30);
        return { output: "X is 5.", threadId: "answerer", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner));
    const asker = await service.createAgent({ name: "Asker" });
    await service.createAgent({ name: "Answerer" });
    const root = await service.sendMessage(asker.id, "ask Answerer what X is and tell me");
    await expect
      .poll(() => service.getTrace(root.message.id).runs.filter((run) => run.status === "completed").length, {
        timeout: 5_000,
      })
      .toBe(3);
    const messages = service.getMessages(general());
    const followUp = messages.find((m) => m.content === "No rush, Answerer.");
    const answer = messages.find((m) => m.content === "X is 5.");
    expect(answer?.parentMessageId).toBe(followUp?.id);
    // Routing still keys off the question that woke Answerer: Asker is woken and reports back in its DM.
    expect(service.getRuns(asker.id)[0]).toMatchObject({ triggerMessageId: answer?.id, replyChannelId: asker.dmChannelId });
    expect(service.getMessages(asker.dmChannelId as string).at(-1)?.content).toBe("Answerer says 5.");
  });
});

/**
 * A fake model for the countdown. It reads its prompt the way a model would —
 * numbers other agents posted, what beat it, what of its own was rejected —
 * and answers the next number, ending with @everyone when asked to, or
 * "[no reply]" once the countdown is done. A barrier makes every agent answer
 * the human at the same instant, so the race on "10" is guaranteed.
 */
function countdownRunner(
  getService: () => AgentService,
  N: number,
  suffix: string,
): AgentRunner {
  const seenByOthers = new Map<string, Set<number>>();
  const believedMine = new Map<string, Set<number>>();
  let firstPrompts = 0;
  return {
    run: async (request) => {
      const service = getService();
      const me = service.getAgent(request.agentId);
      const seen = seenByOthers.get(me.id) ?? new Set<number>();
      const mine = believedMine.get(me.id) ?? new Set<number>();
      seenByOthers.set(me.id, seen);
      believedMine.set(me.id, mine);
      for (const match of request.prompt.matchAll(/\] Agent\w+: (\d+)/g)) seen.add(Number(match[1]));
      for (const match of request.prompt.matchAll(/Agent\w+ posted "(\d+)/g)) seen.add(Number(match[1]));
      const rejected = /Your rejected reply was: "(\d+)/.exec(request.prompt);
      if (rejected) mine.delete(Number(rejected[1]));
      if (!request.prompt.includes("was NOT posted") && request.prompt.includes("] You: ")) {
        firstPrompts += 1;
        await expect.poll(() => firstPrompts >= N, { timeout: 5_000 }).toBe(true);
      }
      await sleep(Math.floor(Math.random() * 20));
      const known = [...seen, ...mine];
      const next = (known.length > 0 ? Math.min(...known) : 11) - 1;
      if (next < 1) return { output: "[no reply]", threadId: null, usage: null };
      mine.add(next);
      return { output: String(next) + suffix, threadId: null, usage: null };
    },
    cancel: async () => false,
    isAvailable: async () => true,
  };
}

async function runCountdown(
  service: AgentService,
  N: number,
): Promise<{ numbers: number[]; trace: ReturnType<AgentService["getTrace"]> }> {
  for (let index = 0; index < N; index += 1) await service.createAgent({ name: "Agent" + "ABCDE"[index] });
  const general = service.getChannelByName("general");
  const root = await service.postUserMessage(
    general.id,
    "@everyone count down from 10 to 1, one number per message, take turns",
  );
  await expect
    .poll(() => {
      const trace = service.getTrace(root.id);
      const last = service.getMessages(general.id).filter((m) => m.kind === "message").at(-1);
      return !trace.live && /^1\b/.test(last?.content ?? "") && service.listAgents().every((agent) => agent.status === "ready");
    }, { timeout: 30_000, interval: 50 })
    .toBe(true);
  await sleep(150);
  const numbers = service
    .getMessages(general.id)
    .filter((m) => m.kind === "message" && m.authorKind !== "user")
    .map((m) => Number(/^(\d+)/.exec(m.content)?.[1]));
  return { numbers, trace: service.getTrace(root.id) };
}

describe("Countdown demo", () => {
  it("with @everyone on every message (default), N agents count down 10..1 once each, in order", async () => {
    const N = 5;
    let service!: AgentService;
    ({ service } = await makeService(countdownRunner(() => service, N, " @everyone")));
    const { numbers, trace } = await runCountdown(service, N);
    expect(numbers).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    // Each accepted number follows the one before it, whatever woke the run that posted it.
    const posts = trace.messages.filter((m) => m.kind === "message" && m.authorKind !== "user");
    expect(posts.map((m) => m.parentMessageId)).toEqual([trace.rootId, ...posts.slice(0, -1).map((m) => m.id)]);
    // Every step is a race between all N: conflicts on most steps, all resolved by regenerating.
    expect(trace.messages.filter((m) => m.kind === "conflict").length).toBeGreaterThanOrEqual(N - 1);
    expect(trace.runs.some((run) => run.trigger === "conflict")).toBe(true);
    expect(trace.runs.length).toBeLessThanOrEqual(64);
    expect(trace.messages.some((m) => m.content.startsWith("Paused"))).toBe(false);
    const notice = trace.messages.find((m) => m.kind === "conflict");
    expect(notice?.content).toMatch(/Agent[A-E]'s reply "10 @everyone" was not posted, but Agent[A-E] got there first with "10 @everyone"/);
  });

  it("with TURN_TAKING=on, N agents count down 10..1 with one run per step after the opening race", async () => {
    const N = 3;
    let service!: AgentService;
    ({ service } = await makeService(countdownRunner(() => service, N, ""), createInMemorySync(), { TURN_TAKING: "on" }));
    const { numbers, trace } = await runCountdown(service, N);
    expect(numbers).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    // Each accepted number follows the one before it, whatever woke the run that posted it.
    const posts = trace.messages.filter((m) => m.kind === "message" && m.authorKind !== "user");
    expect(posts.map((m) => m.parentMessageId)).toEqual([trace.rootId, ...posts.slice(0, -1).map((m) => m.id)]);
    expect(trace.messages.filter((m) => m.kind === "conflict").length).toBeGreaterThanOrEqual(N - 1);
    expect(trace.runs.length).toBeLessThanOrEqual(24);
    expect(trace.messages.some((m) => m.content.startsWith("Paused"))).toBe(false);
  });
});

describe("Other contended actions", () => {
  it("lets exactly one agent create a channel name and gives the other conflict feedback", async () => {
    const { service } = await makeService();
    const a = await service.createAgent({ name: "AgentA", policy: presetPolicy("admin") });
    const b = await service.createAgent({ name: "AgentB", policy: presetPolicy("admin") });
    const results = await Promise.allSettled([
      service.agentCreateChannel(identity(a.id), { name: "deploys" }),
      service.agentCreateChannel(identity(b.id), { name: "Deploys" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    const error = loser.reason as HttpError;
    expect(error.statusCode).toBe(409);
    expect(error.message).toContain("#deploys already exists");
    expect(error.message).toContain("lost race, not a permission problem");
    expect(service.listChannels().filter((c) => c.name === "deploys")).toHaveLength(1);
    const row = service.getDecisions().find((d) => d.tool === "create_channel" && d.effect === "conflict");
    expect(row).toMatchObject({ source: "sync", action: "channel:create", resource: "channel:deploys" });
    const loserAgent = row?.agentId === a.id ? a : b;
    expect(service.getMessages(loserAgent.dmChannelId as string).at(-1)).toMatchObject({
      kind: "conflict",
      content: expect.stringContaining("tried to create #deploys"),
    });
    // The human path keeps its plain error.
    await expect(service.createChannel({ name: "deploys" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("resolves an approval exactly once even when approved twice at the same time", async () => {
    const { service } = await makeService();
    const requester = await service.createAgent({ name: "Planner" });
    const approval = await service.agentRequestPrincipal(identity(requester.id), {
      name: "Monitor",
      instructions: "watch",
      preset: "reader",
    });
    const results = await Promise.allSettled([
      service.resolveApproval(approval.id, "approve"),
      service.resolveApproval(approval.id, "approve"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as HttpError;
    expect(lost.statusCode).toBe(409);
    expect(lost.message).toContain("already resolved");
    expect(service.listAgents().filter((agent) => agent.name === "Monitor")).toHaveLength(1);
  });
});
