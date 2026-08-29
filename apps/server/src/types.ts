// Mirror of apps/web/src/types.ts plus server-only shapes. Keep the two in sync.

export type AgentStatus = "ready" | "busy" | "stopped" | "error" | "closed";
export type AgentKind = "principal" | "session";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type Effect = "allow" | "deny";
export type PolicyPreset = "reader" | "worker" | "deployer" | "admin" | "custom";

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
  delegable: string[];
}

export interface Agent {
  id: string;
  kind: AgentKind;
  ownIntegrationIds: string[];
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  principalId: string;
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

export interface ApprovalPayload {
  name: string;
  description: string;
  instructions: string;
  policy: Policy;
  channelIds: string[];
}

export interface ApprovalRequest {
  id: string;
  requesterId: string;
  requesterName: string;
  kind: "create_principal";
  payload: ApprovalPayload;
  status: "pending" | "approved" | "denied";
  channelMessageId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Trace {
  rootId: string;
  root: ChannelMessage;
  messages: ChannelMessage[];
  runs: AgentRun[];
  decisions: Decision[];
  channels: Channel[];
  agents: Array<Pick<Agent, "id" | "name" | "kind" | "parentAgentId">>;
  live: boolean;
}

export interface Database {
  version: 2;
  agents: Agent[];
  integrations: Integration[];
  channels: Channel[];
  messages: ChannelMessage[];
  runs: AgentRun[];
  decisions: Decision[];
  approvals: ApprovalRequest[];
}

export interface AgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  policy?: Policy | undefined;
  channelIds?: string[] | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  policy?: Policy | undefined;
  channelIds?: string[] | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

/** Everything a runner needs to start one Codex turn. */
export interface RunnerRequest {
  agentId: string;
  runId: string;
  workspacePath: string;
  /** Per-agent, already-rendered $CODEX_HOME on the host. */
  codexHome: string;
  prompt: string;
  threadId: string | null;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  /** Extra environment for the Codex process (identity token, control-plane URL). */
  env: Record<string, string>;
  onEvent?: ((event: RunEvent) => void) | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

/** Identity resolved from a per-run bearer token. */
export interface RunIdentity {
  agentId: string;
  runId: string;
  expiresAt: number;
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
