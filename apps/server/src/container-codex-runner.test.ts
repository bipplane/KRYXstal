import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  containerName,
} from "./container-codex-runner.js";
import type { RunnerRequest } from "./types.js";

const request = (overrides: Partial<RunnerRequest> = {}): RunnerRequest => ({
  agentId: "agent/unsafe",
  runId: "run-1",
  workspacePath: "/tmp/agent-workspace",
  codexHome: "/tmp/codex-home/agents/agent",
  prompt: "write a small program",
  threadId: null,
  sandboxMode: "workspace-write",
  env: { AGENT_TOKEN: "secret-run-token", LAUNCHPAD_URL: "http://host.docker.internal:3000" },
  ...overrides,
});

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
      RUNTIME_SCRIPTS_DIR: "/srv/launchpad/runtime",
    });
    const args = buildContainerRunArgs(request(), config);

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain("type=bind,src=/tmp/codex-home/agents/agent,dst=/codex-home");
    expect(args).toContain("type=bind,src=/srv/launchpad/runtime,dst=/opt/launchpad,readonly");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("--dangerously-bypass-hook-trust");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    // Identity is passed by name only; the values travel in the process env.
    expect(args).toContain("AGENT_TOKEN");
    expect(args).not.toContain("secret-run-token");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
    expect(args).not.toContain("host.docker.internal:host-gateway");
  });

  it("resumes a thread inside the mounted Runtime workspace and maps the Docker host", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      request({ prompt: "continue", threadId: "thread-123", sandboxMode: "read-only" }),
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).toContain("read-only");
    expect(args).toContain("host.docker.internal:host-gateway");
    expect(args).not.toContain("keep-id");
    expect(config.agentApiBaseUrl).toBe("http://host.docker.internal:3000");
  });
});
