import { ACTIONS, type Effect, type Policy, type Statement } from "./types.js";

/**
 * IAM-style policy engine.
 *
 * Semantics (same as AWS IAM): an explicit deny always wins, otherwise any
 * matching allow grants, otherwise implicit deny. Action and resource patterns
 * are globs where `*` matches anything. `cmd:` resources match by argv-token
 * prefix so `cmd:rm -rf` covers `cmd:rm -rf /tmp/x` but not `cmd:rm -r`.
 */

export const PRESETS: Record<Exclude<Policy["preset"], "custom">, Policy> = {
  reader: {
    preset: "reader",
    statements: [
      { effect: "allow", actions: ["channel:read"], resources: ["channel:*"] },
      { effect: "allow", actions: ["shell:exec"], resources: ["cmd:*"] },
      {
        effect: "deny",
        actions: ["shell:exec"],
        resources: ["cmd:rm -rf", "cmd:sudo", "cmd:git push", "cmd:curl", "cmd:wget"],
      },
      { effect: "deny", actions: ["fs:write", "net:access"], resources: ["*"] },
    ],
    delegable: [],
  },
  worker: {
    preset: "worker",
    statements: [
      { effect: "allow", actions: ["channel:read", "channel:post"], resources: ["channel:*"] },
      { effect: "allow", actions: ["shell:exec", "fs:write"], resources: ["*"] },
      { effect: "allow", actions: ["agent:spawn", "agent:close"], resources: ["*"] },
      { effect: "allow", actions: ["principal:request"], resources: ["*"] },
      {
        effect: "deny",
        actions: ["shell:exec"],
        resources: ["cmd:rm -rf", "cmd:sudo", "cmd:git push", "cmd:curl", "cmd:wget"],
      },
      { effect: "deny", actions: ["net:access"], resources: ["*"] },
    ],
    delegable: ["channel:read", "channel:post", "shell:exec", "fs:write"],
  },
  deployer: {
    preset: "deployer",
    statements: [
      { effect: "allow", actions: ["channel:read", "channel:post"], resources: ["channel:*"] },
      { effect: "allow", actions: ["shell:exec", "fs:write", "net:access"], resources: ["*"] },
      { effect: "allow", actions: ["agent:spawn", "agent:close"], resources: ["*"] },
      { effect: "allow", actions: ["principal:request"], resources: ["*"] },
      { effect: "deny", actions: ["shell:exec"], resources: ["cmd:rm -rf /", "cmd:sudo"] },
    ],
    delegable: ["channel:read", "channel:post", "shell:exec", "fs:write", "net:access"],
  },
  admin: {
    preset: "admin",
    statements: [{ effect: "allow", actions: ["*"], resources: ["*"] }],
    delegable: ["*"],
  },
};

export const USER_POLICY: Policy = PRESETS.admin;

export function presetPolicy(name: Policy["preset"]): Policy {
  if (name === "custom") return { preset: "custom", statements: [], delegable: [] };
  return structuredClone(PRESETS[name]);
}

export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + escaped + "$", "s").test(value);
}

export function commandTokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

export function matchResource(pattern: string, value: string): boolean {
  if (pattern.startsWith("cmd:") && value.startsWith("cmd:")) {
    const patternTokens = commandTokens(pattern.slice(4));
    const valueTokens = commandTokens(value.slice(4));
    if (patternTokens.length === 0) return true;
    if (patternTokens.length > valueTokens.length) return false;
    return patternTokens.every((token, index) => matchGlob(token, valueTokens[index] ?? ""));
  }
  return matchGlob(pattern, value);
}

export function matchAction(pattern: string, action: string): boolean {
  return matchGlob(pattern, action);
}

export interface Evaluation {
  effect: Effect;
  reason: string;
  statement: Statement | null;
}

