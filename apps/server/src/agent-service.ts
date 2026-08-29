import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  agentCodexHome,
  isArkConfigured,
  isModelConfigured,
  runtimeScriptsDirForCodex,
  type AppConfig,
} from "./config.js";
import { effectiveSandboxMode, enabledMcpTools, renderCodexHome } from "./codex-home.js";
import { HttpError, RunCancelledError } from "./errors.js";
import {
  deriveSessionPolicy,
  evaluate,
  grantChannels,
  mapToolCall,
  normalizePolicy,
  presetPolicy,
  PRESETS,
  USER_POLICY,
} from "./policy.js";
import { JsonStore, legacyDmChannelId } from "./store.js";
import type {
  Agent,
  AgentInput,
  AgentRun,
  AgentRunner,
  ApprovalPayload,
  ApprovalRequest,
  Channel,
  ChannelMessage,
  Database,
  Decision,
  Effect,
  Policy,
  RunEvent,
  RunIdentity,
  Trace,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager, type InstructionContext } from "./workspace.js";
import type { IntegrationService } from "./integration-service.js";

const now = () => new Date().toISOString();

export const USER_ID = "user";
const GENERAL_CHANNEL = "general";
const APPROVALS_CHANNEL = "approvals";
const MAX_SESSION_DEPTH = 3;
/** Agent-to-agent turns allowed in one channel before a human has to speak again. */
const CHATTER_BUDGET = 8;
/** Agent runs one human prompt may cause in total (across channels) before pausing. */
const TRACE_BUDGET = 6;
const MAX_DECISIONS = 2_000;
const MAX_EVENTS_PER_RUN = 300;
const CONTEXT_MESSAGES = 20;

export interface ToolCallVerdict {
  effect: Effect;
  reason: string;
  action: string | null;
  resource: string | null;
}

export interface SpawnInput {
  name: string;
  instructions: string;
  actions?: string[] | undefined;
  channels?: string[] | undefined;
  task?: string | undefined;
}

export interface RequestPrincipalInput {
  name: string;
  description?: string | undefined;
  instructions: string;
  preset: "reader" | "worker" | "deployer" | "admin";
  channels?: string[] | undefined;
}

interface RunOptions {
  trigger: AgentRun["trigger"];
  channelId: string | null;
  /** Where the final reply goes; defaults to channelId. */
  replyChannelId?: string | null | undefined;
  prompt: string;
  traceId: string | null;
  triggerMessageId: string | null;
}

