#!/usr/bin/env node
// Codex PreToolUse hook: asks the Launchpad control plane whether the calling
// agent's IAM policy allows this tool call. Fails closed.
//
// stdin:  Codex hook payload { hook_event_name, tool_name, tool_input, ... }
// stdout: nothing (allow) or a PreToolUse deny decision.

const BASE_URL = (process.env.LAUNCHPAD_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.AGENT_TOKEN ?? "";
const TIMEOUT_MS = 8000;

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n",
  );
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let payload;
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    deny("IAM hook could not parse the tool call");
    return;
  }
  if (payload.hook_event_name && payload.hook_event_name !== "PreToolUse") return;
  if (!BASE_URL || !TOKEN) {
    deny("IAM hook is missing LAUNCHPAD_URL or AGENT_TOKEN");
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(BASE_URL + "/api/iam/evaluate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + TOKEN,
      },
      body: JSON.stringify({
        tool_name: payload.tool_name ?? "",
        tool_input: payload.tool_input ?? null,
        session_id: payload.session_id ?? null,
        turn_id: payload.turn_id ?? null,
        tool_use_id: payload.tool_use_id ?? null,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      deny("IAM service rejected the check (" + response.status + "): " + (body.error ?? ""));
      return;
    }
    if (body.effect !== "allow") {
      deny(body.reason ?? "Denied by IAM policy");
    }
  } catch (error) {
    deny("IAM service unreachable: " + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
