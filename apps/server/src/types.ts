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
  /** Sequence number of the newest message in this channel (0 when empty). */
  lastSeq: number;
}

export type AuthorKind = "user" | "principal" | "session" | "system";
/** `conflict`: an agent lost a race on this channel; rendered inline like `denial` but it is not a policy decision. */
export type MessageKind = "message" | "system" | "denial" | "spawn" | "approval" | "conflict";

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
  /** Position in the channel, 1-based and strictly increasing; the unit of "has this agent seen it". */
  seq: number;
  /** Id of the root message that started this causal chain (self for roots). */
  traceId: string;
  /** Message that directly caused this one (the one that woke the run), null for roots. */
  parentMessageId: string | null;
  createdAt: string;
}

/** `conflict` is a synchronisation outcome (lost a race), deliberately distinct from a policy `deny`. */
export type DecisionEffect = Effect | "conflict";

export interface Decision {
  id: string;
  agentId: string;
  agentName: string;
  runId: string | null;
  /** `sync`: read-before-act / lock checks, as opposed to IAM policy checks. */
  source: "hook" | "api" | "scheduler" | "sync";
  tool: string;
  action: string;
  resource: string;
  effect: DecisionEffect;
  reason: string;
  traceId: string | null;
  createdAt: string;
}

/**
 * Why a write to a shared resource was not accepted: someone acted first
 * (`stale`) or the lock could not be obtained in time (`busy`). Carries
 * everything the losing agent needs to regenerate its action.
 */
export interface Conflict {
  resource: string;
  cause: "stale" | "busy";
  /** The message that beat this write (newest unseen state message), when known. */
  winnerId: string | null;
  winnerName: string | null;
  winnerContent: string | null;
  winnerMessageId: string | null;
  winnerSeq: number | null;
  rejectedContent: string;
  /** State-bearing messages the actor had not been shown, oldest first. */
  unseen: ChannelMessage[];
  seenSeq: number;
  headSeq: number;
  /** 1-based count of conflicts in this turn, and the cap. */
  attempt: number;
  limit: number;
  /** Model-facing explanation and instruction. */
  feedback: string;
}

export type RunEventType =
  | "command_execution"
  | "mcp_tool_call"
  | "file_change"
  | "web_search"
  | "reasoning"
  | "conflict";

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
  /** `conflict`: a regenerate turn queued because the previous reply lost a race. */
  trigger: "user" | "channel" | "spawn" | "conflict";
  channelId: string | null;
  traceId: string | null;
  /** Message whose arrival woke this run. */
  triggerMessageId: string | null;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  events: RunEvent[];
  /** Channel `lastSeq` covered by this run's prompt (what the agent had seen when it started). */
  seenSeq: number | null;
  /** Sync conflicts hit during this turn (tool calls and the final reply). */
  conflicts: number;
  /** Set when the final reply was not posted because the channel had moved on. */
  conflict: Conflict | null;
  /** True when the reply was `[no reply]` and nothing was posted. */
  silent: boolean;
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
