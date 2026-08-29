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
  channelId: string | null;
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

export interface Overview {
  user: { id: "user"; name: string };
  agents: Agent[];
  channels: Channel[];
  approvals: ApprovalRequest[];
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
