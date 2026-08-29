import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { renderCodexHome } from "./codex-home.js";
import { IntegrationService } from "./integration-service.js";
import { parseMcpHttpBody } from "./mcp-client.js";
import { presetPolicy } from "./policy.js";
import { JsonStore } from "./store.js";
import type { Agent, Policy } from "./types.js";

const scripts = fileURLToPath(new URL("../../../runtime/", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ),
  );
});

async function makeService(codexBin?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-integ-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    CODEX_HOME: path.join(root, "codex"),
    MCP_OAUTH_CALLBACK_PORT: "4599",
    ...(codexBin ? { CODEX_BIN: codexBin } : {}),
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  await store.initialize();
  const service = new IntegrationService(config, store);
  await service.initialize();
  return { service, store, config, root };
}

const agentWith = (policy: Policy): Agent => ({
  id: "agent-1",
  kind: "principal",
  ownIntegrationIds: [],
  name: "worker",
  description: "",
  instructions: "",
  status: "ready",
  principalId: "agent-1",
  parentAgentId: null,
  policy,
  dmChannelId: null,
  workspacePath: "/tmp/ws",
  codexThreadId: null,
  lastError: null,
  createdAt: "",
  updatedAt: "",
  expiresAt: null,
});

describe("IntegrationService", () => {
  it("registers a stdio server, discovers its tools, and scopes them per agent", async () => {
    const { service } = await makeService();
    const integration = await service.create({
      name: "chan",
      kind: "stdio",
      command: process.execPath,
      args: [scripts + "mcp-launchpad.mjs"],
    });
    expect(integration.status).toBe("connected");
    expect(integration.auth).toBe("none");
    const names = integration.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["post_message", "read_channel", "spawn_agent"]));
    expect(integration.tools.find((tool) => tool.name === "read_channel")?.readOnly).toBe(true);

    expect(service.forAgent(agentWith(presetPolicy("worker")))).toEqual([]);
    const reader: Policy = {
      preset: "custom",
      statements: [
        { effect: "allow", actions: ["mcp:chan:read_*", "mcp:chan:list_channels"], resources: ["*"] },
        { effect: "deny", actions: ["mcp:chan:post_message"], resources: ["*"] },
      ],
      delegable: [],
    };
    const [view] = service.forAgent(agentWith(reader));
    expect(view?.enabledTools?.sort()).toEqual(["list_channels", "read_channel"]);
    expect(service.forAgent(agentWith(presetPolicy("admin")))[0]?.enabledTools).toContain("post_message");

    await expect(service.create({ name: "chan", kind: "stdio", command: "x" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.create({ name: "Bad Name", kind: "http", url: "https://x" })).rejects.toMatchObject({ statusCode: 400 });
    await service.remove(integration.id);
    expect(service.list()).toEqual([]);
  });

  it("runs codex mcp login, returns the authorize URL, and marks the integration connected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fake-codex-"));
    temporaryDirectories.push(root);
    const fake = path.join(root, "codex");
    // Fake `codex`: records argv + CODEX_HOME, prints an authorize URL, writes credentials, exits 0.
    await writeFile(
      fake,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" > "$CODEX_HOME/argv.txt"',
        'if echo "$*" | grep -q "mcp login"; then',
        '  echo "Authorize \\`linear\\` by opening this URL in your browser:"',
        '  echo "https://mcp.linear.app/authorize?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A4599%2Fcallback"',
        "  sleep 0.3",
        '  printf \'{"https://mcp.linear.app/mcp":{"url":"https://mcp.linear.app/mcp","token_response":{"access_token":"tok-123"}}}\' > "$CODEX_HOME/.credentials.json"',
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    await chmod(fake, 0o755);
    const { service, store, config } = await makeService(fake);
    const integration = await service.create({ name: "linear", kind: "http", url: "https://mcp.linear.app/mcp" });
    expect(integration.status).toBe("unconnected");

    const login = await service.startLogin(integration.id, null);
    expect(login.url).toContain("mcp.linear.app/authorize");
    expect(login.agentId).toBeNull();
    const argv = await readFile(path.join(service.oauthHome, "argv.txt"), "utf8");
    expect(argv).toContain('mcp_oauth_credentials_store="file"');
    expect(argv).toContain("mcp_oauth_callback_port=4599");
    expect(argv).toContain("mcp login linear");
    await expect.poll(() => service.get(integration.id).status).toBe("connected");
    expect(await service.readAccessToken(service.sharedCredentialsFile(), service.get(integration.id))).toBe("tok-123");
    // Discovery against the real network is not attempted in tests; the failed attempt is recorded, status stays connected.
    expect(service.get(integration.id).status).toBe("connected");

    // The shared credentials are copied into an agent's home when its policy can use the server.
    const agent = agentWith({ preset: "custom", statements: [{ effect: "allow", actions: ["mcp:linear:*"], resources: ["*"] }], delegable: [] });
    const home = path.join(config.codexHome, "agents", agent.id);
    await renderCodexHome({
      dir: home,
      config,
      agent,
      scriptsDir: "/o",
      integrations: service.forAgent(agent).map((entry) => ({
        name: entry.integration.name,
        kind: entry.integration.kind,
        url: entry.integration.url,
        command: entry.integration.command,
        args: entry.integration.args,
        enabledTools: entry.enabledTools,
      })),
      credentialsFile: await service.credentialsFor(agent),
    });
    expect(await readFile(path.join(home, ".credentials.json"), "utf8")).toContain("tok-123");
    expect(await readFile(path.join(home, "config.toml"), "utf8")).toContain("[mcp_servers.linear]");

    // Per-agent login lands in the agent's own home and is remembered on the agent.
    await store.mutate((database) => database.agents.push(agent));
    const own = await service.startLogin(integration.id, agent);
    expect(own.agentId).toBe(agent.id);
    await expect.poll(() => store.peek().agents[0]?.ownIntegrationIds).toEqual([integration.id]);
    expect(await readFile(path.join(home, ".credentials.json"), "utf8")).toContain("tok-123");
    expect(await service.credentialsFor({ ...agent, ownIntegrationIds: [integration.id] })).toBeNull();

    await service.logout(integration.id, null);
    expect(service.get(integration.id).status).toBe("unconnected");
  });
});

describe("MCP HTTP body parsing", () => {
  it("reads JSON and SSE encoded JSON-RPC responses", () => {
    expect(parseMcpHttpBody("application/json", '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}')).toEqual([
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ]);
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"a"}]}}\n\n';
    expect(parseMcpHttpBody("text/event-stream", sse)[0]?.result).toEqual({ tools: [{ name: "a" }] });
  });
});
