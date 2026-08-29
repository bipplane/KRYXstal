import { spawn } from "node:child_process";
import type { IntegrationTool } from "./types.js";

/**
 * Minimal MCP client used only for tool discovery (`initialize` + `tools/list`).
 * Supports streamable HTTP (JSON or SSE responses) with an optional bearer
 * token, and stdio servers speaking newline-delimited JSON-RPC.
 */

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "volc-agent-launchpad", version: "1.0.0" };

interface JsonRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RawTool {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean };
}

export function toolsFromResult(result: unknown): IntegrationTool[] {
  const tools = (result as { tools?: RawTool[] } | undefined)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => typeof tool.name === "string")
    .map((tool) => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description.slice(0, 300) : "",
      readOnly: tool.annotations?.readOnlyHint === true,
    }));
}

/** Parses either a plain JSON body or an SSE stream and returns the JSON-RPC messages inside. */
export function parseMcpHttpBody(contentType: string, body: string): JsonRpcResponse[] {
  if (contentType.includes("text/event-stream")) {
    const messages: JsonRpcResponse[] = [];
    for (const block of body.split(/\n\n+/)) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        messages.push(JSON.parse(data) as JsonRpcResponse);
      } catch {
        // ignore non-JSON events
      }
    }
    return messages;
  }
  const trimmed = body.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcResponse[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function discoverHttpTools(
  url: string,
  accessToken: string | null,
  timeoutMs = 15_000,
): Promise<IntegrationTool[]> {
  let sessionId: string | null = null;
  const call = async (id: number | null, method: string, params: unknown): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL_VERSION,
          ...(accessToken ? { authorization: "Bearer " + accessToken } : {}),
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(
          id === null
            ? { jsonrpc: "2.0", method, params }
            : { jsonrpc: "2.0", id, method, params },
        ),
        signal: controller.signal,
      });
      const newSession = response.headers.get("mcp-session-id");
      if (newSession) sessionId = newSession;
      if (id === null) {
        await response.text().catch(() => "");
        return undefined;
      }
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          "MCP server returned " + response.status + (text ? ": " + text.slice(0, 200) : ""),
        );
      }
      const messages = parseMcpHttpBody(response.headers.get("content-type") ?? "", text);
      const reply = messages.find((message) => message.id === id);
      if (!reply) throw new Error("MCP server sent no response for " + method);
      if (reply.error) throw new Error(reply.error.message);
      return reply.result;
    } finally {
      clearTimeout(timer);
    }
  };
  await call(1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  await call(null, "notifications/initialized", {});
  const result = await call(2, "tools/list", {});
  return toolsFromResult(result);
}

export function discoverStdioTools(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 15_000,
): Promise<IntegrationTool[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let settled = false;
    const finish = (error: Error | null, tools: IntegrationTool[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(tools);
    };
    const timer = setTimeout(() => finish(new Error("MCP server did not answer in time")), timeoutMs);
    child.once("error", (error) => finish(error));
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue;
        }
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        } else if (message.id === 2) {
          if (message.error) finish(new Error(message.error.message));
          else finish(null, toolsFromResult(message.result));
        }
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      }) + "\n",
    );
  });
}