export function evaluate(policy: Policy, action: string, resource: string): Evaluation {
  let allow: Statement | null = null;
  for (const statement of policy.statements) {
    const actionHit = statement.actions.some((pattern) => matchAction(pattern, action));
    if (!actionHit) continue;
    const resourceHit = statement.resources.some((pattern) => matchResource(pattern, resource));
    if (!resourceHit) continue;
    if (statement.effect === "deny") {
      return {
        effect: "deny",
        reason: "Explicit deny for " + action + " on " + resource,
        statement,
      };
    }
    allow ??= statement;
  }
  if (allow) {
    return { effect: "allow", reason: "Allowed by policy", statement: allow };
  }
  return {
    effect: "deny",
    reason: "No statement grants " + action + " on " + resource,
    statement: null,
  };
}

/** True when some allow statement could ever grant the action (used to decide which tools to expose). */
export function mayEver(policy: Policy, action: string): boolean {
  const blanketDeny = policy.statements.some(
    (statement) =>
      statement.effect === "deny" &&
      statement.actions.some((pattern) => matchAction(pattern, action)) &&
      statement.resources.includes("*"),
  );
  if (blanketDeny) return false;
  return policy.statements.some(
    (statement) =>
      statement.effect === "allow" &&
      statement.actions.some((pattern) => matchAction(pattern, action)),
  );
}

