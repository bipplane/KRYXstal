import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService, mentions } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { evaluate, presetPolicy, renderExecPolicyRules } from "./policy.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunIdentity, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  requests: RunnerRequest[] = [];
  reply: (request: RunnerRequest) => string = (request) => "Completed: " + request.prompt;
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(request);
    request.onEvent?.({
      id: "evt-1",
      type: "command_execution",
      summary: "npm test",
      status: "completed",
      exitCode: 0,
      detail: "ok",
      createdAt: new Date().toISOString(),
    });
    return {
      output: this.reply(request),
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  env: Record<string, string> = {},
): Promise<{ service: AgentService; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
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
  );
  await service.initialize();
  return { service, root };
}

const identity = (agentId: string, runId = "run-test"): RunIdentity => ({
  agentId,
  runId,
  expiresAt: Date.now() + 60_000,
});

describe("Principals and channels", () => {
  it("bootstraps system channels and gives every principal a DM", async () => {
    const { service } = await makeService();
    const names = service.listChannels().map((channel) => channel.name);
    expect(names).toEqual(expect.arrayContaining(["general", "approvals"]));
    const agent = await service.createAgent({ name: "Builder" });
    expect(agent.kind).toBe("principal");
    expect(agent.dmChannelId).not.toBeNull();
    expect(service.getChannelByName("general").memberIds).toContain(agent.id);
    expect(service.overview().agents).toHaveLength(1);
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const { service } = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
    expect(service.getChannelByName("general").memberIds).not.toContain(agent.id);
  });

  it("grants channel access from membership and writes it into AGENTS.md", async () => {
    const { service } = await makeService();
    const deploys = await service.createChannel({ name: "Deploys" });
    const agent = await service.createAgent({
      name: "Shipper",
      policy: presetPolicy("reader"),
      channelIds: [deploys.id],
    });
    expect(service.getChannel(deploys.id).memberIds).toContain(agent.id);
    const instructions = await readFile(path.join(agent.workspacePath, "AGENTS.md"), "utf8");
    expect(instructions).toContain("#deploys");
    expect(instructions).toContain("ALLOW channel:read, channel:post on channel:deploys");
  });

  it("runs a DM conversation through the channel scheduler and records events", async () => {
    const runner = new FakeRunner();
    const { service } = await makeService(runner);
    const agent = await service.createAgent({ name: "Coder" });
    await service.sendMessage(agent.id, "write hello world");
    await expect
      .poll(() => service.getMessages(agent.dmChannelId as string).length)
      .toBe(2);
    const messages = service.getMessages(agent.dmChannelId as string);
    expect(messages.map((message) => message.authorKind)).toEqual(["user", "principal"]);
    expect(messages[1]?.content).toContain("write hello world");
    const run = service.getRuns(agent.id)[0];
    expect(run?.status).toBe("completed");
    expect(run?.trigger).toBe("channel");
    expect(run?.events[0]?.summary).toBe("npm test");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
    const request = runner.requests[0];
    expect(request?.env.AGENT_TOKEN).toBeTruthy();
    expect(request?.env.LAUNCHPAD_URL).toBe("http://127.0.0.1:3000");
    expect(request?.prompt).toContain("write hello world");
    expect(await readFile(path.join(request?.codexHome ?? "", "config.toml"), "utf8")).toContain(
      "[mcp_servers.launchpad]",
    );
    // Run tokens die with the run.
    expect(service.resolveToken(request?.env.AGENT_TOKEN ?? "")).toBeNull();
  });

  it("wakes only @mentioned members in public channels and every member in DMs", async () => {
    const runner = new FakeRunner();
    const { service } = await makeService(runner);
    const planner = await service.createAgent({ name: "Planner" });
    const reviewer = await service.createAgent({ name: "Reviewer" });
    const general = service.getChannelByName("general");
    await service.postUserMessage(general.id, "@reviewer please look at this");
    await expect.poll(() => runner.requests.length).toBe(1);
    expect(runner.requests[0]?.agentId).toBe(reviewer.id);
    expect(service.getRuns(planner.id)).toHaveLength(0);
    expect(mentions("hi @planner!", "Planner", [])).toBe(true);
    expect(mentions("hi @plannerx", "Planner", [])).toBe(false);
    expect(mentions("@planner/tester go", "Planner/tester", [])).toBe(true);
  });

  it("queues a second wake while the Agent is busy instead of rejecting it", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const runner: AgentRunner = {
      run: async () => {
        calls += 1;
        return calls === 1 ? pending : { output: "second", threadId: "t", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service } = await makeService(runner);
    const agent = await service.createAgent({ name: "Busy" });
    await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getAgent(agent.id).status).toBe("busy");
    await expect
      .poll(() => service.overview().typing)
      .toContainEqual({ agentId: agent.id, channelId: agent.dmChannelId });
    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await service.sendMessage(agent.id, "second");
    await expect.poll(() => calls).toBe(1);
    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => calls).toBe(2);
    await expect.poll(() => service.getRuns(agent.id).every((run) => run.status === "completed")).toBe(true);
  });
});

