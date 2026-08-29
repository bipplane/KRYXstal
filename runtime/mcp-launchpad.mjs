#!/usr/bin/env node
// Minimal MCP (stdio, newline-delimited JSON-RPC 2.0) server that exposes the
// Launchpad channel + delegation tools to Codex. Every call is forwarded to the
// control plane with the agent's per-run identity token; the control plane is
// the authority on what the agent may do.

import { createInterface } from "node:readline";

const BASE_URL = (process.env.LAUNCHPAD_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.AGENT_TOKEN ?? "";
const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "list_channels",
    description: "List the channels this agent can see, with member names and descriptions.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_channel",
    description:
      "Read the most recent messages in a channel. Reading counts as having seen the channel, " +
      "which is required before you may post to it.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name without the leading #" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
      },
      required: ["channel"],
      additionalProperties: false,
    },
  },
  {
    name: "post_message",
    description:
      "Post a message to a channel as yourself. Mention another agent with @name to wake it. " +
      "Accepted only if you have seen the whole channel; if another agent acted first you get a " +
      "conflict naming who won and what they posted: read_channel again, reconsider, and post " +
      "something new rather than the same text.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name without the leading #" },
        content: { type: "string" },
      },
      required: ["channel", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "create_channel",
    description:
      "Create a new channel and join it, optionally inviting other agents by name. " +
      "If the name already exists you get a conflict; use the existing channel instead.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        description: { type: "string" },
        members: { type: "array", items: { type: "string" } },
      },
      required: ["channel"],
      additionalProperties: false,
    },
  },
  {
    name: "spawn_agent",
    description:
      "Spawn a subagent session that acts under your identity with a subset of your permissions. " +
      "It gets a fresh workspace and a DM channel with you; it is woken by messages there or by @mention.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short role name, e.g. tester" },
        instructions: { type: "string", description: "What the session should do" },
        actions: {
          type: "array",
          items: { type: "string" },
          description:
            "Actions to delegate (subset of your delegable set), e.g. shell:exec, fs:write",
        },
        channels: {
          type: "array",
          items: { type: "string" },
          description: "Channels the session may read and post to",
        },
        task: { type: "string", description: "First message to send the session" },
      },
      required: ["name", "instructions"],
      additionalProperties: false,
    },
  },
  {
    name: "close_agent",
    description: "Close a session you spawned. Its work stays in its archived workspace.",
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string" } },
      required: ["agent_id"],
      additionalProperties: false,
    },
  },
  {
    name: "request_principal",
    description:
      "Ask the human to create a new long-lived agent (principal). Only humans can create principals; " +
      "this posts an approval request in #approvals.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        instructions: { type: "string" },
        preset: { type: "string", enum: ["reader", "worker", "deployer", "admin"] },
        channels: { type: "array", items: { type: "string" } },
      },
      required: ["name", "instructions", "preset"],
      additionalProperties: false,
    },
  },
];

const ROUTES = {
  list_channels: () => ["GET", "/api/agent/channels"],
  read_channel: (args) => [
    "GET",
    "/api/agent/channels/" + encodeURIComponent(args.channel) + "/messages?limit=" + (args.limit ?? 30),
  ],
  post_message: (args) => [
    "POST",
    "/api/agent/channels/" + encodeURIComponent(args.channel) + "/messages",
    { content: args.content },
  ],
  create_channel: (args) => [
    "POST",
    "/api/agent/channels",
    { name: args.channel, description: args.description ?? "", members: args.members ?? [] },
  ],
  spawn_agent: (args) => ["POST", "/api/agent/spawn", args],
  close_agent: (args) => ["POST", "/api/agent/close", { agentId: args.agent_id }],
  request_principal: (args) => ["POST", "/api/agent/requests", args],
};

async function callControlPlane(method, route, body) {
  const response = await fetch(BASE_URL + route, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error ?? "Control plane returned " + response.status);
  }
  return data;
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const route = ROUTES[name];
  if (!route) {
    respond(id, {
      content: [{ type: "text", text: "Unknown tool: " + name }],
      isError: true,
    });
    return;
  }
  if (!BASE_URL || !TOKEN) {
    respond(id, {
      content: [{ type: "text", text: "Launchpad identity is not configured for this run." }],
      isError: true,
    });
    return;
  }
  try {
    const [method, path, body] = route(args);
    const data = await callControlPlane(method, path, body);
    respond(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  } catch (error) {
    respond(id, {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    });
  }
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "launchpad", version: "1.0.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
  if (method === "ping") {
    respond(id, {});
    return;
  }
  if (method === "tools/list") {
    respond(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    await handleToolCall(id, params);
    return;
  }
  if (id !== undefined) fail(id, -32601, "Method not found: " + method);
}

const inflight = new Set();
const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    fail(null, -32700, "Parse error");
    return;
  }
  const task = handle(message)
    .catch((error) => {
      if (message.id !== undefined) {
        fail(message.id, -32603, error instanceof Error ? error.message : String(error));
      }
    })
    .finally(() => inflight.delete(task));
  inflight.add(task);
});
reader.on("close", () => {
  void Promise.allSettled([...inflight]).then(() => process.exit(0));
});
