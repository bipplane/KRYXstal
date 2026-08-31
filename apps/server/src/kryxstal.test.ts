import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ),
  );
});

async function makeService(
  run: (request: RunnerRequest) => Promise<RunnerResult>,
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "kryxstal-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const runner: AgentRunner = {
    run,
    cancel: async () => false,
    isAvailable: async () => true,
  };
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("KRYXstal observability middleware", () => {
  it("correlates a user prompt, run, runtime event, tool decision, and reply", async () => {
    let service!: AgentService;
    service = await makeService(async (request) => {
      request.onEvent?.({
        id: "event-1",
        type: "command_execution",
        summary: "npm test",
        status: "completed",
        exitCode: 0,
        detail: "Tests passed",
        createdAt: new Date().toISOString(),
      });
      const decision = await service.evaluateToolCall(
        { agentId: request.agentId, runId: request.runId, expiresAt: Date.now() + 60_000 },
        "Bash",
        { command: "npm test" },
      );
      expect(decision.effect).toBe("allow");
      return { output: "Tests passed.", threadId: "thread-1", usage: null };
    });

    const agent = await service.createAgent({ name: "Tester" });
    const root = await service.sendMessage(agent.id, "Run automated tests");
    await expect.poll(() => service.getTrace(root.message.id).live).toBe(false);

    const trace = service.getTrace(root.message.id);
    expect(trace.rootId).toBe(root.message.id);
    expect(trace.messages.map((message) => message.content)).toEqual([
      "Run automated tests",
      "Tests passed.",
    ]);
    expect(trace.runs).toHaveLength(1);
    expect(trace.runs[0]).toMatchObject({
      traceId: root.message.id,
      triggerMessageId: root.message.id,
      status: "completed",
    });
    expect(trace.runs[0]?.events).toContainEqual(
      expect.objectContaining({ type: "command_execution", summary: "npm test", exitCode: 0 }),
    );
    expect(trace.decisions).toContainEqual(
      expect.objectContaining({
        traceId: root.message.id,
        source: "hook",
        action: "shell:exec",
        resource: "cmd:npm test",
        effect: "allow",
      }),
    );
  });

  it("keeps denied action and explanation in same causal trace", async () => {
    let service!: AgentService;
    service = await makeService(async (request) => {
      const decision = await service.evaluateToolCall(
        { agentId: request.agentId, runId: request.runId, expiresAt: Date.now() + 60_000 },
        "Bash",
        { command: "rm -rf /" },
      );
      expect(decision.effect).toBe("deny");
      return { output: "[no reply]", threadId: "thread-2", usage: null };
    });

    const agent = await service.createAgent({ name: "Guarded" });
    const root = await service.sendMessage(agent.id, "Delete protected files");
    await expect.poll(() => service.getTrace(root.message.id).live).toBe(false);

    const trace = service.getTrace(root.message.id);
    expect(trace.decisions).toContainEqual(
      expect.objectContaining({
        traceId: root.message.id,
        source: "hook",
        action: "shell:exec",
        resource: "cmd:rm -rf /",
        effect: "deny",
        reason: expect.any(String),
      }),
    );
    expect(trace.messages).toContainEqual(
      expect.objectContaining({ traceId: root.message.id, kind: "denial" }),
    );
    expect(trace.runs[0]).toMatchObject({ status: "completed", silent: true });
  });
});