export function normalizePolicy(input: Policy): Policy {
  const clean = (values: string[]) =>
    [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return {
    preset: input.preset,
    statements: input.statements
      .map((statement) => ({
        effect: statement.effect,
        actions: clean(statement.actions),
        resources: clean(statement.resources),
      }))
      .filter((statement) => statement.actions.length > 0 && statement.resources.length > 0),
    delegable: clean(input.delegable),
  };
}

/** Adds channel:read/post grants for the given channel names unless already covered. */
export function grantChannels(policy: Policy, channelNames: string[]): Policy {
  const next = structuredClone(policy);
  const missing = channelNames.filter((name) => {
    const resource = "channel:" + name;
    return (
      evaluate(next, "channel:read", resource).effect !== "allow" ||
      evaluate(next, "channel:post", resource).effect !== "allow"
    );
  });
  if (missing.length > 0) {
    next.statements.push({
      effect: "allow",
      actions: ["channel:read", "channel:post"],
      resources: missing.map((name) => "channel:" + name),
    });
  }
  return next;
}

export interface DelegationRequest {
  actions: string[];
  channelNames: string[];
  delegable?: string[] | undefined;
}

export interface DelegationResult {
  ok: boolean;
  reason: string;
  policy: Policy | null;
}

/**
 * Derives a session policy from a parent. Every requested action must be
 * covered by the parent's `delegable` list and be something the parent itself
 * may do; parent denies are inherited verbatim so a child can never exceed the
 * parent.
 */
export function deriveSessionPolicy(
  parent: Policy,
  request: DelegationRequest,
): DelegationResult {
  const requestedActions = [...new Set(request.actions.map((value) => value.trim()).filter(Boolean))];
  for (const action of requestedActions) {
    if (!parent.delegable.some((pattern) => matchAction(pattern, action))) {
      return { ok: false, reason: action + " is not delegable by the parent", policy: null };
    }
    if (action.startsWith("channel:")) continue;
    if (!mayEver(parent, action)) {
      return { ok: false, reason: "Parent cannot grant " + action + " it does not hold", policy: null };
    }
  }
  for (const name of request.channelNames) {
    const resource = "channel:" + name;
    for (const action of ["channel:read", "channel:post"]) {
      if (!parent.delegable.some((pattern) => matchAction(pattern, action))) {
        return { ok: false, reason: action + " is not delegable by the parent", policy: null };
      }
      if (evaluate(parent, action, resource).effect !== "allow") {
        return { ok: false, reason: "Parent lacks " + action + " on " + resource, policy: null };
      }
    }
  }
  const statements: Statement[] = [];
  const plainActions = requestedActions.filter((action) => !action.startsWith("channel:"));
  if (plainActions.length > 0) {
    statements.push({ effect: "allow", actions: plainActions, resources: ["*"] });
  }
  if (request.channelNames.length > 0) {
    statements.push({
      effect: "allow",
      actions: ["channel:read", "channel:post"],
      resources: request.channelNames.map((name) => "channel:" + name),
    });
  }
  for (const statement of parent.statements) {
    if (statement.effect === "deny") statements.push(structuredClone(statement));
  }
  const requestedDelegable = request.delegable ?? [];
  const delegable = requestedDelegable.filter(
    (candidate) =>
      parent.delegable.some((pattern) => matchAction(pattern, candidate)) &&
      requestedActions.some((action) => matchAction(candidate, action)),
  );
  return {
    ok: true,
    reason: "Delegated " + requestedActions.length + " action(s)",
    policy: { preset: "custom", statements, delegable },
  };
}

/** Execpolicy rules for every `cmd:` deny so Codex blocks the command before the hook even runs. */
export function renderExecPolicyRules(policy: Policy): string {
  const lines = [
    "# Generated by Volc Agent Launchpad from the agent's IAM policy. Do not edit.",
  ];
  for (const statement of policy.statements) {
    if (statement.effect !== "deny") continue;
    if (!statement.actions.some((pattern) => matchAction(pattern, "shell:exec"))) continue;
    for (const resource of statement.resources) {
      if (!resource.startsWith("cmd:")) continue;
      const tokens = commandTokens(resource.slice(4));
      if (tokens.length === 0 || tokens.some((token) => token.includes("*"))) continue;
      lines.push(
        "prefix_rule(pattern=" +
          JSON.stringify(tokens) +
          ', decision="forbidden", justification=' +
          JSON.stringify("Denied by IAM policy: " + resource) +
          ")",
      );
    }
  }
  return lines.join("\n") + "\n";
}

export interface ToolCallMapping {
  action: string;
  resource: string;
}

const SHELL_TOOLS = new Set([
  "Bash",
  "bash",
  "shell",
  "shell_command",
  "local_shell",
  "exec_command",
  "unified_exec",
  "container.exec",
]);
const PASSIVE_TOOLS = new Set([
  "update_plan",
  "view_image",
  "read_file",
  "list_dir",
  "grep_files",
  "write_stdin",
  "request_permissions",
]);

function commandString(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  const command = record.command ?? record.cmd ?? record.argv;
  if (Array.isArray(command)) return command.map(String).join(" ");
  if (typeof command === "string") return command;
  return "";
}

function stringArgument(input: unknown, keys: string[]): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Maps a Codex hook tool call onto an IAM action + resource. Returns null for
 * tools that never need authorisation (planning, reading).
 */
export function mapToolCall(toolName: string, toolInput: unknown): ToolCallMapping | null {
  if (PASSIVE_TOOLS.has(toolName)) return null;
  if (SHELL_TOOLS.has(toolName)) {
    return { action: "shell:exec", resource: "cmd:" + commandString(toolInput) };
  }
  if (toolName === "apply_patch") return { action: "fs:write", resource: "workspace" };
  if (toolName === "web_search") return { action: "net:access", resource: "web" };
  if (toolName === "spawn_agent" || toolName === "spawn_agents_on_csv") {
    return { action: "agent:spawn", resource: "native" };
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(toolName);
  if (mcp && mcp[1] === "launchpad") {
    const tool = mcp[2] ?? "";
    const channel = stringArgument(toolInput, ["channel", "channel_name", "name"]);
    switch (tool) {
      case "list_channels":
        return { action: "channel:read", resource: "channel:*" };
      case "read_channel":
        return { action: "channel:read", resource: "channel:" + channel };
      case "post_message":
        return { action: "channel:post", resource: "channel:" + channel };
      case "create_channel":
        return { action: "channel:create", resource: "channel:" + channel };
      case "spawn_agent":
        return { action: "agent:spawn", resource: "*" };
      case "close_agent":
        return { action: "agent:close", resource: stringArgument(toolInput, ["agent_id"]) || "*" };
      case "request_principal":
        return { action: "principal:request", resource: "*" };
      default:
        return { action: "tool:launchpad:" + tool, resource: "*" };
    }
  }
  return { action: "tool:" + toolName, resource: "*" };
}

export function isKnownAction(action: string): boolean {
  return (ACTIONS as readonly string[]).includes(action);
}
