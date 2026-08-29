import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveSandboxMode,
  enabledMcpTools,
  renderCodexHome,
  renderConfigToml,
} from "./codex-home.js";
import { loadConfig } from "./config.js";
import { presetPolicy } from "./policy.js";
import type { Agent } from "./types.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const config = loadConfig({
  NODE_ENV: "test",
  ARK_API_KEY: "key",
  ARK_MODEL: "ep-123",
  RUNTIME_PROVIDER: "container",
});

const agent = (preset: "reader" | "worker" | "deployer" | "admin"): Agent => ({
  id: "agent-1",
  kind: "principal",
  name: "worker",
  description: "",
  instructions: "",
  status: "ready",
  principalId: "agent-1",
  parentAgentId: null,
  policy: presetPolicy(preset),
  dmChannelId: null,
  workspacePath: "/tmp/ws",
  codexThreadId: null,
  lastError: null,
  createdAt: "",
  updatedAt: "",
  expiresAt: null,
});

describe("Per-agent $CODEX_HOME", () => {
  it("exposes only the MCP tools the policy can ever grant", () => {
    expect(enabledMcpTools(agent("reader"))).toEqual(["list_channels", "read_channel"]);
    expect(enabledMcpTools(agent("worker"))).toEqual([
      "list_channels",
      "read_channel",
      "post_message",
      "spawn_agent",
      "close_agent",
      "request_principal",
    ]);
    expect(enabledMcpTools(agent("admin"))).toContain("create_channel");
  });

  it("tightens the sandbox and network from the policy", () => {
    expect(effectiveSandboxMode(config, agent("reader"))).toBe("read-only");
    expect(effectiveSandboxMode(config, agent("worker"))).toBe("workspace-write");
    const toml = renderConfigToml({ dir: "/x", config, agent: agent("worker"), scriptsDir: "/opt/launchpad" });
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain('default_tools_approval_mode = "approve"');
    expect(toml).toContain("network_access = false");
    expect(toml).toContain("multi_agent = false");
    expect(toml).toContain('web_search = "disabled"');
    expect(toml).toContain('args = ["/opt/launchpad/mcp-launchpad.mjs"]');
    expect(toml).toContain('env_vars = ["LAUNCHPAD_URL", "AGENT_TOKEN"]');
    expect(toml).toContain('enabled_tools = ["list_channels", "read_channel", "post_message"');
    expect(toml).toContain('exclude = ["AGENT_TOKEN", "ARK_API_KEY", "LAUNCHPAD_URL"]');
    expect(toml).toContain('base_url = "https://ark.cn-beijing.volces.com/api/v3"');
    const deployer = renderConfigToml({ dir: "/x", config, agent: agent("deployer"), scriptsDir: "/o" });
    expect(deployer).toContain("network_access = true");
    expect(deployer).toContain('web_search = "live"');
  });

  it("uses the local Codex login instead of Ark in local-codex mode", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "local-codex-"));
    temporaryDirectories.push(home);
    await writeFile(path.join(home, "auth.json"), "{}");
    const local = loadConfig({
      NODE_ENV: "test",
      MODEL_PROVIDER: "local-codex",
      LOCAL_CODEX_HOME: home,
      CODEX_MODEL: "gpt-5.5",
    });
    const toml = renderConfigToml({ dir: "/x", config: local, agent: agent("worker"), scriptsDir: "/o" });
    expect(toml).not.toContain("volcengine_ark");
    expect(toml).toContain('model = "gpt-5.5"');
    const dir = await mkdtemp(path.join(tmpdir(), "codex-home-"));
    temporaryDirectories.push(dir);
    await renderCodexHome({ dir, config: local, agent: agent("worker"), scriptsDir: "/o" });
    expect(await readlink(path.join(dir, "auth.json"))).toBe(path.join(home, "auth.json"));
    await renderCodexHome({ dir, config: local, agent: agent("worker"), scriptsDir: "/o" });
    const empty = await mkdtemp(path.join(tmpdir(), "no-auth-"));
    temporaryDirectories.push(empty);
    const missing = loadConfig({ NODE_ENV: "test", MODEL_PROVIDER: "local-codex", LOCAL_CODEX_HOME: empty });
    await expect(
      renderCodexHome({ dir, config: missing, agent: agent("worker"), scriptsDir: "/o" }),
    ).rejects.toThrow("codex login");
  });

  it("renders external MCP servers with per-agent tool allowlists", () => {
    const toml = renderConfigToml({
      dir: "/x",
      config,
      agent: agent("worker"),
      scriptsDir: "/o",
      integrations: [
        { name: "linear", kind: "http", url: "https://mcp.linear.app/mcp", command: null, args: [], enabledTools: ["list_issues"] },
        { name: "local", kind: "stdio", url: null, command: "node", args: ["srv.mjs"], enabledTools: null },
      ],
    });
    expect(toml.startsWith('mcp_oauth_credentials_store = "file"')).toBe(true);
    expect(toml).toContain("[mcp_servers.linear]\nurl = \"https://mcp.linear.app/mcp\"\nenabled_tools = [\"list_issues\"]");
    expect(toml).toContain("[mcp_servers.local]\ncommand = \"node\"\nargs = [\"srv.mjs\"]\ndefault_tools_approval_mode");
    expect(toml).not.toContain("[mcp_servers.local]\ncommand = \"node\"\nargs = [\"srv.mjs\"]\nenabled_tools");
  });

  it("writes config, rules and hooks files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-home-"));
    temporaryDirectories.push(dir);
    await renderCodexHome({ dir, config, agent: agent("worker"), scriptsDir: "/opt/launchpad" });
    const rules = await readFile(path.join(dir, "rules", "policy.rules"), "utf8");
    expect(rules).toContain('pattern=["sudo"]');
    const hooks = JSON.parse(await readFile(path.join(dir, "hooks.json"), "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(hooks.hooks.PreToolUse[0]?.matcher).toBe(".*");
    expect(hooks.hooks.PreToolUse[0]?.hooks[0]?.command).toBe('node "/opt/launchpad/iam-hook.mjs"');
    expect(await readFile(path.join(dir, "config.toml"), "utf8")).toContain("[mcp_servers.launchpad]");
  });
});
