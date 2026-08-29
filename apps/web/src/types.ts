// API contract shared with apps/server/src/types.ts. Keep the two in sync.

export type AgentStatus = "ready" | "busy" | "stopped" | "error" | "closed";
export type AgentKind = "principal" | "session";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type Effect = "allow" | "deny";
export type PolicyPreset = "reader" | "worker" | "deployer" | "admin" | "custom";

/** IAM-style action names. Resources are `channel:<name>`, `cmd:<argv prefix>`, or `*`. */
export const ACTIONS = [
  "channel:read",
  "channel:post",
  "channel:create",
  "shell:exec",
  "fs:write",
  "net:access",
  "agent:spawn",
  "agent:close",
  "principal:request",
] as const;
export type Action = (typeof ACTIONS)[number];

export interface Statement {
  effect: Effect;
  actions: string[];
  resources: string[];
}

export interface Policy {
  preset: PolicyPreset;
  statements: Statement[];
  /** Action patterns this agent may grant to sessions it spawns. */
  delegable: string[];
}

export interface Agent {
  id: string;
  kind: AgentKind;
  /** Integrations this agent has logged into with its own identity (overrides the shared login). */
  ownIntegrationIds: string[];
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  /** Root principal id (self for principals). */
  principalId: string;
  /** Parent agent id for sessions, null for principals. */
  parentAgentId: string | null;
  policy: Policy;
  dmChannelId: string | null;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export type ChannelKind = "public" | "dm" | "system";

export interface Channel {
  id: string;
  name: string;
  description: string;
  kind: ChannelKind;
  memberIds: string[];
  createdAt: string;
  archivedAt: string | null;
  lastMessageAt: string | null;
}

export type AuthorKind = "user" | "principal" | "session" | "system";
export type MessageKind = "message" | "system" | "denial" | "spawn" | "approval";

export interface ChannelMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorKind: AuthorKind;
  kind: MessageKind;
  content: string;
  runId: string | null;
  approvalId: string | null;
  /** Id of the root message that started this causal chain (self for roots). */
  traceId: string;
  /** Message that directly caused this one (the one that woke the run), null for roots. */
  parentMessageId: string | null;
  /** When set, whether the author expects an answer; otherwise inferred from a trailing "?". */
  expectsReply?: boolean | undefined;
  createdAt: string;
}

export interface Decision {
  id: string;
  agentId: string;
  agentName: string;
  runId: string | null;
  source: "hook" | "api" | "scheduler";
  tool: string;
  action: string;
  resource: string;
  effect: Effect;
  reason: string;
  traceId: string | null;
  createdAt: string;
}

export type RunEventType =
  | "command_execution"
  | "mcp_tool_call"
  | "file_change"
  | "web_search"
  | "reasoning";

export interface RunEvent {
  id: string;
  type: RunEventType;
  summary: string;
  status: string | null;
  exitCode: number | null;
  detail: string | null;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  trigger: "user" | "channel" | "spawn";
  /** Channel whose message woke this run. */
  channelId: string | null;
  /** Channel the final reply is posted to (differs from channelId when answering back to where the agent was originally asked). */
  replyChannelId: string | null;
  traceId: string | null;
  /** Message whose arrival woke this run. */
  triggerMessageId: string | null;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  events: RunEvent[];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  requesterId: string;
  requesterName: string;
  kind: "create_principal";
  payload: {
    name: string;
    description: string;
    instructions: string;
    policy: Policy;
    channelIds: string[];
  };
  status: "pending" | "approved" | "denied";
  channelMessageId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface SystemInfo {
  arkConfigured: boolean;
  modelProvider?: "ark" | "local-codex";
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: string;
  containerEngine: string | null;
  runtime: string;
}

/** GET /api/traces/:messageId — everything caused by one root message, across channels. */
export interface Trace {
  rootId: string;
  root: ChannelMessage;
  /** All messages in the trace, oldest first (includes root). */
  messages: ChannelMessage[];
  /** Runs woken inside the trace, oldest first. */
  runs: AgentRun[];
  /** Decisions taken during those runs, oldest first. */
  decisions: Decision[];
  /** Channels referenced by the messages. */
  channels: Channel[];
  /** Agents referenced, for names/kinds. */
  agents: Array<Pick<Agent, "id" | "name" | "kind" | "parentAgentId">>;
  /** True while any run in the trace is still queued/running. */
  live: boolean;
}

export interface Overview {
  user: { id: "user"; name: string };
  agents: Agent[];
  channels: Channel[];
  approvals: ApprovalRequest[];
  integrations: Integration[];
}

export interface AgentInput {
  name: string;
  description: string;
  instructions: string;
  policy: Policy;
  channelIds: string[];
}

export interface PolicyPresets {
  presets: Record<Exclude<PolicyPreset, "custom">, Policy>;
  actions: readonly string[];
}

// ---------- integrations (external MCP servers) ----------

export type IntegrationKind = "http" | "stdio";
export type IntegrationAuth = "oauth" | "none";
export type IntegrationStatus = "unconnected" | "connecting" | "connected" | "error";

export interface IntegrationTool {
  name: string;
  description: string;
  readOnly: boolean;
}

/** An external MCP server registered by the human. Tools become IAM actions `mcp:<name>:<tool>`. */
export interface Integration {
  id: string;
  /** Slug used as the Codex MCP server name and in action names. */
  name: string;
  kind: IntegrationKind;
  url: string | null;
  command: string | null;
  args: string[];
  auth: IntegrationAuth;
  status: IntegrationStatus;
  /** Discovered via tools/list after connecting; empty until then. */
  tools: IntegrationTool[];
  lastError: string | null;
  connectedAt: string | null;
  createdAt: string;
}

export interface IntegrationInput {
  name: string;
  kind: IntegrationKind;
  url?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  auth?: IntegrationAuth | undefined;
}

/** Result of starting an OAuth login: open `url` in a browser, then poll the integration status. */
export interface IntegrationLogin {
  integrationId: string;
  /** Agent id when this is a per-agent login, null for the shared login. */
  agentId: string | null;
  url: string;
}