describe("IAM enforcement", () => {
  it("evaluates hook tool calls against the policy and logs the decision", async () => {
    const { service } = await makeService();
    const agent = await service.createAgent({ name: "Worker" });
    const allowed = await service.evaluateToolCall(identity(agent.id), "Bash", { command: "npm test" });
    expect(allowed.effect).toBe("allow");
    const denied = await service.evaluateToolCall(identity(agent.id), "Bash", { command: "rm -rf /" });
    expect(denied).toMatchObject({ effect: "deny", action: "shell:exec", resource: "cmd:rm -rf /" });
    const passive = await service.evaluateToolCall(identity(agent.id), "update_plan", {});
    expect(passive.action).toBeNull();
    const decisions = service.getDecisions(agent.id);
    expect(decisions.map((decision) => decision.effect)).toEqual(["deny", "allow"]);
    expect(decisions[0]?.source).toBe("hook");
    const dm = service.getMessages(agent.dmChannelId as string);
    expect(dm.at(-1)?.kind).toBe("denial");
  });

  it("denies channel posts without membership or policy, server-side", async () => {
    const { service } = await makeService();
    const deploys = await service.createChannel({ name: "deploys" });
    const agent = await service.createAgent({ name: "Worker" });
    await expect(
      service.agentPostMessage(identity(agent.id), "deploys", "ship it"),
    ).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("not a member") });
    const reader = await service.createAgent({
      name: "Reader",
      policy: presetPolicy("reader"),
    });
    await expect(
      service.agentPostMessage(identity(reader.id), "general", "hi"),
    ).rejects.toMatchObject({ statusCode: 403 });
    const message = await service.agentPostMessage(identity(agent.id), "general", "hello all");
    expect(message.authorId).toBe(agent.id);
    expect(service.getChannel(deploys.id).memberIds).not.toContain(agent.id);
    const decisions = service.getDecisions();
    expect(decisions.filter((decision) => decision.effect === "deny")).toHaveLength(2);
    // The accepted post leaves two rows: the IAM allow, then the read-before-act allow.
    expect(decisions[1]).toMatchObject({ effect: "allow", tool: "post_message", source: "api" });
    expect(decisions[0]).toMatchObject({ effect: "allow", tool: "post_message", source: "sync" });
  });
});

