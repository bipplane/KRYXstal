import { access, copyFile, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { mayEver, renderExecPolicyRules } from "./policy.js";
import type { Agent } from "./types.js";

export const MCP_SERVER_NAME = "launchpad";

/** MCP tools gated by the action that must be grantable for the tool to be exposed. */
export const MCP_TOOL_ACTIONS: Record<string, string> = {
  list_channels: "channel:read",
  read_channel: "channel:read",
  post_message: "channel:post",
  create_channel: "channel:create",
  spawn_agent: "agent:spawn",
  close_agent: "agent:close",
  request_principal: "principal:request",
};

export interface ExternalMcpServer {
  name: string;
  kind: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  /** null = expose every tool (the hook still enforces the policy). */
  enabledTools: string[] | null;
}

export interface CodexHomeInput {
  /** Host directory to render into. */
  dir: string;
  config: AppConfig;
  agent: Agent;
  /** Path to the runtime scripts as seen by the Codex process. */
  scriptsDir: string;
  /** External MCP servers this agent's policy may use. */
  integrations?: ExternalMcpServer[] | undefined;
  /** Shared OAuth credentials file to place into the home (copied), or null to leave the home's own. */
  credentialsFile?: string | null | undefined;
}

export function enabledMcpTools(agent: Agent): string[] {
  return Object.entries(MCP_TOOL_ACTIONS)
    .filter(([, action]) => mayEver(agent.policy, action))
    .map(([tool]) => tool);
}

export function networkAllowed(agent: Agent): boolean {
  return mayEver(agent.policy, "net:access");
}

export function effectiveSandboxMode(
  config: AppConfig,
  agent: Agent,
): AppConfig["codexSandboxMode"] {
  if (config.codexSandboxMode === "danger-full-access") return "danger-full-access";
  return mayEver(agent.policy, "fs:write") ? config.codexSandboxMode : "read-only";
}

function toml(value: string): string {
  return JSON.stringify(value);
}

export function renderConfigToml(input: CodexHomeInput): string {
  const { config, agent, scriptsDir } = input;
  const tools = enabledMcpTools(agent);
  const localCodex = config.modelProvider === "local-codex";
  const lines = [
    "# Generated per run by Volc Agent Launchpad from the agent's IAM policy. Do not edit.",
    ...(localCodex
      ? [
          "# local-codex mode: default provider + auth.json linked from " + config.localCodexHome,
          ...(config.codexModel ? ["model = " + toml(config.codexModel)] : []),
        ]
      : [
          "model = " + toml(config.arkModel || "ep-not-configured"),
          'model_provider = "volcengine_ark"',
        ]),
    'approval_policy = "never"',
    "sandbox_mode = " + toml(effectiveSandboxMode(config, agent)),
    "web_search = " + toml(networkAllowed(agent) ? "live" : "disabled"),
    "",
    ...(localCodex
      ? []
      : [
          "[model_providers.volcengine_ark]",
          'name = "Volcengine Ark"',
          "base_url = " + toml(config.arkBaseUrl),
          'env_key = "ARK_API_KEY"',
          'wire_api = "responses"',
          "requires_openai_auth = false",
          "",
        ]),
    "[sandbox_workspace_write]",
    "network_access = " + String(networkAllowed(agent)),
    "",
    "[features]",
    "hooks = true",
    "multi_agent = false",
    "",
    "[agents]",
    "enabled = false",
    "",
    "[shell_environment_policy]",
    'inherit = "core"',
    'exclude = ["AGENT_TOKEN", "ARK_API_KEY", "LAUNCHPAD_URL"]',
    "",
  ];
  for (const server of input.integrations ?? []) {
    lines.push("[mcp_servers." + server.name + "]");
    if (server.kind === "http") {
      lines.push("url = " + toml(server.url ?? ""));
    } else {
      lines.push("command = " + toml(server.command ?? ""));
      lines.push("args = [" + server.args.map(toml).join(", ") + "]");
    }
    if (server.enabledTools) {
      lines.push("enabled_tools = [" + server.enabledTools.map(toml).join(", ") + "]");
    }
    lines.push('default_tools_approval_mode = "approve"', "startup_timeout_sec = 20", "tool_timeout_sec = 120", "");
  }
  if ((input.integrations ?? []).some((server) => server.kind === "http")) {
    lines.unshift('mcp_oauth_credentials_store = "file"');
  }
  if (tools.length > 0) {
    lines.push(
      "[mcp_servers." + MCP_SERVER_NAME + "]",
      'command = "node"',
      "args = [" + toml(path.posix.join(scriptsDir, "mcp-launchpad.mjs")) + "]",
      'env_vars = ["LAUNCHPAD_URL", "AGENT_TOKEN"]',
      "enabled_tools = [" + tools.map(toml).join(", ") + "]",
      // Authorisation is the hook's job; Codex itself must never prompt (exec runs with approval_policy = never).
      'default_tools_approval_mode = "approve"',
      "startup_timeout_sec = 20",
      "tool_timeout_sec = 120",
      "",
    );
  }
  return lines.join("\n");
}

export function renderHooksJson(scriptsDir: string): string {
  return (
    JSON.stringify(
      {
        description: "IAM enforcement hook generated by Volc Agent Launchpad",
        hooks: {
          PreToolUse: [
            {
              matcher: ".*",
              hooks: [
                {
                  type: "command",
                  command: "node " + JSON.stringify(path.posix.join(scriptsDir, "iam-hook.mjs")),
                  timeout: 15,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/** In local-codex mode, link the host Codex login into the per-agent home. */
async function linkLocalAuth(dir: string, localCodexHome: string): Promise<void> {
  const source = path.join(localCodexHome, "auth.json");
  const target = path.join(dir, "auth.json");
  try {
    await access(source);
  } catch {
    throw new Error(
      "MODEL_PROVIDER=local-codex but " + source + " does not exist. Run `codex login` first.",
    );
  }
  await unlink(target).catch(() => undefined);
  await symlink(source, target);
}

/** Writes config.toml, rules/policy.rules and hooks.json for one agent. */
export async function renderCodexHome(input: CodexHomeInput): Promise<void> {
  await mkdir(path.join(input.dir, "rules"), { recursive: true });
  if (input.config.modelProvider === "local-codex") {
    await linkLocalAuth(input.dir, input.config.localCodexHome);
  }
  if (input.credentialsFile) {
    // Copy (not link): the container runtime cannot follow a host symlink, and
    // Codex rewrites the file on token refresh.
    await copyFile(input.credentialsFile, path.join(input.dir, ".credentials.json"));
  }
  await writeFile(path.join(input.dir, "config.toml"), renderConfigToml(input), {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(
    path.join(input.dir, "rules", "policy.rules"),
    renderExecPolicyRules(input.agent.policy),
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(path.join(input.dir, "hooks.json"), renderHooksJson(input.scriptsDir), {
    encoding: "utf8",
    mode: 0o600,
  });
}