interface TraceContext {
  traceId?: string | undefined;
  parentMessageId?: string | null | undefined;
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly tokens = new Map<string, RunIdentity>();
  private readonly liveEvents = new Map<string, RunEvent[]>();
  /** agentId -> channelId -> id of the latest message that asked for a wake. */
  private readonly pendingWakes = new Map<string, Map<string, string>>();
  private readonly chatter = new Map<string, number>();
  private readonly traceNotices = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly integrations: IntegrationService | null = null,
  ) {}

  // ---------------------------------------------------------------- lifecycle

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await mkdir(path.dirname(agentCodexHome(this.config, "x")), { recursive: true });
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
      for (const message of database.messages) {
        message.traceId ??= message.id;
        message.parentMessageId ??= null;
      }
      for (const run of database.runs) {
        run.traceId ??= null;
        run.triggerMessageId ??= null;
        run.replyChannelId ??= run.channelId;
      }
      for (const decision of database.decisions) decision.traceId ??= null;
      database.integrations ??= [];
      for (const agent of database.agents) agent.ownIntegrationIds ??= [];
      this.ensureSystemChannels(database);
      for (const agent of database.agents) {
        if (!agent.dmChannelId) {
          const channel = this.newChannel(database, {
            name: "dm-" + agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            description: "Direct messages with " + agent.name,
            kind: "dm",
            memberIds: [USER_ID, agent.id],
          });
          agent.dmChannelId = channel.id;
          const legacyId = legacyDmChannelId(agent.id);
          for (const message of database.messages) {
            if (message.channelId === legacyId) message.channelId = channel.id;
          }
        }
      }
    });
  }

  private ensureSystemChannels(database: Database): void {
    if (!database.channels.some((channel) => channel.name === GENERAL_CHANNEL)) {
      this.newChannel(database, {
        name: GENERAL_CHANNEL,
        description: "Everyone. Mention an agent with @name to wake it.",
        kind: "public",
        memberIds: [USER_ID, ...database.agents.map((agent) => agent.id)],
      });
    }
    if (!database.channels.some((channel) => channel.name === APPROVALS_CHANNEL)) {
      this.newChannel(database, {
        name: APPROVALS_CHANNEL,
        description: "Requests that need a human decision.",
        kind: "system",
        memberIds: [USER_ID],
      });
    }
  }

  private newChannel(
    database: Database,
    input: Pick<Channel, "name" | "description" | "kind" | "memberIds">,
  ): Channel {
    const channel: Channel = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      kind: input.kind,
      memberIds: [...new Set(input.memberIds)],
      createdAt: now(),
      archivedAt: null,
      lastMessageAt: null,
    };
    database.channels.push(channel);
    return channel;
  }

  // ------------------------------------------------------------------ queries

  overview(): {
    user: { id: "user"; name: string };
    agents: Agent[];
    channels: Channel[];
    approvals: ApprovalRequest[];
    integrations: Database["integrations"];
  } {
    const database = this.store.snapshot();
    return {
      user: { id: USER_ID, name: this.config.userName },
      agents: database.agents.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      channels: database.channels.filter((channel) => !channel.archivedAt),
      approvals: database.approvals.filter((approval) => approval.status === "pending"),
      integrations: database.integrations,
    };
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.peek().agents.find((item) => item.id === id);
    if (!agent) throw new HttpError(404, "Agent not found");
    return structuredClone(agent);
  }

  getChannel(id: string): Channel {
    const channel = this.store.peek().channels.find((item) => item.id === id);
    if (!channel) throw new HttpError(404, "Channel not found");
    return structuredClone(channel);
  }

  getChannelByName(name: string): Channel {
    const clean = name.replace(/^#/, "").trim().toLowerCase();
    const channel = this.store
      .peek()
      .channels.find((item) => item.name.toLowerCase() === clean && !item.archivedAt);
    if (!channel) throw new HttpError(404, "Channel #" + clean + " not found");
    return structuredClone(channel);
  }

  listChannels(): Channel[] {
    return this.store.snapshot().channels.filter((channel) => !channel.archivedAt);
  }

  getMessages(channelId: string, limit = 200, after?: string): ChannelMessage[] {
    this.getChannel(channelId);
    const messages = this.store
      .peek()
      .messages.filter(
        (message) =>
          message.channelId === channelId && (!after || message.createdAt > after),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return structuredClone(messages.slice(-limit));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.peek().runs.find((item) => item.id === runId);
    if (!run) throw new HttpError(404, "Run not found");
    const copy = structuredClone(run);
    const live = this.liveEvents.get(runId);
    if (live && copy.events.length === 0) copy.events = structuredClone(live);
    return copy;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .peek()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((run) => this.getRun(run.id));
  }

  getDecisions(agentId?: string, limit = 100): Decision[] {
    if (agentId) this.getAgent(agentId);
    return structuredClone(
      this.store
        .peek()
        .decisions.filter((decision) => !agentId || decision.agentId === agentId)
        .slice(-limit)
        .reverse(),
    );
  }

  policyPresets(): { presets: typeof PRESETS } {
    return { presets: PRESETS };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isModelConfigured(this.config),
      modelProvider: this.config.modelProvider,
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel:
        this.config.modelProvider === "local-codex"
          ? this.config.codexModel || "codex default"
          : this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
      agentApiBaseUrl: this.config.agentApiBaseUrl,
    };
  }

  // ------------------------------------------------------------- principals

  async createAgent(input: AgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const channels = this.resolveChannels(input.channelIds ?? []);
    const policy = grantChannels(
      normalizePolicy(input.policy ?? presetPolicy("worker")),
      channels.map((channel) => channel.name),
    );
    const agent: Agent = {
      id,
      kind: "principal",
      ownIntegrationIds: [],
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      principalId: id,
      parentAgentId: null,
      policy,
      dmChannelId: null,
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: null,
    };
    const stored = await this.store.mutate((database) => {
      const dm = this.newChannel(database, {
        name: "dm-" + agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        description: "Direct messages with " + agent.name,
        kind: "dm",
        memberIds: [USER_ID, agent.id],
      });
      agent.dmChannelId = dm.id;
      database.agents.push(agent);
      for (const channel of database.channels) {
        if (
          channel.name === GENERAL_CHANNEL ||
          channels.some((selected) => selected.id === channel.id)
        ) {
          if (!channel.memberIds.includes(agent.id)) channel.memberIds.push(agent.id);
          this.appendMessage(database, channel.id, {
            authorId: "system",
            authorName: "system",
            authorKind: "system",
            kind: "system",
            content: agent.name + " joined #" + channel.name,
            runId: null,
            approvalId: null,
          });
        }
      }
      return structuredClone(agent);
    });
    await this.workspaces.create(stored, this.instructionContext(stored));
    return stored;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const channels = input.channelIds ? this.resolveChannels(input.channelIds) : null;
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      if (input.policy !== undefined) agent.policy = normalizePolicy(input.policy);
      if (channels) {
        for (const channel of database.channels) {
          if (channel.kind === "dm" || channel.name === GENERAL_CHANNEL) continue;
          const wanted = channels.some((selected) => selected.id === channel.id);
          const member = channel.memberIds.includes(agent.id);
          if (wanted && !member) {
            channel.memberIds.push(agent.id);
            this.appendMessage(database, channel.id, {
              authorId: "system",
              authorName: "system",
              authorKind: "system",
              kind: "system",
              content: agent.name + " joined #" + channel.name,
              runId: null,
              approvalId: null,
            });
          } else if (!wanted && member) {
            channel.memberIds = channel.memberIds.filter((memberId) => memberId !== agent.id);
          }
        }
      }
      if (input.policy !== undefined || channels) {
        const names = database.channels
          .filter((channel) => channel.memberIds.includes(agent.id) && channel.kind !== "dm")
          .map((channel) => channel.name);
        agent.policy = grantChannels(agent.policy, names);
      }
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated, this.instructionContext(updated));
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    for (const child of this.childrenOf(id)) {
      await this.closeSession(child.id, "parent deleted");
    }
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      for (const channel of database.channels) {
        channel.memberIds = channel.memberIds.filter((memberId) => memberId !== id);
        if (channel.id === agent.dmChannelId) channel.archivedAt = now();
      }
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  // ---------------------------------------------------------------- channels

  async createChannel(input: {
    name: string;
    description?: string | undefined;
    memberIds?: string[] | undefined;
  }): Promise<Channel> {
    const name = input.name.replace(/^#/, "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    if (!name) throw new HttpError(400, "Channel name is required");
    return this.store.mutate((database) => {
      if (database.channels.some((channel) => channel.name === name && !channel.archivedAt)) {
        throw new HttpError(409, "Channel #" + name + " already exists");
      }
      const members = [USER_ID, ...(input.memberIds ?? [])].filter(
        (memberId) =>
          memberId === USER_ID || database.agents.some((agent) => agent.id === memberId),
      );
      const channel = this.newChannel(database, {
        name,
        description: input.description?.trim() ?? "",
        kind: "public",
        memberIds: members,
      });
      for (const agent of database.agents) {
        if (members.includes(agent.id)) {
          agent.policy = grantChannels(agent.policy, [name]);
        }
      }
      return structuredClone(channel);
    });
  }

  /** The human posts to a channel. Wakes every member the message addresses. */
  async postUserMessage(channelId: string, content: string): Promise<ChannelMessage> {
    const channel = this.getChannel(channelId);
    const message = await this.store.mutate((database) =>
      this.appendMessage(database, channel.id, {
        authorId: USER_ID,
        authorName: this.config.userName,
        authorKind: "user",
        kind: "message",
        content,
        runId: null,
        approvalId: null,
      }),
    );
    this.chatter.set(channel.id, 0);
    await this.wakeMembers(channel.id, message);
    return message;
  }

  /** Backwards compatible playground entry point: post to the Agent's DM. */
  async sendMessage(agentId: string, content: string): Promise<{ message: ChannelMessage }> {
    const agent = this.getAgent(agentId);
    if (!agent.dmChannelId) throw new HttpError(409, "Agent has no DM channel");
    if (!isModelConfigured(this.config)) {
      throw new HttpError(
        503,
        "No model configured. Set ARK_API_KEY and ARK_MODEL (or MODEL_PROVIDER=local-codex), then restart.",
      );
    }
    const message = await this.postUserMessage(agent.dmChannelId, content);
    return { message };
  }

  private appendMessage(
    database: Database,
    channelId: string,
    input: Omit<ChannelMessage, "id" | "channelId" | "createdAt" | "traceId" | "parentMessageId"> &
      TraceContext,
  ): ChannelMessage {
    const id = randomUUID();
    const { traceId, parentMessageId, ...rest } = input;
    const message: ChannelMessage = {
      id,
      channelId,
      createdAt: now(),
      ...rest,
      traceId: traceId ?? id,
      parentMessageId: parentMessageId ?? null,
    };
    database.messages.push(message);
    const channel = database.channels.find((item) => item.id === channelId);
    if (channel) channel.lastMessageAt = message.createdAt;
    return message;
  }

  // ------------------------------------------------------------------ traces

  /** Trace context for anything produced by a run: same trace, caused by the message that woke it. */
  private traceOfRun(runId: string | null): TraceContext {
    if (!runId) return {};
    const run = this.store.peek().runs.find((item) => item.id === runId);
    if (!run) return {};
    return { traceId: run.traceId ?? undefined, parentMessageId: run.triggerMessageId };
  }

  getTrace(messageId: string): Trace {
    const database = this.store.peek();
    const origin = database.messages.find((item) => item.id === messageId);
    if (!origin) throw new HttpError(404, "Message not found");
    const traceId = origin.traceId;
    const root = database.messages.find((item) => item.id === traceId) ?? origin;
    const messages = database.messages
      .filter((item) => item.traceId === traceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const runs = database.runs
      .filter((run) => run.traceId === traceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((run) => this.getRun(run.id));
    const decisions = database.decisions
      .filter((decision) => decision.traceId === traceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const channelIds = new Set(messages.map((item) => item.channelId));
    for (const run of runs) if (run.channelId) channelIds.add(run.channelId);
    const agentIds = new Set<string>();
    for (const item of messages) agentIds.add(item.authorId);
    for (const run of runs) agentIds.add(run.agentId);
    for (const decision of decisions) agentIds.add(decision.agentId);
    return {
      rootId: root.id,
      root: structuredClone(root),
      messages: structuredClone(messages),
      runs,
      decisions: structuredClone(decisions),
      channels: structuredClone(database.channels.filter((channel) => channelIds.has(channel.id))),
      agents: database.agents
        .filter((agent) => agentIds.has(agent.id))
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          kind: agent.kind,
          parentAgentId: agent.parentAgentId,
        })),
      live: runs.some((run) => run.status === "queued" || run.status === "running"),
    };
  }

  // ---------------------------------------------------------- agent identity

  private mintToken(agentId: string, runId: string): string {
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, {
      agentId,
      runId,
      expiresAt: Date.now() + this.config.codexTimeoutMs + 120_000,
    });
    return token;
  }

  resolveToken(token: string): RunIdentity | null {
    const identity = this.tokens.get(token);
    if (!identity) return null;
    if (identity.expiresAt < Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return identity;
  }

  private revokeRunTokens(runId: string): void {
    for (const [token, identity] of this.tokens) {
      if (identity.runId === runId) this.tokens.delete(token);
    }
  }

  // ------------------------------------------------------------- IAM checks

  /** PreToolUse hook entry point. */
  async evaluateToolCall(
    identity: RunIdentity,
    toolName: string,
    toolInput: unknown,
  ): Promise<ToolCallVerdict> {
    const agent = this.getAgent(identity.agentId);
    const mapping = mapToolCall(toolName, toolInput);
    if (!mapping) return { effect: "allow", reason: "No authorisation required", action: null, resource: null };
    const verdict = this.decide(agent, mapping.action, mapping.resource);
    await this.recordDecision({
      agentId: agent.id,
      agentName: agent.name,
      runId: identity.runId,
      source: "hook",
      tool: toolName,
      action: mapping.action,
      resource: mapping.resource,
      effect: verdict.effect,
      reason: verdict.reason,
    });
    if (verdict.effect === "deny") {
      await this.announceDenial(agent, identity.runId, mapping.action, mapping.resource, verdict.reason);
    }
    return { ...verdict, action: mapping.action, resource: mapping.resource };
  }

  /** Policy + channel membership in one place. */
  private decide(agent: Agent, action: string, resource: string): { effect: Effect; reason: string } {
    if (agent.status === "closed") return { effect: "deny", reason: "Session is closed" };
    if (resource.startsWith("channel:") && resource !== "channel:*") {
      const name = resource.slice("channel:".length);
      const channel = this.store
        .peek()
        .channels.find((item) => item.name.toLowerCase() === name.toLowerCase() && !item.archivedAt);
      if (!channel) return { effect: "deny", reason: "Channel #" + name + " does not exist" };
      if (action !== "channel:create" && !channel.memberIds.includes(agent.id)) {
        return { effect: "deny", reason: agent.name + " is not a member of #" + name };
      }
    }
    const evaluation = evaluate(agent.policy, action, resource);
    return { effect: evaluation.effect, reason: evaluation.reason };
  }

  private async authorize(
    agent: Agent,
    runId: string | null,
    tool: string,
    action: string,
    resource: string,
    source: Decision["source"] = "api",
  ): Promise<void> {
    const verdict = this.decide(agent, action, resource);
    await this.recordDecision({
      agentId: agent.id,
      agentName: agent.name,
      runId,
      source,
      tool,
      action,
      resource,
      effect: verdict.effect,
      reason: verdict.reason,
    });
    if (verdict.effect === "deny") {
      await this.announceDenial(agent, runId, action, resource, verdict.reason);
      throw new HttpError(403, "Denied: " + verdict.reason);
    }
  }

  private async recordDecision(
    input: Omit<Decision, "id" | "createdAt" | "traceId">,
  ): Promise<Decision> {
    const traceId = this.traceOfRun(input.runId).traceId ?? null;
    return this.store.mutate((database) => {
      const decision: Decision = { id: randomUUID(), createdAt: now(), traceId, ...input };
      database.decisions.push(decision);
      if (database.decisions.length > MAX_DECISIONS) {
        database.decisions.splice(0, database.decisions.length - MAX_DECISIONS);
      }
      return decision;
    });
  }

  private async announceDenial(
    agent: Agent,
    runId: string | null,
    action: string,
    resource: string,
    reason: string,
  ): Promise<void> {
    const run = runId ? this.store.peek().runs.find((item) => item.id === runId) : null;
    const channelId = run?.channelId ?? agent.dmChannelId;
    if (!channelId) return;
    await this.store.mutate((database) =>
      this.appendMessage(database, channelId, {
        authorId: agent.id,
        authorName: agent.name,
        authorKind: agent.kind,
        kind: "denial",
        content: agent.name + " → " + action + " on " + resource + " denied (" + reason + ")",
        runId,
        approvalId: null,
        ...this.traceOfRun(runId),
      }),
    );
  }

  // -------------------------------------------------------------- agent API

  agentChannels(identity: RunIdentity): Array<Channel & { memberNames: string[] }> {
    const agent = this.getAgent(identity.agentId);
    const database = this.store.peek();
    const names = new Map<string, string>([[USER_ID, this.config.userName]]);
    for (const item of database.agents) names.set(item.id, item.name);
    return database.channels
      .filter(
        (channel) =>
          !channel.archivedAt &&
          channel.memberIds.includes(agent.id) &&
          evaluate(agent.policy, "channel:read", "channel:" + channel.name).effect === "allow",
      )
      .map((channel) => ({
        ...structuredClone(channel),
        memberNames: channel.memberIds.map((memberId) => names.get(memberId) ?? memberId),
      }));
  }

  async agentReadChannel(
    identity: RunIdentity,
    channelName: string,
    limit: number,
  ): Promise<ChannelMessage[]> {
    const agent = this.getAgent(identity.agentId);
    const channel = this.getChannelByName(channelName);
    await this.authorize(agent, identity.runId, "read_channel", "channel:read", "channel:" + channel.name);
    return this.getMessages(channel.id, limit);
  }

  async agentPostMessage(
    identity: RunIdentity,
    channelName: string,
    content: string,
    expectsReply?: boolean | undefined,
  ): Promise<ChannelMessage> {
    const agent = this.getAgent(identity.agentId);
    const channel = this.getChannelByName(channelName);
    await this.authorize(agent, identity.runId, "post_message", "channel:post", "channel:" + channel.name);
    const message = await this.store.mutate((database) =>
      this.appendMessage(database, channel.id, {
        authorId: agent.id,
        authorName: agent.name,
        authorKind: agent.kind,
        kind: "message",
        content,
        runId: identity.runId,
        approvalId: null,
        ...(expectsReply === undefined ? {} : { expectsReply }),
        ...this.traceOfRun(identity.runId),
      }),
    );
    await this.wakeMembers(channel.id, message);
    return message;
  }

  async agentCreateChannel(
    identity: RunIdentity,
    input: { name: string; description?: string | undefined; members?: string[] | undefined },
  ): Promise<Channel> {
    const agent = this.getAgent(identity.agentId);
    const name = input.name.replace(/^#/, "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    await this.authorize(agent, identity.runId, "create_channel", "channel:create", "channel:" + name);
    const memberIds = (input.members ?? [])
      .map((memberName) => this.findAgentByName(memberName)?.id)
      .filter((id): id is string => Boolean(id));
    const channel = await this.createChannel({
      name,
      description: input.description,
      memberIds: [agent.id, ...memberIds],
    });
    await this.workspaces.writeInstructions(this.getAgent(agent.id), this.instructionContext(this.getAgent(agent.id)));
    return channel;
  }

  async agentSpawn(identity: RunIdentity, input: SpawnInput): Promise<Agent> {
    const parent = this.getAgent(identity.agentId);
    await this.authorize(parent, identity.runId, "spawn_agent", "agent:spawn", "*");
    if (this.depthOf(parent) >= MAX_SESSION_DEPTH) {
      throw new HttpError(403, "Denied: maximum session depth reached");
    }
    const channelNames = (input.channels ?? []).map((name) => name.replace(/^#/, "").trim().toLowerCase());
    const derived = deriveSessionPolicy(parent.policy, {
      actions: input.actions ?? [],
      channelNames,
      delegable: input.actions ?? [],
    });
    if (!derived.ok || !derived.policy) {
      await this.recordDecision({
        agentId: parent.id,
        agentName: parent.name,
        runId: identity.runId,
        source: "api",
        tool: "spawn_agent",
        action: "agent:spawn",
        resource: "delegation",
        effect: "deny",
        reason: derived.reason,
      });
      await this.announceDenial(parent, identity.runId, "agent:spawn", "delegation", derived.reason);
      throw new HttpError(403, "Denied: " + derived.reason);
    }
    const timestamp = now();
    const id = randomUUID();
    const session: Agent = {
      id,
      kind: "session",
      ownIntegrationIds: [],
      name: parent.name + "/" + input.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
      description: "Session spawned by " + parent.name,
      instructions: input.instructions.trim(),
      status: "ready",
      principalId: parent.principalId,
      parentAgentId: parent.id,
      policy: derived.policy,
      dmChannelId: null,
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: null,
    };
    const parentRun = this.store.peek().runs.find((run) => run.id === identity.runId);
    const stored = await this.store.mutate((database) => {
      const dm = this.newChannel(database, {
        name: "dm-" + session.name.replace(/[^a-z0-9_-]+/g, "-"),
        description: "Direct messages between " + parent.name + " and its session",
        kind: "dm",
        memberIds: [USER_ID, parent.id, session.id],
      });
      session.dmChannelId = dm.id;
      database.agents.push(session);
      for (const channel of database.channels) {
        if (channelNames.includes(channel.name) && !channel.memberIds.includes(session.id)) {
          channel.memberIds.push(session.id);
        }
      }
      const announce = new Set([dm.id, parentRun?.channelId ?? parent.dmChannelId ?? dm.id]);
      for (const channelId of announce) {
        this.appendMessage(database, channelId, {
          authorId: parent.id,
          authorName: parent.name,
          authorKind: parent.kind,
          kind: "spawn",
          content:
            parent.name +
            " spawned session " +
            session.name +
            " with " +
            (derived.policy?.statements.filter((s) => s.effect === "allow").flatMap((s) => s.actions).join(", ") || "no grants"),
          runId: identity.runId,
          approvalId: null,
          ...this.traceOfRun(identity.runId),
        });
      }
      return structuredClone(session);
    });
    await this.recordDecision({
      agentId: parent.id,
      agentName: parent.name,
      runId: identity.runId,
      source: "api",
      tool: "spawn_agent",
      action: "agent:spawn",
      resource: "session:" + stored.name,
      effect: "allow",
      reason: derived.reason,
    });
    await this.workspaces.create(stored, this.instructionContext(stored));
    if (input.task?.trim() && stored.dmChannelId) {
      const message = await this.store.mutate((database) =>
        this.appendMessage(database, stored.dmChannelId as string, {
          authorId: parent.id,
          authorName: parent.name,
          authorKind: parent.kind,
          kind: "message",
          content: input.task?.trim() ?? "",
          runId: identity.runId,
          approvalId: null,
          ...this.traceOfRun(identity.runId),
        }),
      );
      await this.wakeMembers(stored.dmChannelId, message);
    }
    return stored;
  }

  async agentClose(identity: RunIdentity, targetId: string): Promise<Agent> {
    const actor = this.getAgent(identity.agentId);
    const target = this.getAgent(targetId);
    await this.authorize(actor, identity.runId, "close_agent", "agent:close", targetId);
    if (target.kind !== "session" || !this.isAncestor(actor.id, target)) {
      throw new HttpError(403, "Denied: " + actor.name + " may only close sessions it spawned");
    }
    return this.closeSession(targetId, "closed by " + actor.name);
  }

  async agentRequestPrincipal(
    identity: RunIdentity,
    input: RequestPrincipalInput,
  ): Promise<ApprovalRequest> {
    const requester = this.getAgent(identity.agentId);
    await this.authorize(requester, identity.runId, "request_principal", "principal:request", "*");
    const channelIds = (input.channels ?? [])
      .map((name) => {
        try {
          return this.getChannelByName(name).id;
        } catch {
          return null;
        }
      })
      .filter((id): id is string => Boolean(id));
    const payload: ApprovalPayload = {
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions.trim(),
      policy: presetPolicy(input.preset),
      channelIds,
    };
    return this.store.mutate((database) => {
      const approvals = database.channels.find((channel) => channel.name === APPROVALS_CHANNEL);
      if (!approvals) throw new HttpError(500, "Approvals channel missing");
      const approval: ApprovalRequest = {
        id: randomUUID(),
        requesterId: requester.id,
        requesterName: requester.name,
        kind: "create_principal",
        payload,
        status: "pending",
        channelMessageId: null,
        createdAt: now(),
        resolvedAt: null,
      };
      const message = this.appendMessage(database, approvals.id, {
        authorId: requester.id,
        authorName: requester.name,
        authorKind: requester.kind,
        kind: "approval",
        content:
          requester.name +
          " requests a new principal \"" +
          payload.name +
          "\" (" +
          input.preset +
          "): " +
          payload.instructions,
        runId: identity.runId,
        approvalId: approval.id,
        ...this.traceOfRun(identity.runId),
      });
      approval.channelMessageId = message.id;
      database.approvals.push(approval);
      return structuredClone(approval);
    });
  }

  async resolveApproval(id: string, decision: "approve" | "deny"): Promise<ApprovalRequest> {
    const approval = this.store.peek().approvals.find((item) => item.id === id);
    if (!approval) throw new HttpError(404, "Approval not found");
    if (approval.status !== "pending") throw new HttpError(409, "Approval already resolved");
    let created: Agent | null = null;
    if (decision === "approve") {
      created = await this.createAgent({
        name: approval.payload.name,
        description: approval.payload.description,
        instructions: approval.payload.instructions,
        policy: approval.payload.policy,
        channelIds: approval.payload.channelIds,
      });
    }
    const requester = this.store.peek().agents.find((agent) => agent.id === approval.requesterId);
    const requestMessage = this.store
      .peek()
      .messages.find((item) => item.id === approval.channelMessageId);
    const resolved = await this.store.mutate((database) => {
      const stored = database.approvals.find((item) => item.id === id);
      if (!stored) throw new HttpError(404, "Approval not found");
      stored.status = decision === "approve" ? "approved" : "denied";
      stored.resolvedAt = now();
      const approvals = database.channels.find((channel) => channel.name === APPROVALS_CHANNEL);
      const text =
        decision === "approve"
          ? "Approved: created principal " + (created?.name ?? stored.payload.name)
          : "Denied: request for principal " + stored.payload.name;
      for (const channelId of new Set([approvals?.id, requester?.dmChannelId])) {
        if (!channelId) continue;
        this.appendMessage(database, channelId, {
          authorId: USER_ID,
          authorName: this.config.userName,
          authorKind: "user",
          kind: "system",
          content: text,
          runId: null,
          approvalId: stored.id,
          traceId: requestMessage?.traceId,
          parentMessageId: requestMessage?.id ?? null,
        });
      }
      return structuredClone(stored);
    });
    if (requester?.dmChannelId) {
      const messages = this.getMessages(requester.dmChannelId, 1);
      const last = messages.at(-1);
      if (last) await this.wakeMembers(requester.dmChannelId, last, true);
    }
    return resolved;
  }

  // ---------------------------------------------------------------- sessions

  private childrenOf(agentId: string): Agent[] {
    return this.store.peek().agents.filter((agent) => agent.parentAgentId === agentId).map((a) => structuredClone(a));
  }

  private depthOf(agent: Agent): number {
    let depth = 0;
    let cursor: Agent | undefined = agent;
    while (cursor?.parentAgentId) {
      depth += 1;
      cursor = this.store.peek().agents.find((item) => item.id === cursor?.parentAgentId);
    }
    return depth;
  }

  private isAncestor(candidateId: string, agent: Agent): boolean {
    let cursor: Agent | undefined = agent;
    while (cursor?.parentAgentId) {
      if (cursor.parentAgentId === candidateId) return true;
      cursor = this.store.peek().agents.find((item) => item.id === cursor?.parentAgentId);
    }
    return false;
  }

  async closeSession(id: string, reason: string): Promise<Agent> {
    for (const child of this.childrenOf(id)) {
      await this.closeSession(child.id, reason);
    }
    await this.cancelExecution(id);
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      agent.status = "closed";
      agent.updatedAt = now();
      for (const channel of database.channels) {
        if (channel.kind !== "dm") {
          channel.memberIds = channel.memberIds.filter((memberId) => memberId !== id);
        }
      }
      if (agent.dmChannelId) {
        this.appendMessage(database, agent.dmChannelId, {
          authorId: "system",
          authorName: "system",
          authorKind: "system",
          kind: "system",
          content: agent.name + " closed (" + reason + ")",
          runId: null,
          approvalId: null,
        });
      }
      return structuredClone(agent);
    });
  }

  // --------------------------------------------------------------- scheduler

  /** Wakes members that a message addresses: everyone in a DM, @mentions elsewhere. */
  private async wakeMembers(
    channelId: string,
    message: ChannelMessage,
    force = false,
  ): Promise<void> {
    const channel = this.getChannel(channelId);
    const database = this.store.peek();
    const fromHuman = message.authorKind === "user";
    if (!fromHuman && !force) {
      const used = (this.chatter.get(channelId) ?? 0) + 1;
      this.chatter.set(channelId, used);
      if (used > CHATTER_BUDGET) {
        if (used === CHATTER_BUDGET + 1) {
          await this.store.mutate((db) =>
            this.appendMessage(db, channelId, {
              authorId: "system",
              authorName: "system",
              authorKind: "system",
              kind: "system",
              content:
                "Paused: " + CHATTER_BUDGET + " agent turns without a human message. Post to resume.",
              runId: null,
              approvalId: null,
            }),
          );
        }
        return;
      }
    }
    // A reply to a mention wakes the mentioner: if the message that woke this
    // author @mentioned it, the author of that message is waiting for an answer.
    const parent = message.parentMessageId
      ? database.messages.find((item) => item.id === message.parentMessageId)
      : undefined;
    const asker =
      parent && parent.authorId !== USER_ID && parent.authorId !== message.authorId
        ? database.agents.find((item) => item.id === parent.authorId)
        : undefined;
    const askerAddressed =
      asker !== undefined &&
      parent !== undefined &&
      mentions(parent.content, message.authorName, database.agents) &&
      (parent.expectsReply ?? parent.content.includes("?"));
    const recipients = new Set(channel.memberIds);
    if (askerAddressed && asker) recipients.add(asker.id);
    for (const memberId of recipients) {
      if (memberId === USER_ID || memberId === message.authorId) continue;
      const agent = database.agents.find((item) => item.id === memberId);
      if (!agent || agent.status === "stopped" || agent.status === "closed") continue;
      const addressed =
        force ||
        channel.kind === "dm" ||
        mentions(message.content, agent.name, database.agents) ||
        (askerAddressed && agent.id === asker?.id);
      if (!addressed) continue;
      if (evaluate(agent.policy, "channel:read", "channel:" + channel.name).effect !== "allow") {
        continue;
      }
      // Woken by an answer to its own question: reply where it was originally asked.
      let replyChannelId: string | null = null;
      if (askerAddressed && asker && agent.id === asker.id && parent?.runId) {
        const askingRun = database.runs.find((run) => run.id === parent.runId);
        replyChannelId = askingRun?.replyChannelId ?? askingRun?.channelId ?? null;
      }
      await this.queueTurn(agent.id, channelId, message, replyChannelId);
    }
  }

  /** True (and posts a notice once) when one prompt has already caused TRACE_BUDGET runs. */
  private async traceExhausted(trigger: ChannelMessage, channelId: string): Promise<boolean> {
    const runs = this.store.peek().runs.filter((run) => run.traceId === trigger.traceId).length;
    if (runs < TRACE_BUDGET) return false;
    if (runs === TRACE_BUDGET && !this.traceNotices.has(trigger.traceId)) {
      this.traceNotices.add(trigger.traceId);
      await this.store.mutate((database) =>
        this.appendMessage(database, channelId, {
          authorId: "system",
          authorName: "system",
          authorKind: "system",
          kind: "system",
          content:
            "Paused: this prompt already caused " +
            TRACE_BUDGET +
            " agent runs. Post a new message to continue.",
          runId: null,
          approvalId: null,
          traceId: trigger.traceId,
          parentMessageId: trigger.id,
        }),
      );
    }
    return true;
  }

  private deferWake(agentId: string, channelId: string, messageId: string): void {
    const pending = this.pendingWakes.get(agentId) ?? new Map<string, string>();
    pending.set(channelId, messageId);
    this.pendingWakes.set(agentId, pending);
  }

  private async queueTurn(
    agentId: string,
    channelId: string,
    trigger: ChannelMessage,
    replyChannelId: string | null = null,
  ): Promise<void> {
    if (!isModelConfigured(this.config)) return;
    if (trigger.authorKind !== "user" && (await this.traceExhausted(trigger, channelId))) return;
    const agent = this.getAgent(agentId);
    if (agent.status === "busy" || this.activeExecutions.has(agentId)) {
      this.deferWake(agentId, channelId, trigger.id);
      return;
    }
    const prompt = this.buildChannelPrompt(agent, channelId, trigger, replyChannelId);
    if (!prompt) return;
    try {
      await this.startRun(agent, {
        trigger: "channel",
        channelId,
        replyChannelId,
        prompt,
        traceId: trigger.traceId,
        triggerMessageId: trigger.id,
      });
    } catch (error) {
      if (!(error instanceof HttpError && error.statusCode === 409)) throw error;
      this.deferWake(agentId, channelId, trigger.id);
    }
  }

  private buildChannelPrompt(
    agent: Agent,
    channelId: string,
    trigger?: ChannelMessage | undefined,
    replyChannelId: string | null = null,
  ): string | null {
    const database = this.store.peek();
    const channel = database.channels.find((item) => item.id === channelId);
    if (!channel) return null;
    const lastRun = database.runs
      .filter((run) => run.agentId === agent.id && run.channelId === channelId && run.completedAt)
      .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? ""))[0];
    const since = lastRun?.startedAt ?? "";
    const messages = database.messages
      .filter(
        (message) =>
          message.channelId === channelId &&
          message.kind !== "denial" &&
          message.authorId !== agent.id &&
          message.createdAt > since,
      )
      .slice(-CONTEXT_MESSAGES);
    if (messages.length === 0) return null;
    const lines = messages.map(
      (message) =>
        "[" +
        message.createdAt.slice(11, 19) +
        "] " +
        message.authorName +
        (message.authorKind === "session" ? " (session)" : "") +
        (message.kind === "message" ? ": " : " · " + message.kind + ": ") +
        message.content,
    );
    const chain: string[] = [];
    if (trigger) {
      const root = database.messages.find((item) => item.id === trigger.traceId);
      const runsSoFar = database.runs.filter((run) => run.traceId === trigger.traceId).length;
      if (root && root.id !== trigger.id) {
        chain.push(
          "Chain context: these messages follow from " +
            root.authorName +
            "'s original request in #" +
            (database.channels.find((item) => item.id === root.channelId)?.name ?? "?") +
            ': "' +
            root.content.slice(0, 400).replace(/\s+/g, " ") +
            '". This chain has already used ' +
            runsSoFar +
            " of " +
            TRACE_BUDGET +
            " agent runs.",
        );
      }
      if (trigger.authorKind !== "user") {
        chain.push(
          "The latest message is from another agent, not the human. If the original request is already resolved, reply in one short line without @mentioning anyone (or say nothing new). @mention an agent only when you need a reply or an action from it; answers and acknowledgements need no mention — an answer is routed back to whoever asked automatically.",
        );
      }
    }
    const replyChannel = replyChannelId
      ? database.channels.find((item) => item.id === replyChannelId)
      : undefined;
    const destination = replyChannel && replyChannel.id !== channel.id
      ? (replyChannel.kind === "dm" ? "your DM with " + (replyChannel.memberIds.includes(USER_ID) ? this.config.userName : "the requester") : "#" + replyChannel.name) +
        " (where you were originally asked)"
      : "#" + channel.name;
    return [
      "New messages in #" + channel.name + " addressed to you:",
      "",
      ...lines,
      "",
      ...(chain.length > 0 ? [...chain, ""] : []),
      "Respond to these messages. Your reply is posted to " +
        destination +
        " automatically; use the launchpad tools only to act elsewhere or coordinate with other agents.",
    ].join("\n");
  }

  // -------------------------------------------------------------------- runs

  private async startRun(agent: Agent, options: RunOptions): Promise<AgentRun> {
    const timestamp = now();
    const run: AgentRun = {
      id: randomUUID(),
      agentId: agent.id,
      status: "queued",
      trigger: options.trigger,
      channelId: options.channelId,
      replyChannelId: options.replyChannelId ?? options.channelId,
      traceId: options.traceId,
      triggerMessageId: options.triggerMessageId,
      prompt: options.prompt,
      output: null,
      error: null,
      usage: null,
      events: [],
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const stored = database.agents.find((item) => item.id === agent.id);
      if (!stored) throw new HttpError(404, "Agent not found");
      if (stored.status === "stopped") throw new HttpError(409, "Agent is stopped");
      if (stored.status === "closed") throw new HttpError(409, "Session is closed");
      if (stored.status === "busy") throw new HttpError(409, "This Agent is already running");
      database.runs.push(run);
      const snapshot = structuredClone(stored);
      stored.status = "busy";
      stored.lastError = null;
      stored.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agent.id, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agent.id) === execution) {
          this.activeExecutions.delete(agent.id);
        }
      })
      .catch(() => undefined);
    return run;
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    const events: RunEvent[] = [];
    this.liveEvents.set(run.id, events);
    const token = this.mintToken(agentAtStart.id, run.id);
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) throw new RunCancelledError();
      const codexHome = agentCodexHome(this.config, agentAtStart.id);
      await renderCodexHome({
        dir: codexHome,
        config: this.config,
        agent: agentAtStart,
        scriptsDir: runtimeScriptsDirForCodex(this.config),
        integrations: this.integrations?.forAgent(agentAtStart).map((entry) => ({
          name: entry.integration.name,
          kind: entry.integration.kind,
          url: entry.integration.url,
          command: entry.integration.command,
          args: entry.integration.args,
          enabledTools: entry.enabledTools,
        })),
        credentialsFile: (await this.integrations?.credentialsFor(agentAtStart)) ?? null,
      });
      await this.workspaces.writeInstructions(agentAtStart, this.instructionContext(agentAtStart));
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        runId: run.id,
        workspacePath: agentAtStart.workspacePath,
        codexHome,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        sandboxMode: effectiveSandboxMode(this.config, agentAtStart),
        env: { AGENT_TOKEN: token, LAUNCHPAD_URL: this.config.agentApiBaseUrl },
        onEvent: (event) => {
          if (events.length < MAX_EVENTS_PER_RUN) events.push(event);
        },
      });
      const completedAt = now();
      const posted = await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return null;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.events = events;
        storedRun.completedAt = completedAt;
        if (agent.status === "busy") agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
        const channelId = run.replyChannelId ?? run.channelId ?? agent.dmChannelId;
        if (!channelId) return null;
        return this.appendMessage(database, channelId, {
          authorId: agent.id,
          authorName: agent.name,
          authorKind: agent.kind,
          kind: "message",
          content: result.output,
          runId: run.id,
          approvalId: null,
          traceId: run.traceId ?? undefined,
          parentMessageId: run.triggerMessageId,
        });
      });
      if (posted) await this.wakeMembers(posted.channelId, posted);
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.events = events;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status === "busy") agent.status = cancelled ? "ready" : "error";
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
          const channelId = run.replyChannelId ?? run.channelId ?? agent.dmChannelId;
          if (channelId && !cancelled) {
            this.appendMessage(database, channelId, {
              authorId: "system",
              authorName: "system",
              authorKind: "system",
              kind: "system",
              content: agent.name + " run failed: " + message,
              runId: run.id,
              approvalId: null,
              traceId: run.traceId ?? undefined,
              parentMessageId: run.triggerMessageId,
            });
          }
        }
      });
    } finally {
      this.revokeRunTokens(run.id);
      this.liveEvents.delete(run.id);
      await this.drainPendingWakes(agentAtStart.id);
    }
  }

  private async drainPendingWakes(agentId: string): Promise<void> {
    const pending = this.pendingWakes.get(agentId);
    if (!pending || pending.size === 0) return;
    const [entry] = pending;
    if (!entry) return;
    const [channelId, messageId] = entry;
    pending.delete(channelId);
    if (pending.size === 0) this.pendingWakes.delete(agentId);
    const agent = this.getAgent(agentId);
    if (agent.status !== "ready") return;
    const trigger = this.store.peek().messages.find((item) => item.id === messageId);
    const prompt = this.buildChannelPrompt(agent, channelId, trigger);
    if (!prompt) {
      await this.drainPendingWakes(agentId);
      return;
    }
    await this.startRun(agent, {
      trigger: "channel",
      channelId,
      prompt,
      traceId: trigger?.traceId ?? null,
      triggerMessageId: trigger?.id ?? null,
    }).catch(() => undefined);
  }

  // ----------------------------------------------------------------- helpers

  private instructionContext(agent: Agent): InstructionContext {
    const database = this.store.peek();
    const parent = agent.parentAgentId
      ? database.agents.find((item) => item.id === agent.parentAgentId)
      : undefined;
    return {
      channelNames: database.channels
        .filter((channel) => !channel.archivedAt && channel.memberIds.includes(agent.id))
        .map((channel) => channel.name),
      parentName: parent?.name ?? null,
      tools: enabledMcpTools(agent),
    };
  }

  private resolveChannels(channelIds: string[]): Channel[] {
    const database = this.store.peek();
    return channelIds
      .map((id) => database.channels.find((channel) => channel.id === id && !channel.archivedAt))
      .filter((channel): channel is Channel => Boolean(channel))
      .filter((channel) => channel.kind !== "dm")
      .map((channel) => structuredClone(channel));
  }

  private findAgentByName(name: string): Agent | undefined {
    const clean = name.replace(/^@/, "").trim().toLowerCase();
    return this.store
      .peek()
      .agents.find((agent) => agent.name.toLowerCase() === clean && agent.status !== "closed");
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "closed") throw new HttpError(409, "Session is closed");
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    this.pendingWakes.delete(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) await execution;
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }

  userPolicy(): Policy {
    return USER_POLICY;
  }
}

/** True when `content` @mentions the agent by full name or slug. */
export function mentions(content: string, agentName: string, agents: Agent[]): boolean {
  const lower = content.toLowerCase();
  const name = agentName.toLowerCase();
  const slug = name.replace(/[^a-z0-9/_-]+/g, "-");
  const candidates = new Set([name, slug, slug.split("/").at(-1) ?? slug]);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const index = lower.indexOf("@" + candidate);
    if (index === -1) continue;
    const end = index + 1 + candidate.length;
    const next = lower[end];
    if (next === undefined || !/[a-z0-9_/-]/.test(next)) return true;
  }
  if (lower.includes("@everyone") || lower.includes("@all")) return true;
  void agents;
  return false;
}