describe("Sessions and delegation", () => {
  it("spawns a session with a narrowed policy that inherits parent denies", async () => {
    const { service } = await makeService();
    const parent = await service.createAgent({ name: "Planner" });
    const session = await service.agentSpawn(identity(parent.id), {
      name: "Tester",
      instructions: "Run the tests",
      actions: ["shell:exec"],
      channels: ["general"],
    });
    expect(session.kind).toBe("session");
    expect(session.name).toBe("Planner/tester");
    expect(session.principalId).toBe(parent.id);
    expect(session.parentAgentId).toBe(parent.id);
    expect(service.getChannelByName("general").memberIds).toContain(session.id);
    const denied = await service.evaluateToolCall(identity(session.id), "Bash", { command: "sudo ls" });
    expect(denied.effect).toBe("deny");
    const spawnDenied = await service.evaluateToolCall(
      identity(session.id),
      "mcp__launchpad__spawn_agent",
      {},
    );
    expect(spawnDenied.effect).toBe("deny");
    const dm = service.getMessages(session.dmChannelId as string);
    expect(dm[0]?.kind).toBe("spawn");
    expect(service.getChannel(session.dmChannelId as string).memberIds).toEqual(
      expect.arrayContaining(["user", parent.id, session.id]),
    );
  });

  it("refuses delegation beyond the parent's delegable set and non-ancestor closes", async () => {
    const { service } = await makeService();
    const parent = await service.createAgent({ name: "Planner" });
    await expect(
      service.agentSpawn(identity(parent.id), {
        name: "Netty",
        instructions: "x",
        actions: ["net:access"],
      }),
    ).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("not delegable") });
    const other = await service.createAgent({ name: "Other" });
    const session = await service.agentSpawn(identity(parent.id), {
      name: "Kid",
      instructions: "x",
      actions: ["shell:exec"],
    });
    await expect(service.agentClose(identity(other.id), session.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    const closed = await service.agentClose(identity(parent.id), session.id);
    expect(closed.status).toBe("closed");
    expect(service.getDecisions()[0]).toMatchObject({ effect: "allow", tool: "close_agent" });
  });

  it("cascades closes to nested sessions and blocks a reader from spawning", async () => {
    const { service } = await makeService();
    const parent = await service.createAgent({ name: "Planner" });
    const child = await service.agentSpawn(identity(parent.id), {
      name: "Child",
      instructions: "x",
      actions: ["shell:exec"],
    });
    // Child cannot spawn: agent:spawn was not delegated.
    await expect(
      service.agentSpawn(identity(child.id), { name: "Grandchild", instructions: "y" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await service.deleteAgent(parent.id);
    expect(service.getAgent(child.id).status).toBe("closed");
    const reader = await service.createAgent({ name: "Reader", policy: presetPolicy("reader") });
    await expect(
      service.agentSpawn(identity(reader.id), { name: "Nope", instructions: "z" }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("Approvals", () => {
  it("lets an agent request a principal and the human approve it", async () => {
    const { service } = await makeService();
    const requester = await service.createAgent({ name: "Planner" });
    const approval = await service.agentRequestPrincipal(identity(requester.id), {
      name: "Monitor",
      instructions: "Watch the build",
      preset: "reader",
      channels: ["general"],
    });
    expect(approval.status).toBe("pending");
    expect(service.overview().approvals).toHaveLength(1);
    const approvals = service.getChannelByName("approvals");
    expect(service.getMessages(approvals.id).at(-1)).toMatchObject({
      kind: "approval",
      approvalId: approval.id,
    });
    const resolved = await service.resolveApproval(approval.id, "approve");
    expect(resolved.status).toBe("approved");
    const created = service.listAgents().find((agent) => agent.name === "Monitor");
    expect(created?.kind).toBe("principal");
    expect(created?.policy.preset).toBe("reader");
    expect(service.getChannelByName("general").memberIds).toContain(created?.id);
    await expect(service.resolveApproval(approval.id, "deny")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("Traces", () => {
  it("links every message, run and decision caused by one prompt across channels", async () => {
    let service!: AgentService;
    const prompts: string[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        prompts.push(request.prompt);
        const agent = service.getAgent(request.agentId);
        if (agent.name === "AgentA") {
          // AgentA acts mid-run: posts into #test, which wakes AgentB there.
          await service.agentPostMessage(
            { agentId: request.agentId, runId: request.runId, expiresAt: Date.now() + 60_000 },
            "test",
            "Hello @AgentB from A",
          );
          return { output: "Posted in #test.", threadId: "a", usage: null };
        }
        return { output: "Hi A, B here.", threadId: "b", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner, { TRACE_BUDGET: "6" }));
    const test = await service.createChannel({ name: "test" });
    const a = await service.createAgent({ name: "AgentA", channelIds: [test.id] });
    const b = await service.createAgent({ name: "AgentB", channelIds: [test.id] });
    const general = service.getChannelByName("general");
    const root = await service.postUserMessage(general.id, "@AgentA say hi to B in #test");
    expect(root.traceId).toBe(root.id);
    expect(root.parentMessageId).toBeNull();

    await expect
      .poll(() => service.getTrace(root.id).runs.filter((run) => run.status === "completed").length)
      .toBe(2);
    await expect.poll(() => service.getTrace(root.id).messages.length).toBe(4);
    const trace = service.getTrace(root.id);
    expect(trace.live).toBe(false);
    expect(trace.rootId).toBe(root.id);
    expect(trace.messages.map((m) => m.authorName + "@" + trace.channels.find((c) => c.id === m.channelId)?.name)).toEqual([
      "You@general",
      "AgentA@test",
      "AgentA@general",
      "AgentB@test",
    ]);
    expect(trace.messages.every((m) => m.traceId === root.id)).toBe(true);
    const aPost = trace.messages[1];
    const bReply = trace.messages[3];
    expect(aPost?.parentMessageId).toBe(root.id);
    expect(bReply?.parentMessageId).toBe(aPost?.id);
    expect(trace.runs.map((run) => run.agentId)).toEqual([a.id, b.id]);
    expect(trace.runs[0]?.triggerMessageId).toBe(root.id);
    expect(trace.runs[1]?.triggerMessageId).toBe(aPost?.id);
    expect(trace.decisions.filter((d) => d.source === "api").map((d) => d.tool)).toEqual(["post_message"]);
    // Every channel write, tool or automatic, also leaves a read-before-act row.
    expect(trace.decisions.filter((d) => d.source === "sync").map((d) => d.tool + ":" + d.effect)).toEqual([
      "post_message:allow",
      "auto_post:allow",
      "auto_post:allow",
    ]);
    expect(trace.decisions.every((d) => d.traceId === root.id)).toBe(true);
    expect(trace.agents.map((agent) => agent.name).sort()).toEqual(["AgentA", "AgentB"]);
    // The human-triggered run gets no chain context; the agent-triggered one does.
    expect(prompts[0]).not.toContain("Chain context");
    expect(prompts[1]).toContain("Chain context: these messages follow from You's original request in #general");
    expect(prompts[1]).toContain("The latest message is from another agent");
    expect(prompts[1]).toContain("used 1 of 6 agent runs");
    // Any message in the chain resolves to the same trace.
    expect(service.getTrace(bReply?.id ?? "").rootId).toBe(root.id);
    expect(() => service.getTrace("00000000-0000-0000-0000-000000000000")).toThrow("Message not found");
  });
});

describe("Trace budget", () => {
  it("stops a ping-pong after TRACE_BUDGET runs caused by one prompt", async () => {
    let service!: AgentService;
    const runner: AgentRunner = {
      run: async (request) => {
        const me = service.getAgent(request.agentId);
        const other = me.name === "Ping" ? "@Pong" : "@Ping";
        return { output: "thanks " + other, threadId: me.name, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner, { TRACE_BUDGET: "6" }));
    await service.createAgent({ name: "Ping" });
    await service.createAgent({ name: "Pong" });
    const general = service.getChannelByName("general");
    const root = await service.postUserMessage(general.id, "@Ping say hi to @Pong");
    await expect
      .poll(() => service.getMessages(general.id).some((m) => m.content.startsWith("Paused: this prompt")), { timeout: 5_000 })
      .toBe(true);
    await expect.poll(() => service.getTrace(root.id).live).toBe(false);
    const trace = service.getTrace(root.id);
    expect(trace.runs.length).toBe(6);
    expect(trace.messages.filter((m) => m.kind === "system")).toHaveLength(1);
    // A fresh human message starts a new trace and wakes again.
    const again = await service.postUserMessage(general.id, "@Ping once more");
    await expect.poll(() => service.getTrace(again.id).runs.length).toBeGreaterThan(0);
  });
});

describe("Reply routing", () => {
  it("wakes the agent that asked when the answer arrives, without a mention, and stops there", async () => {
    let service!: AgentService;
    const prompts: Array<{ agent: string; prompt: string }> = [];
    const runner: AgentRunner = {
      run: async (request) => {
        const me = service.getAgent(request.agentId);
        prompts.push({ agent: me.name, prompt: request.prompt });
        if (me.name === "Asker" && prompts.filter((p) => p.agent === "Asker").length === 1) {
          // Turn 1: ask Answerer in #general and end the turn.
          await service.agentPostMessage(
            { agentId: request.agentId, runId: request.runId, expiresAt: Date.now() + 60_000 },
            "general",
            "@Answerer who is csgod?",
          );
          return { output: "Asked Answerer; waiting.", threadId: "asker", usage: null };
        }
        if (me.name === "Answerer") return { output: "Kavish.", threadId: "answerer", usage: null };
        // Asker turn 2: got the answer, report back (no mention).
        return { output: "Answerer says Kavish.", threadId: "asker", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner));
    const asker = await service.createAgent({ name: "Asker" });
    await service.createAgent({ name: "Answerer" });
    const root = await service.sendMessage(asker.id, "ask Answerer who csgod is and tell me");
    await expect.poll(() => service.getTrace(root.message.id).runs.filter((r) => r.status === "completed").length).toBe(3);
    await expect.poll(() => service.getTrace(root.message.id).live).toBe(false);
    const trace = service.getTrace(root.message.id);
    expect(trace.runs.map((run) => service.getAgent(run.agentId).name)).toEqual(["Asker", "Answerer", "Asker"]);
    const second = prompts[2];
    expect(second?.agent).toBe("Asker");
    expect(second?.prompt).toContain("Kavish.");
    expect(second?.prompt).toContain("Chain context");
    // The answer did not mention Asker; it was routed by lineage. Asker's report mentions nobody, so nothing else wakes.
    const answer = trace.messages.find((m) => m.content === "Kavish.");
    expect(answer?.content).not.toContain("@");
    expect(trace.runs).toHaveLength(3);
    // The relay goes back to where Asker was originally asked: the user's DM, not #general.
    const report = trace.messages.find((m) => m.content === "Answerer says Kavish.");
    expect(report?.channelId).toBe(asker.dmChannelId);
    expect(trace.runs[2]?.replyChannelId).toBe(asker.dmChannelId);
    expect(second?.prompt).toContain("where you were originally asked");
  });
});

describe("Effective policy", () => {
  it("lifts denies covered by a once-grant for the bound run only", async () => {
    const { service } = await makeService();
    const agent = await service.createAgent({ name: "Worker" });
    const store = (service as unknown as { store: JsonStore }).store;
    await store.mutate((database) =>
      database.grants.push({
        id: "g1",
        agentId: agent.id,
        action: "shell:exec",
        resource: "cmd:curl",
        approvalId: "a1",
        runId: "run-1",
        createdAt: new Date().toISOString(),
      }),
    );
    const bound = service.effectivePolicy(service.getAgent(agent.id), "run-1");
    expect(evaluate(bound, "shell:exec", "cmd:curl https://x").effect).toBe("allow");
    expect(renderExecPolicyRules(bound)).not.toContain('"curl"');
    const other = service.effectivePolicy(service.getAgent(agent.id), "run-2");
    expect(evaluate(other, "shell:exec", "cmd:curl https://x").effect).toBe("deny");
    expect(renderExecPolicyRules(other)).toContain('"curl"');
  });
});

describe("Capability requests", () => {
  it("posts the request in the working channel and grants once, forever, or denies", async () => {
    let service!: AgentService;
    let phase: "ask" | "use" = "ask";
    const seen: Array<{ effect: string; action: string }> = [];
    const runner: AgentRunner = {
      run: async (request) => {
        const id = { agentId: request.agentId, runId: request.runId, expiresAt: Date.now() + 60_000 };
        if (phase === "ask") {
          await service.agentRequestCapability(id, { action: "net:access", reason: "need to fetch docs" });
          return { output: "Asked for network access.", threadId: "t", usage: null };
        }
        const verdict = await service.evaluateToolCall(id, "web_search", { query: "x" });
        seen.push({ effect: verdict.effect, action: verdict.action ?? "" });
        return { output: "web search " + verdict.effect, threadId: "t", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    ({ service } = await makeService(runner));
    const agent = await service.createAgent({ name: "Worker" });
    const general = service.getChannelByName("general");
    await service.postUserMessage(general.id, "@worker fetch the docs");
    await expect.poll(() => service.overview().approvals.length).toBe(1);
    const approval = service.overview().approvals[0];
    expect(approval).toMatchObject({ kind: "capability", channelId: general.id, capability: { action: "net:access", resource: "*" } });
    expect(service.getMessages(general.id).find((m) => m.approvalId === approval?.id)).toMatchObject({ kind: "approval" });
    const approvalsChannel = service.getChannelByName("approvals");
    expect(service.getMessages(approvalsChannel.id).find((m) => m.approvalId === approval?.id)).toMatchObject({
      kind: "approval",
      content: expect.stringContaining("(in #general)"),
    });
    await expect.poll(() => service.getAgent(agent.id).status).toBe("ready");

    // Allow once: the grant is bound to the wake-up run and the hook allows there; it is gone afterwards.
    phase = "use";
    await service.resolveApproval(approval?.id ?? "", "allow_once");
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toEqual({ effect: "allow", action: "net:access" });
    await expect.poll(() => service.getRuns(agent.id)[0]?.status).toBe("completed");
    expect(service.getAgent(agent.id).policy.statements.some((s) => s.actions.includes("net:access") && s.effect === "allow")).toBe(false);
    const runs = service.getRuns(agent.id);
    expect(runs[0]?.channelId).toBe(general.id);
    expect(service.getMessages(general.id).some((m) => m.kind === "system" && m.content.startsWith("Allowed once"))).toBe(true);
    expect(service.getMessages(approvalsChannel.id).some((m) => m.kind === "system" && m.content.startsWith("Allowed once"))).toBe(true);
    // A later run without the grant is denied again.
    await service.postUserMessage(general.id, "@worker try again");
    await expect.poll(() => seen.length).toBe(2);
    expect(seen[1]?.effect).toBe("deny");

    // Allow forever: policy updated, later runs allowed.
    phase = "ask";
    await service.postUserMessage(general.id, "@worker fetch it once more");
    await expect.poll(() => service.overview().approvals.length).toBe(1);
    phase = "use";
    await service.resolveApproval(service.overview().approvals[0]?.id ?? "", "allow_forever");
    await expect.poll(() => seen.length).toBe(3);
    expect(seen[2]?.effect).toBe("allow");
    const updated = service.getAgent(agent.id).policy;
    expect(updated.statements.at(-1)).toEqual({ effect: "allow", actions: ["net:access"], resources: ["*"] });
    expect(updated.statements.some((s) => s.effect === "deny" && s.actions.includes("net:access"))).toBe(false);
    expect(evaluate(updated, "net:access", "web").effect).toBe("allow");
    expect(service.getDecisions(agent.id).find((d) => d.tool === "request_capability")).toMatchObject({
      effect: "allow",
      reason: expect.stringContaining("policy updated"),
    });

    // Already-allowed requests are rejected; deny records a decision.
    const denyAgent = await service.createAgent({ name: "Other" });
    await expect(
      service.agentRequestCapability(
        { agentId: denyAgent.id, runId: "r", expiresAt: Date.now() + 1000 },
        { action: "shell:exec", reason: "x" },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const req = await service.agentRequestCapability(
      { agentId: denyAgent.id, runId: "r", expiresAt: Date.now() + 1000 },
      { action: "shell:exec", resource: "cmd:git push", reason: "ship it" },
    );
    expect(req.channelId).toBe(denyAgent.dmChannelId);
    const denied = await service.resolveApproval(req.id, "deny");
    expect(denied.status).toBe("denied");
    expect(service.getDecisions(denyAgent.id)[0]).toMatchObject({ effect: "deny", action: "shell:exec", resource: "cmd:git push" });
  });
});
