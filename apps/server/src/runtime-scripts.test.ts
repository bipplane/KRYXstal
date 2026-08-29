import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scripts = fileURLToPath(new URL("../../../runtime/", import.meta.url));
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

interface Seen {
  path: string;
  method: string;
  auth: string;
  body: unknown;
}

async function fakeControlPlane(
  handler: (seen: Seen) => { status?: number; body: unknown },
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const record: Seen = {
        path: request.url ?? "",
        method: request.method ?? "",
        auth: request.headers.authorization ?? "",
        body: raw ? JSON.parse(raw) : null,
      };
      seen.push(record);
      const result = handler(record);
      response.writeHead(result.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: "http://127.0.0.1:" + port, seen };
}

function runScript(
  file: string,
  env: Record<string, string>,
  stdin: string,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scripts + file], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, code: code ?? 1 }));
    child.stdin.end(stdin);
  });
}

describe("iam-hook.mjs", () => {
  it("forwards the tool call with the run token and stays silent on allow", async () => {
    const plane = await fakeControlPlane(() => ({ body: { effect: "allow", reason: "ok" } }));
    const result = await runScript(
      "iam-hook.mjs",
      { LAUNCHPAD_URL: plane.url, AGENT_TOKEN: "tok" },
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(plane.seen[0]).toMatchObject({
      path: "/api/iam/evaluate",
      method: "POST",
      auth: "Bearer tok",
      body: { tool_name: "Bash", tool_input: { command: "ls" } },
    });
  });

  it("returns a PreToolUse deny decision when the policy denies", async () => {
    const plane = await fakeControlPlane(() => ({ body: { effect: "deny", reason: "nope" } }));
    const result = await runScript(
      "iam-hook.mjs",
      { LAUNCHPAD_URL: plane.url, AGENT_TOKEN: "tok" },
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
    );
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "nope",
      },
    });
  });

  it("fails closed when the control plane is unreachable or identity is missing", async () => {
    const unreachable = await runScript(
      "iam-hook.mjs",
      { LAUNCHPAD_URL: "http://127.0.0.1:1", AGENT_TOKEN: "tok" },
      JSON.stringify({ tool_name: "Bash", tool_input: {} }),
    );
    expect(JSON.parse(unreachable.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const missing = await runScript("iam-hook.mjs", {}, JSON.stringify({ tool_name: "Bash" }));
    expect(JSON.parse(missing.stdout).hookSpecificOutput.permissionDecisionReason).toContain(
      "AGENT_TOKEN",
    );
  });
});

describe("mcp-launchpad.mjs", () => {
  it("speaks MCP over stdio and proxies tool calls to the control plane", async () => {
    const plane = await fakeControlPlane((seen) =>
      seen.path.endsWith("/messages")
        ? { status: 201, body: { message: { id: "m1", content: seen.body && (seen.body as { content: string }).content } } }
        : { status: 403, body: { error: "Denied: not a member" } },
    );
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "post_message", arguments: { channel: "general", content: "hello" } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "spawn_agent", arguments: { name: "x", instructions: "y" } },
      },
    ];
    const result = await runScript(
      "mcp-launchpad.mjs",
      { LAUNCHPAD_URL: plane.url, AGENT_TOKEN: "tok" },
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    const responses = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    const byId = new Map(responses.map((response) => [response.id, response.result]));
    expect(byId.get(1)).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "launchpad" } });
    const tools = byId.get(2)?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toContain("post_message");
    expect(tools.map((tool) => tool.name)).toContain("spawn_agent");
    const posted = byId.get(3) as { content: Array<{ text: string }>; isError?: boolean };
    expect(posted.isError).toBeUndefined();
    expect(posted.content[0]?.text).toContain('"hello"');
    const denied = byId.get(4) as { content: Array<{ text: string }>; isError?: boolean };
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("Denied");
    expect(plane.seen.map((seen) => seen.path)).toEqual([
      "/api/agent/channels/general/messages",
      "/api/agent/spawn",
    ]);
    expect(plane.seen.every((seen) => seen.auth === "Bearer tok")).toBe(true);
  });
});
