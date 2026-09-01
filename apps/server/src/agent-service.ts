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
  grantOverride,
  mapToolCall,
  matchAction,
  matchResource,
  normalizePolicy,
  presetPolicy,
  PRESETS,
  USER_POLICY,
} from "./policy.js";
import { assignSequenceNumbers, JsonStore, legacyDmChannelId } from "./store.js";
import { ReviewArtifactStorage } from "./review-artifacts.js";
import {
  channelHead,
  channelKey,
  createInMemorySync,
  isNoReply,
  LockTimeoutError,
  NO_REPLY,
  quote,
  renderConflictFeedback,
  STATE_KINDS,
  unseenMessages,
  type Lease,
  type SyncBackend,
} from "./sync.js";
import type {
  Agent,
  AgentInput,
  AgentRun,
  AgentRunner,
  ApprovalDecision,
  ApprovalPayload,
  ApprovalRequest,
  CapabilityGrant,
  Channel,
  ChannelMessage,
  Conflict,
  Database,
  Decision,
  Effect,
  Policy,
  RunEvent,
  RunIdentity,
  RunnerResult,
  Trace,
  UpdateAgentInput,
  ReviewArtifactManifest,
} from "./types.js";
import { WorkspaceManager, type InstructionContext } from "./workspace.js";
import type { IntegrationService } from "./integration-service.js";

const now = () => new Date().toISOString();

export const USER_ID = "user";
const GENERAL_CHANNEL = "general";
const APPROVALS_CHANNEL = "approvals";
const MAX_SESSION_DEPTH = 3;
// Chatter and trace budgets live in config (CHATTER_BUDGET, TRACE_BUDGET).
/** Lost races one turn may hit (tool posts plus regenerated replies) before it is stopped. */
export const MAX_CONFLICTS_PER_TURN = 3;
const MAX_DECISIONS = 2_000;
const MAX_EVENTS_PER_RUN = 300;
const CONTEXT_MESSAGES = 20;

/** Thrown inside the run-start mutation when the wake prompt has nothing to say. */
class NothingToDoError extends Error {
  constructor() {
    super("Nothing to do");
    this.name = "NothingToDoError";
  }
}

interface PendingWake {
  /** Newest message that asked for this wake. */
  messageId: string;
  /** Set when the agent's last reply lost a race and it must regenerate. */
  conflict: Conflict | null;
}

type SyncOutcome<T> = { ok: true; value: T } | { ok: false; conflict: Conflict };

interface SyncedAction<T> {
  /** Lock key, e.g. `channel:<id>`. */
  resource: string;
  holder: string;
  /** Runs under the lock inside the store mutation; a Conflict rejects the action. */
  validate: (database: Database) => Conflict | null;
  /** Runs in the same mutation when `validate` passed. */
  commit: (database: Database) => T;
  /** Runs in the same mutation when `validate` failed (e.g. to post a notice). */
  onConflict?: ((database: Database, conflict: Conflict) => void) | undefined;
  /** Builds the conflict returned when the lock wait times out. */
  busy: (holder: string | null) => Conflict;
}

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

export interface RequestCapabilityInput {
  action: string;
  resource?: string | undefined;
  reason: string;
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
  /** A prompt, or a builder evaluated inside the run-start mutation (null = nothing to do). */
  prompt: string | ((database: Database) => string | null);
  traceId: string | null;
  triggerMessageId: string | null;
  /** Conflicts already hit earlier in this turn (a regenerate continues the count). */
  inheritedConflicts?: number | undefined;
}

interface TraceContext {
  traceId?: string | undefined;
  parentMessageId?: string | null | undefined;
}

export class AgentService {
  private readonly reviewArtifactStorage: ReviewArtifactStorage;
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly tokens = new Map<string, RunIdentity>();
  private readonly liveEvents = new Map<string, RunEvent[]>();
  /** agentId -> channelId -> the wake (and any conflict feedback) owed to the agent. */
  private readonly pendingWakes = new Map<string, Map<string, PendingWake>>();
  private readonly chatter = new Map<string, number>();
  private readonly traceNotices = new Set<string>();
  /** Conflicts per run id for identities without a stored run (tests, ad-hoc tokens). */
  private readonly conflictCounts = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly integrations: IntegrationService | null = null,
    private readonly sync: SyncBackend = createInMemorySync(),
  ) {
    this.reviewArtifactStorage = new ReviewArtifactStorage(config);
  }

  // ---------------------------------------------------------------- lifecycle

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.reviewArtifactStorage.initialize();
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
        // Reconcile narrowly changed built-in artefact defaults without touching custom policies
        // or overriding an explicit deny. Human allow-forever grants are `custom` and survive.
        if (agent.policy.preset === "reader") {
          agent.policy.statements = agent.policy.statements
            .map((statement) =>
              statement.effect === "allow"
                ? { ...statement, actions: statement.actions.filter((action) => action !== "artifact:read") }
                : statement,
            )
            .filter((statement) => statement.actions.length > 0);
        }
        if (
          (agent.policy.preset === "worker" || agent.policy.preset === "deployer") &&
          evaluate(agent.policy, "artifact:publish", "artifact:*").statement === null
        ) {
          agent.policy.statements.push({ effect: "allow", actions: ["artifact:publish"], resources: ["artifact:*"] });
        }
        if (
          agent.policy.preset === "deployer" &&
          evaluate(agent.policy, "artifact:read", "artifact:*").statement === null
        ) {
          agent.policy.statements.push({ effect: "allow", actions: ["artifact:read"], resources: ["artifact:*"] });
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
        run.seenSeq ??= null;
        run.conflicts ??= 0;
        run.conflict ??= null;
        run.silent ??= false;
      }
      for (const decision of database.decisions) decision.traceId ??= null;
      database.integrations ??= [];
      database.grants ??= [];
      database.reviewArtifacts ??= [];
      for (const agent of database.agents) agent.ownIntegrationIds ??= [];
      for (const approval of database.approvals) {
        approval.kind ??= "create_principal";
        approval.capability ??= null;
        approval.resolution ??= null;
        approval.channelId ??= null;
      }
      // One-run grants never survive a restart (their run was cancelled above).
      database.grants = database.grants.filter((grant) => grant.runId === null);
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
      assignSequenceNumbers(database);
      this.seedReadState(database);
    });
  }

  /** After a restart, what each agent has seen is what its runs covered plus its own posts. */
  private seedReadState(database: Database): void {
    for (const run of database.runs) {
      if (run.channelId && run.seenSeq !== null) {
        this.sync.reads.advance(run.agentId, channelKey(run.channelId), run.seenSeq);
      }
    }
    for (const message of database.messages) {
      if (message.authorId !== USER_ID && message.authorKind !== "system") {
        this.sync.reads.advance(message.authorId, channelKey(message.channelId), message.seq);
      }
    }
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
      lastSeq: 0,
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
    typing: Array<{ agentId: string; channelId: string }>;
  } {
    const database = this.store.snapshot();
    const typing = database.runs.flatMap((run) => {
      if (run.status !== "running") return [];
      const channelId = run.replyChannelId ?? run.channelId;
      return channelId ? [{ agentId: run.agentId, channelId }] : [];
    });
    return {
      user: { id: USER_ID, name: this.config.userName },
      agents: database.agents.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      channels: database.channels.filter((channel) => !channel.archivedAt),
      approvals: database.approvals.filter((approval) => approval.status === "pending"),
      integrations: database.integrations,
      typing,
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

  /**
   * Creates a channel. The channel registry is a contended resource: two
   * agents (or an agent and the human) may try the same name at once, so the
   * uniqueness check and the insert run as one synced action. When an agent
   * loses, it gets conflict feedback rather than a bare error.
   */
  async createChannel(
    input: {
      name: string;
      description?: string | undefined;
      memberIds?: string[] | undefined;
    },
    actor: { agent: Agent; runId: string | null } | null = null,
  ): Promise<Channel> {
    const name = input.name.replace(/^#/, "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    if (!name) throw new HttpError(400, "Channel name is required");
    const resource = "channel:" + name;
    const outcome = await this.performSynced<Channel>({
      resource: "channels",
      holder: actor ? (actor.runId ? "run:" + actor.runId : "agent:" + actor.agent.id) : USER_ID,
      validate: (database) => {
        const existing = database.channels.find(
          (channel) => channel.name === name && !channel.archivedAt,
        );
        if (!existing) return null;
        return this.registryConflict(
          resource,
          "create #" + name,
          "#" + name + " already exists (created " + existing.createdAt.slice(11, 19) + ")",
          "Use the existing channel (list_channels, read_channel) or choose another name.",
          actor?.runId ?? null,
        );
      },
      commit: (database) => {
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
      },
      onConflict: (database, conflict) => {
        if (actor) this.countConflict(database, actor.runId);
        void conflict;
      },
      busy: (holder) =>
        this.registryConflict(
          resource,
          "create #" + name,
          "the channel registry is busy" + (holder ? " (" + holder + ")" : ""),
          "Try again in a moment.",
          actor?.runId ?? null,
        ),
    });
    if (outcome.ok) return outcome.value;
    if (actor) {
      await this.recordDecision({
        agentId: actor.agent.id,
        agentName: actor.agent.name,
        runId: actor.runId,
        source: "sync",
        tool: "create_channel",
        action: "channel:create",
        resource,
        effect: "conflict",
        reason: outcome.conflict.winnerContent ?? "conflict",
      });
      await this.announceConflict(
        actor.agent,
        actor.runId,
        actor.agent.name + " tried to create #" + name + ", but " + (outcome.conflict.winnerContent ?? "it already exists") + ".",
      );
      throw new HttpError(409, outcome.conflict.feedback, { conflict: outcome.conflict });
    }
    throw new HttpError(409, "Channel #" + name + " already exists");
  }

  async deleteChannel(id: string): Promise<Channel> {
    const channel = this.getChannel(id);
    if (channel.archivedAt) throw new HttpError(404, "Channel not found");
    if (channel.kind !== "public" || channel.name === GENERAL_CHANNEL) {
      throw new HttpError(409, "System, general and DM channels cannot be deleted");
    }

    const archived = await this.store.mutate((database) => {
      const current = database.channels.find((item) => item.id === id);
      if (!current || current.archivedAt) throw new HttpError(404, "Channel not found");
      const activeRun = database.runs.some(
        (run) =>
          (run.status === "queued" || run.status === "running") &&
          (run.channelId === id || run.replyChannelId === id),
      );
      if (activeRun) throw new HttpError(409, "Wait for active channel Runs to finish before deleting it");
      const pendingApproval = database.approvals.some(
        (approval) => approval.status === "pending" && approval.channelId === id,
      );
      if (pendingApproval) throw new HttpError(409, "Resolve pending channel approvals before deleting it");
      current.archivedAt = now();
      return structuredClone(current);
    });
    for (const memberId of archived.memberIds) {
      if (memberId === USER_ID) continue;
      const member = this.store.peek().agents.find((agent) => agent.id === memberId);
      if (member) await this.workspaces.writeInstructions(member, this.instructionContext(member));
      const pending = this.pendingWakes.get(memberId);
      pending?.delete(id);
      if (pending?.size === 0) this.pendingWakes.delete(memberId);
    }
    return archived;
  }

  /** A conflict on a non-channel resource (a registry, an approval): compare-and-set failed. */
  private registryConflict(
    resource: string,
    rejected: string,
    what: string,
    next: string,
    runId: string | null,
  ): Conflict {
    const attempt = this.conflictsSoFar(this.store.peek(), runId) + 1;
    return {
      resource,
      cause: "stale",
      winnerId: null,
      winnerName: null,
      winnerContent: what,
      winnerMessageId: null,
      winnerSeq: null,
      rejectedContent: rejected,
      unseen: [],
      seenSeq: 0,
      headSeq: 0,
      attempt,
      limit: MAX_CONFLICTS_PER_TURN,
      feedback:
        "Your action (" +
        rejected +
        ") was not accepted: " +
        what +
        ". Someone acted first; this is a lost race, not a permission problem. " +
        next,
    };
  }

  /** Posts a conflict notice where the agent's run is visible (its run channel, else its DM). */
  private async announceConflict(agent: Agent, runId: string | null, content: string): Promise<void> {
    const run = runId ? this.store.peek().runs.find((item) => item.id === runId) : null;
    const channelId = run?.channelId ?? agent.dmChannelId;
    if (!channelId) return;
    await this.store.mutate((database) =>
      this.appendMessage(database, channelId, {
        authorId: agent.id,
        authorName: agent.name,
        authorKind: agent.kind,
        kind: "conflict",
        content,
        runId,
        approvalId: null,
        ...this.traceOfRun(runId),
      }),
    );
  }

  /**
   * The human posts to a channel. Wakes every member the message addresses.
   * The human is the authority: the post takes the channel lock (so it never
   * interleaves with an agent's validate+commit) but is never rejected as stale.
   * It does bump `lastSeq`, so every agent's view of the channel becomes stale
   * until it re-reads.
   */
  async postUserMessage(channelId: string, content: string): Promise<ChannelMessage> {
    const channel = this.getChannel(channelId);
    if (channel.archivedAt) throw new HttpError(410, "Channel has been deleted");
    const lease = await this.sync.locks.acquire(channelKey(channel.id), USER_ID).catch((error) => {
      if (error instanceof LockTimeoutError) throw new HttpError(503, "Channel is busy, try again");
      throw error;
    });
    let message: ChannelMessage;
    try {
      message = await this.store.mutate((database) =>
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
    } finally {
      lease.release();
    }
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
    input: Omit<
      ChannelMessage,
      "id" | "channelId" | "createdAt" | "seq" | "traceId" | "parentMessageId"
    > &
      TraceContext,
  ): ChannelMessage {
    const channel = database.channels.find((item) => item.id === channelId);
    if (!channel) throw new HttpError(404, "Channel not found");
    const id = randomUUID();
    const { traceId, parentMessageId, ...rest } = input;
    channel.lastSeq += 1;
    const message: ChannelMessage = {
      id,
      channelId,
      createdAt: now(),
      ...rest,
      seq: channel.lastSeq,
      traceId: traceId ?? id,
      parentMessageId: parentMessageId ?? null,
    };
    database.messages.push(message);
    channel.lastMessageAt = message.createdAt;
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

  // ------------------------------------------------------- synchronisation

  /**
   * Runs one contended action: take the resource lock, then validate and
   * commit inside a single store mutation, so nothing else can write between
   * the check and the append. The lock is released whatever happens; a lease
   * expires it if this process never gets there.
   *
   * To wire a new action, supply a resource key, a `validate` that returns a
   * Conflict when the actor's view is stale, and a `commit`.
   */
  private async performSynced<T>(action: SyncedAction<T>): Promise<SyncOutcome<T>> {
    let lease;
    try {
      lease = await this.sync.locks.acquire(action.resource, action.holder);
    } catch (error) {
      if (error instanceof LockTimeoutError) {
        return { ok: false, conflict: action.busy(error.holder) };
      }
      throw error;
    }
    try {
      return await this.store.mutate((database): SyncOutcome<T> => {
        const conflict = action.validate(database);
        if (conflict) {
          action.onConflict?.(database, conflict);
          return { ok: false, conflict };
        }
        return { ok: true, value: action.commit(database) };
      });
    } finally {
      lease.release();
    }
  }

  /** Conflicts this turn has already hit, from the stored run or the ad-hoc counter. */
  private conflictsSoFar(database: Readonly<Database>, runId: string | null): number {
    if (!runId) return 0;
    const run = database.runs.find((item) => item.id === runId);
    return run ? run.conflicts : (this.conflictCounts.get(runId) ?? 0);
  }

  private countConflict(database: Database, runId: string | null): void {
    if (!runId) return;
    const run = database.runs.find((item) => item.id === runId);
    if (run) run.conflicts += 1;
    else this.conflictCounts.set(runId, (this.conflictCounts.get(runId) ?? 0) + 1);
  }

  /**
   * Read-before-act: the agent may write to the channel only if it has been
   * shown every state-bearing message in it. Returns the Conflict otherwise.
   */
  private staleCheck(
    database: Readonly<Database>,
    agent: Agent,
    channelId: string,
    rejectedContent: string,
    runId: string | null,
  ): Conflict | null {
    const channel = database.channels.find((item) => item.id === channelId);
    if (!channel) return null;
    const seenSeq = this.sync.reads.get(agent.id, channelKey(channelId));
    const head = channelHead(database, channelId);
    if (!head || head.seq <= seenSeq || head.authorId === agent.id) return null;
    const unseen = unseenMessages(database, channelId, agent.id, seenSeq);
    const winner = unseen.at(-1) ?? head;
    const conflict: Conflict = {
      resource: "channel:" + channel.name,
      cause: "stale",
      winnerId: winner.authorId,
      winnerName: winner.authorName,
      winnerContent: winner.content,
      winnerMessageId: winner.id,
      winnerSeq: winner.seq,
      rejectedContent,
      unseen,
      seenSeq,
      headSeq: head.seq,
      attempt: this.conflictsSoFar(database, runId) + 1,
      limit: MAX_CONFLICTS_PER_TURN,
      feedback: "",
    };
    conflict.feedback = renderConflictFeedback(conflict, channel.name);
    return conflict;
  }

  /**
   * Where an accepted channel post hangs in its chain. The message that woke a
   * run is often not what the agent answered: with several agents racing, or a
   * wake queued while it was busy, the channel has moved on by the time it
   * replies, and read-before-act has made it see everything since. So the post
   * follows the newest state-bearing message in that channel, from someone
   * else, that the agent has been shown and that either belongs to the run's
   * chain or addressed the agent (a newer prompt it read mid-turn; it would
   * have woken it anyway). The wake message is the fallback. When the post
   * joins a newer chain, the run and its decisions move with it, so a trace
   * holds every turn that contributed to it.
   */
  private replyLineage(database: Database, agent: Agent, channel: Channel, runId: string | null): TraceContext {
    const run = runId ? database.runs.find((item) => item.id === runId) : undefined;
    if (!run) return {};
    const seenSeq = this.sync.reads.get(agent.id, channelKey(channel.id));
    let target: ChannelMessage | null = null;
    for (const message of database.messages) {
      if (message.channelId !== channel.id || message.seq > seenSeq || message.authorId === agent.id) continue;
      if (!STATE_KINDS.has(message.kind) || (target !== null && message.seq < target.seq)) continue;
      if (message.traceId !== run.traceId && !this.addresses(database, channel, agent, message)) continue;
      target = message;
    }
    if (!target) return { traceId: run.traceId ?? undefined, parentMessageId: run.triggerMessageId };
    if (run.traceId !== target.traceId) {
      run.traceId = target.traceId;
      for (const decision of database.decisions) {
        if (decision.runId === run.id) decision.traceId = target.traceId;
      }
    }
    return { traceId: target.traceId, parentMessageId: target.id };
  }

  /** Whether a message wakes the agent on its own: anything in a DM, an @mention or @everyone elsewhere. */
  private addresses(database: Readonly<Database>, channel: Channel, agent: Agent, message: ChannelMessage): boolean {
    return channel.kind === "dm" || mentions(message.content, agent.name, database.agents);
  }

  private busyConflict(
    agent: Agent,
    channel: Channel,
    rejectedContent: string,
    runId: string | null,
    holder: string | null,
  ): Conflict {
    const conflict: Conflict = {
      resource: "channel:" + channel.name,
      cause: "busy",
      winnerId: holder,
      winnerName: holder,
      winnerContent: null,
      winnerMessageId: null,
      winnerSeq: null,
      rejectedContent,
      unseen: [],
      seenSeq: this.sync.reads.get(agent.id, channelKey(channel.id)),
      headSeq: channel.lastSeq,
      attempt: this.conflictsSoFar(this.store.peek(), runId) + 1,
      limit: MAX_CONFLICTS_PER_TURN,
      feedback: "",
    };
    conflict.feedback = renderConflictFeedback(conflict, channel.name);
    return conflict;
  }

  /** One-line, judge-readable notice posted into the channel where the race was lost. */
  private conflictNotice(agent: Agent, conflict: Conflict, source: "post_message" | "auto_post"): string {
    const tried =
      source === "auto_post"
        ? agent.name + "'s reply " + quote(conflict.rejectedContent, 80) + " was not posted"
        : agent.name + " tried to post " + quote(conflict.rejectedContent, 80);
    const why =
      conflict.cause === "busy"
        ? "the channel was busy"
        : (conflict.winnerName ?? "someone") +
          " got there first with " +
          quote(conflict.winnerContent ?? "", 80) +
          " (#" +
          String(conflict.winnerSeq ?? "?") +
          ")";
    const next =
      conflict.attempt > conflict.limit
        ? agent.name + " stops here: " + String(conflict.limit) + " conflicts this turn."
        : agent.name + " will re-read and regenerate.";
    return tried + ", but " + why + ". " + next;
  }

  private appendConflictNotice(
    database: Database,
    agent: Agent,
    channelId: string,
    conflict: Conflict,
    runId: string | null,
    source: "post_message" | "auto_post",
  ): ChannelMessage {
    return this.appendMessage(database, channelId, {
      authorId: agent.id,
      authorName: agent.name,
      authorKind: agent.kind,
      kind: "conflict",
      content: this.conflictNotice(agent, conflict, source),
      runId,
      approvalId: null,
      ...this.traceOfRun(runId),
    });
  }

  private conflictEvent(conflict: Conflict, channelName: string): RunEvent {
    return {
      id: randomUUID(),
      type: "conflict",
      summary:
        "post to #" +
        channelName +
        " rejected: " +
        (conflict.cause === "busy"
          ? "channel busy"
          : (conflict.winnerName ?? "someone") + " posted " + quote(conflict.winnerContent ?? "", 80) + " first"),
      status: conflict.attempt > conflict.limit ? "limit" : "conflict",
      exitCode: null,
      detail: conflict.feedback,
      createdAt: now(),
    };
  }

  private async recordSync(
    agent: Agent,
    runId: string | null,
    tool: string,
    channel: Channel,
    outcome: { ok: true; message: ChannelMessage } | { ok: false; conflict: Conflict },
  ): Promise<void> {
    await this.recordDecision({
      agentId: agent.id,
      agentName: agent.name,
      runId,
      source: "sync",
      tool,
      action: "channel:post",
      resource: "channel:" + channel.name,
      effect: outcome.ok ? "allow" : "conflict",
      reason: outcome.ok
        ? "Read-before-act: seen through #" +
          String(outcome.message.seq - 1) +
          ", posted #" +
          String(outcome.message.seq)
        : outcome.conflict.cause === "busy"
          ? "Lock wait timed out" + (outcome.conflict.winnerName ? " (held by " + outcome.conflict.winnerName + ")" : "")
          : "Lost the race: " +
            (outcome.conflict.winnerName ?? "someone") +
            " posted #" +
            String(outcome.conflict.winnerSeq) +
            " after this agent's last read (#" +
            String(outcome.conflict.seenSeq) +
            ")" +
            (outcome.conflict.attempt > outcome.conflict.limit ? "; conflict limit reached" : ""),
    });
  }

  /**
   * An agent writes to a channel through a tool. IAM has already passed; this
   * is the synchronisation half: lock, read-before-act, commit, and on a lost
   * race a notice in the channel, a run event and a Decision row.
   */
  private async agentChannelPost(
    agent: Agent,
    channel: Channel,
    content: string,
    runId: string | null,
    expectsReply?: boolean | undefined,
  ): Promise<{ ok: true; message: ChannelMessage } | { ok: false; conflict: Conflict }> {
    const outcome = await this.performSynced<ChannelMessage>({
      resource: channelKey(channel.id),
      holder: runId ? "run:" + runId : "agent:" + agent.id,
      validate: (database) => this.staleCheck(database, agent, channel.id, content, runId),
      commit: (database) => {
        const message = this.appendMessage(database, channel.id, {
          authorId: agent.id,
          authorName: agent.name,
          authorKind: agent.kind,
          kind: "message",
          content,
          runId,
          approvalId: null,
          ...(expectsReply === undefined ? {} : { expectsReply }),
          ...this.replyLineage(database, agent, channel, runId),
        });
        this.sync.reads.advance(agent.id, channelKey(channel.id), message.seq);
        return message;
      },
      onConflict: (database, conflict) => {
        this.countConflict(database, runId);
        this.appendConflictNotice(database, agent, channel.id, conflict, runId, "post_message");
      },
      busy: (holder) => this.busyConflict(agent, channel, content, runId, holder),
    });
    const result = outcome.ok ? { ok: true as const, message: outcome.value } : outcome;
    await this.recordSync(agent, runId, "post_message", channel, result);
    if (!result.ok && runId) {
      const events = this.liveEvents.get(runId);
      if (events && events.length < MAX_EVENTS_PER_RUN) events.push(this.conflictEvent(result.conflict, channel.name));
    }
    return result;
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
    const verdict = this.decide(agent, mapping.action, mapping.resource, identity.runId);
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

  /** The agent's policy plus any "allow once" grants bound to the given run. */
  effectivePolicy(agent: Agent, runId: string | null): Policy {
    const grants = this.store
      .peek()
      .grants.filter((grant) => grant.agentId === agent.id && runId !== null && grant.runId === runId);
    if (grants.length === 0) return agent.policy;
    // Same semantics as "allow forever", but only for this run: lift the covering deny
    // (so no execpolicy rule is generated for it) and add the allow.
    return grants.reduce(
      (policy, grant) => grantOverride(policy, grant.action, grant.resource),
      agent.policy,
    );
  }

  /** Policy + channel membership in one place. */
  private decide(
    agent: Agent,
    action: string,
    resource: string,
    runId: string | null = null,
  ): { effect: Effect; reason: string } {
    if (agent.status === "closed") return { effect: "deny", reason: "Session is closed" };
    if (resource.startsWith("channel:") && resource !== "channel:*") {
      const name = resource.slice("channel:".length);
      const channel = this.store
        .peek()
        .channels.find((item) => item.name.toLowerCase() === name.toLowerCase() && !item.archivedAt);
      // Creating a channel is the one action whose target does not exist yet.
      if (!channel && action !== "channel:create") {
        return { effect: "deny", reason: "Channel #" + name + " does not exist" };
      }
      if (channel && action !== "channel:create" && !channel.memberIds.includes(agent.id)) {
        return { effect: "deny", reason: agent.name + " is not a member of #" + name };
      }
    }
    const grantHit = this.store
      .peek()
      .grants.some(
        (grant) =>
          grant.agentId === agent.id &&
          runId !== null &&
          grant.runId === runId &&
          matchAction(grant.action, action) &&
          matchResource(grant.resource, resource),
      );
    if (grantHit) return { effect: "allow", reason: "Allowed once by the human for this run" };
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
    const verdict = this.decide(agent, action, resource, runId);
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
    // getMessages serves the tail of the channel, so the agent has now seen all of it.
    const messages = this.getMessages(channel.id, limit);
    this.sync.reads.advance(agent.id, channelKey(channel.id), this.getChannel(channel.id).lastSeq);
    return messages;
  }

  async agentPublishForReview(
    identity: RunIdentity,
    input: { paths: string[]; note?: string | undefined },
  ): Promise<ReviewArtifactManifest> {
    const agent = this.getAgent(identity.agentId);
    await this.authorize(agent, identity.runId, "publish_for_review", "artifact:publish", "artifact:*");
    const manifest = await this.reviewArtifactStorage.publish({
      workspacePath: agent.workspacePath,
      agentId: agent.id,
      runId: identity.runId,
      traceId: this.traceOfRun(identity.runId).traceId ?? null,
      paths: input.paths,
      note: input.note,
    });
    await this.store.mutate((database) => {
      if (database.reviewArtifacts.some((artifact) => artifact.artifactId === manifest.artifactId)) {
        throw new HttpError(409, "Review artifact already exists");
      }
      database.reviewArtifacts.push(manifest);
    });
    return structuredClone(manifest);
  }

  async agentReadReviewArtifact(
    identity: RunIdentity,
    artifactId: string,
    requestedPath?: string | undefined,
  ): Promise<Record<string, unknown>> {
    const agent = this.getAgent(identity.agentId);
    await this.authorize(agent, identity.runId, "read_review_artifact", "artifact:read", "artifact:" + artifactId);
    const manifest = this.store.peek().reviewArtifacts.find((artifact) => artifact.artifactId === artifactId);
    if (!manifest) throw new HttpError(404, "Review artifact not found");
    return this.reviewArtifactStorage.read(structuredClone(manifest), requestedPath);
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
    const result = await this.agentChannelPost(agent, channel, content, identity.runId, expectsReply);
    if (!result.ok) {
      const { conflict } = result;
      if (conflict.attempt > conflict.limit) {
        throw new HttpError(
          409,
          "Conflict limit reached: " +
            String(conflict.limit) +
            " lost races in this turn. Stop calling post_message; finish with a plain reply that says what you learned.",
          { conflict },
        );
      }
      throw new HttpError(409, conflict.feedback, { conflict });
    }
    await this.wakeMembers(channel.id, result.message);
    return result.message;
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
    const channel = await this.createChannel(
      {
        name,
        description: input.description,
        memberIds: [agent.id, ...memberIds],
      },
      { agent, runId: identity.runId },
    );
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
        capability: null,
        resolution: null,
        channelId: approvals.id,
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

  /** An agent asks the human, in its working channel, for a capability its policy lacks. */
  async agentRequestCapability(
    identity: RunIdentity,
    input: RequestCapabilityInput,
  ): Promise<ApprovalRequest> {
    const requester = this.getAgent(identity.agentId);
    await this.authorize(requester, identity.runId, "request_capability", "capability:request", "*");
    const run = this.store.peek().runs.find((item) => item.id === identity.runId);
    const channelId = run?.replyChannelId ?? run?.channelId ?? requester.dmChannelId;
    if (!channelId) throw new HttpError(409, "No channel to post the request in");
    const capability = {
      action: input.action.trim(),
      resource: input.resource?.trim() || "*",
      reason: input.reason.trim(),
    };
    if (evaluate(requester.policy, capability.action, capability.resource).effect === "allow") {
      throw new HttpError(409, "Your policy already allows " + capability.action + " on " + capability.resource);
    }
    return this.store.mutate((database) => {
      const approval: ApprovalRequest = {
        id: randomUUID(),
        requesterId: requester.id,
        requesterName: requester.name,
        kind: "capability",
        capability,
        resolution: null,
        channelId,
        payload: null,
        status: "pending",
        channelMessageId: null,
        createdAt: now(),
        resolvedAt: null,
      };
      const card = {
        authorId: requester.id,
        authorName: requester.name,
        authorKind: requester.kind,
        kind: "approval" as const,
        content:
          requester.name +
          " requests " +
          capability.action +
          " on " +
          capability.resource +
          ": " +
          capability.reason,
        runId: identity.runId,
        approvalId: approval.id,
        ...this.traceOfRun(identity.runId),
      };
      const message = this.appendMessage(database, channelId, card);
      approval.channelMessageId = message.id;
      const approvals = database.channels.find((channel) => channel.name === APPROVALS_CHANNEL);
      if (approvals && approvals.id !== channelId) {
        this.appendMessage(database, approvals.id, {
          ...card,
          content: card.content + " (in #" + (database.channels.find((c) => c.id === channelId)?.name ?? "?") + ")",
        });
      }
      database.approvals.push(approval);
      return structuredClone(approval);
    });
  }

  /**
   * The human resolves an approval. For a principal request, claiming it is a
   * synced compare-and-set on the approval itself, so two clicks (or two tabs)
   * cannot both create the principal: the second one loses the race and gets
   * a 409.
   */
  async resolveApproval(id: string, decision: ApprovalDecision): Promise<ApprovalRequest> {
    const approval = this.store.peek().approvals.find((item) => item.id === id);
    if (!approval) throw new HttpError(404, "Approval not found");
    if (approval.status !== "pending") throw new HttpError(409, "Approval already resolved");
    if (approval.kind === "capability") return this.resolveCapability(approval, decision);
    if (!approval.payload) throw new HttpError(500, "Approval has no payload");
    const claim = await this.performSynced<ApprovalRequest>({
      resource: "approval:" + id,
      holder: USER_ID,
      validate: (database) => {
        const stored = database.approvals.find((item) => item.id === id);
        if (!stored || stored.status === "pending") return null;
        return this.registryConflict(
          "approval:" + id,
          decision,
          "the request was already " + stored.status,
          "Nothing to do.",
          null,
        );
      },
      commit: (database) => {
        const stored = database.approvals.find((item) => item.id === id);
        if (!stored) throw new HttpError(404, "Approval not found");
        stored.status = decision === "deny" ? "denied" : "approved";
        stored.resolvedAt = now();
        return structuredClone(stored);
      },
      busy: (holder) =>
        this.registryConflict("approval:" + id, decision, "the approval is busy" + (holder ? " (" + holder + ")" : ""), "Try again.", null),
    });
    if (!claim.ok) {
      throw new HttpError(409, "Approval already resolved: " + (claim.conflict.winnerContent ?? ""), {
        conflict: claim.conflict,
      });
    }
    let created: Agent | null = null;
    if (decision !== "deny") {
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
      const approvals = database.channels.find((channel) => channel.name === APPROVALS_CHANNEL);
      const requestedName = stored.payload?.name ?? "agent";
      const text =
        decision !== "deny"
          ? "Approved: created principal " + (created?.name ?? requestedName)
          : "Denied: request for principal " + requestedName;
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

  private async resolveCapability(
    approval: ApprovalRequest,
    decision: ApprovalDecision,
  ): Promise<ApprovalRequest> {
    const capability = approval.capability;
    if (!capability) throw new HttpError(500, "Capability request has no payload");
    if (decision === "approve") decision = "allow_once";
    const requester = this.store.peek().agents.find((agent) => agent.id === approval.requesterId);
    const channelId = approval.channelId ?? requester?.dmChannelId ?? null;
    const requestMessage = this.store
      .peek()
      .messages.find((item) => item.id === approval.channelMessageId);
    const resolved = await this.store.mutate((database) => {
      const stored = database.approvals.find((item) => item.id === approval.id);
      if (!stored) throw new HttpError(404, "Approval not found");
      const agent = database.agents.find((item) => item.id === approval.requesterId);
      stored.status = decision === "deny" ? "denied" : "approved";
      stored.resolution = decision === "allow_forever" ? "forever" : decision === "allow_once" ? "once" : null;
      stored.resolvedAt = now();
      if (agent && decision === "allow_forever") {
        agent.policy = grantOverride(agent.policy, capability.action, capability.resource);
        agent.updatedAt = now();
      }
      if (agent && decision === "allow_once") {
        const grant: CapabilityGrant = {
          id: randomUUID(),
          agentId: agent.id,
          action: capability.action,
          resource: capability.resource,
          approvalId: stored.id,
          runId: null,
          createdAt: now(),
        };
        database.grants.push(grant);
      }
      const text =
        decision === "deny"
          ? "Denied: " + capability.action + " on " + capability.resource
          : (decision === "allow_forever" ? "Allowed forever: " : "Allowed once (next turn): ") +
            capability.action +
            " on " +
            capability.resource;
      const approvalsChannel = database.channels.find((channel) => channel.name === APPROVALS_CHANNEL);
      for (const target of new Set([channelId, approvalsChannel?.id])) {
        if (!target) continue;
        this.appendMessage(database, target, {
          authorId: USER_ID,
          authorName: this.config.userName,
          authorKind: "user",
          kind: "system",
          content: text + (target !== channelId ? " (for " + approval.requesterName + ")" : ""),
          runId: null,
          approvalId: stored.id,
          traceId: requestMessage?.traceId,
          parentMessageId: requestMessage?.id ?? null,
        });
      }
      return structuredClone(stored);
    });
    await this.recordDecision({
      agentId: approval.requesterId,
      agentName: approval.requesterName,
      runId: null,
      source: "api",
      tool: "request_capability",
      action: capability.action,
      resource: capability.resource,
      effect: decision === "deny" ? "deny" : "allow",
      reason:
        decision === "deny"
          ? "Denied by the human"
          : decision === "allow_forever"
            ? "Granted by the human (policy updated)"
            : "Granted by the human for one run",
    });
    if (requester && decision === "allow_forever") {
      const updated = this.getAgent(requester.id);
      await this.workspaces.writeInstructions(updated, this.instructionContext(updated));
    }
    // Wake the requester with the decision, replying where it was asked.
    if (requester && channelId) {
      const notice = this.getMessages(channelId, 1).at(-1);
      if (notice) {
        this.chatter.set(channelId, 0);
        await this.queueTurn(requester.id, channelId, notice);
      }
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

  /**
   * Wakes members that a message addresses: everyone in a DM, @mentions
   * elsewhere (`@everyone` wakes every member, which is how collaborators hand
   * the next step to the whole group). With TURN_TAKING=on, an agent's message
   * inside a collaboration — a trace with two or more agents that have already
   * run in this channel — also wakes the participant after the author
   * (round-robin by first run), so agents take turns without mentions.
   */
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
      if (used > this.config.chatterBudget) {
        if (used === this.config.chatterBudget + 1) {
          await this.store.mutate((db) =>
            this.appendMessage(db, channelId, {
              authorId: "system",
              authorName: "system",
              authorKind: "system",
              kind: "system",
              content:
                "Paused: " +
                String(this.config.chatterBudget) +
                " agent turns without a human message. Post to resume.",
              runId: null,
              approvalId: null,
            }),
          );
        }
        return;
      }
    }
    const nextInTurn =
      this.config.turnTaking && !fromHuman && !force && channel.kind !== "dm"
        ? this.nextParticipant(database, channel.id, message)
        : null;
    // A reply to a mention wakes the mentioner: if the message that woke this
    // author @mentioned it, the author of that message is waiting for an answer.
    // An agent's post hangs off the newest message it had seen, so the message
    // that woke it is taken from its run.
    const authorRun = message.runId ? database.runs.find((run) => run.id === message.runId) : undefined;
    const wakeId = authorRun ? authorRun.triggerMessageId : message.parentMessageId;
    const parent = wakeId ? database.messages.find((item) => item.id === wakeId) : undefined;
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
        memberId === nextInTurn ||
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

  /** Agents that have run in this trace and channel, in the order they first did. */
  private participantOrder(
    database: Readonly<Database>,
    channelId: string,
    traceId: string,
  ): string[] {
    const order: string[] = [];
    for (const run of [...database.runs]
      .filter((run) => run.traceId === traceId && run.channelId === channelId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      if (!order.includes(run.agentId)) order.push(run.agentId);
    }
    return order;
  }

  private nextAfter(order: string[], agentId: string): string | null {
    if (order.length < 2) return null;
    const index = order.indexOf(agentId);
    for (let step = 0; step < order.length; step += 1) {
      const candidate = order[(index + 1 + step) % order.length];
      if (candidate && candidate !== agentId) return candidate;
    }
    return null;
  }

  /** The participant whose turn follows the author's, or null outside a collaboration. */
  private nextParticipant(
    database: Readonly<Database>,
    channelId: string,
    message: ChannelMessage,
  ): string | null {
    return this.nextAfter(this.participantOrder(database, channelId, message.traceId), message.authorId);
  }

  /**
   * A silent turn passes to the next participant rather than ending the
   * round: the agent had nothing to add, but the others may. Once every other
   * participant has passed since the last posted message, the round is over.
   */
  private async passTurn(agent: Agent, run: AgentRun): Promise<void> {
    if (!this.config.turnTaking || !run.channelId || !run.traceId) return;
    const database = this.store.peek();
    const channel = database.channels.find((item) => item.id === run.channelId);
    if (!channel || channel.kind === "dm") return;
    const head = channelHead(database, channel.id);
    if (!head || head.traceId !== run.traceId) return;
    const order = this.participantOrder(database, channel.id, run.traceId);
    const passes = database.runs.filter(
      (item) =>
        item.channelId === channel.id &&
        item.traceId === run.traceId &&
        item.silent &&
        item.createdAt > head.createdAt,
    ).length;
    if (passes >= order.length - 1) return;
    const next = this.nextAfter(order, agent.id);
    if (!next || next === head.authorId) return;
    const member = channel.memberIds.includes(next);
    const candidate = database.agents.find((item) => item.id === next);
    if (!member || !candidate || candidate.status === "stopped" || candidate.status === "closed") return;
    if (evaluate(candidate.policy, "channel:read", "channel:" + channel.name).effect !== "allow") return;
    await this.queueTurn(next, channel.id, head);
  }

  /** True (and posts a notice once) when one prompt has already caused TRACE_BUDGET runs. */
  private async traceExhausted(trigger: ChannelMessage, channelId: string): Promise<boolean> {
    const budget = this.config.traceBudget;
    const runs = this.store.peek().runs.filter((run) => run.traceId === trigger.traceId).length;
    if (runs < budget) return false;
    if (runs === budget && !this.traceNotices.has(trigger.traceId)) {
      this.traceNotices.add(trigger.traceId);
      await this.store.mutate((database) =>
        this.appendMessage(database, channelId, {
          authorId: "system",
          authorName: "system",
          authorKind: "system",
          kind: "system",
          content:
            "Paused: this prompt already caused " +
            String(budget) +
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

  private deferWake(
    agentId: string,
    channelId: string,
    messageId: string,
    conflict: Conflict | null = null,
  ): void {
    const pending = this.pendingWakes.get(agentId) ?? new Map<string, PendingWake>();
    const existing = pending.get(channelId);
    // A regenerate request and a plain wake for the same channel merge into one turn that
    // carries the conflict feedback; the newest message stays the trigger.
    pending.set(channelId, { messageId, conflict: conflict ?? existing?.conflict ?? null });
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
    try {
      await this.startRun(agent, {
        trigger: "channel",
        channelId,
        replyChannelId,
        prompt: (database) =>
          this.buildChannelPrompt(database, agent, channelId, trigger, null, replyChannelId),
        traceId: trigger.traceId,
        triggerMessageId: trigger.id,
      });
    } catch (error) {
      if (error instanceof NothingToDoError) return;
      if (!(error instanceof HttpError && error.statusCode === 409)) throw error;
      this.deferWake(agentId, channelId, trigger.id);
    }
  }

  /** The regenerate block: what beat the agent, what it tried, and what to do now. */
  private conflictPromptBlock(channel: Channel, conflict: Conflict): string[] {
    const lines = [
      "Your previous reply to #" +
        channel.name +
        " was NOT posted: " +
        (conflict.cause === "busy"
          ? "the channel was busy and the wait timed out."
          : "the channel changed while you were working."),
    ];
    if (conflict.winnerName && conflict.winnerContent !== null) {
      lines.push(
        conflict.winnerName +
          " posted " +
          quote(conflict.winnerContent) +
          " (#" +
          channel.name +
          "/" +
          String(conflict.winnerSeq ?? "?") +
          ") before you.",
      );
    }
    lines.push(
      "Your rejected reply was: " + quote(conflict.rejectedContent),
      "Several agents may be acting on the same request at once. Re-plan from the channel's current state: decide what the next useful contribution is given what " +
        (conflict.winnerName ?? "the others") +
        " already did, and do not repeat your rejected reply. If the request is now fully handled, reply exactly " +
        NO_REPLY +
        ". (Conflict " +
        String(conflict.attempt) +
        " of " +
        String(conflict.limit) +
        " for this turn.)",
    );
    return lines;
  }

  /**
   * The wake prompt. Built from the snapshot the run is started in, so what
   * the agent is shown and what it is recorded as having seen cannot drift.
   */
  private buildChannelPrompt(
    database: Readonly<Database>,
    agent: Agent,
    channelId: string,
    trigger: ChannelMessage | undefined,
    conflict: Conflict | null,
    replyChannelId: string | null = null,
  ): string | null {
    const channel = database.channels.find((item) => item.id === channelId);
    if (!channel) return null;
    const lastRun = database.runs
      .filter((run) => run.agentId === agent.id && run.channelId === channelId && run.completedAt)
      .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? ""))[0];
    // Window on seq: everything after what the last run's prompt covered. Runs from before
    // sequence numbers existed fall back to their start time.
    const legacySince = lastRun && lastRun.seenSeq === null ? (lastRun.startedAt ?? "") : null;
    const seenSeq = lastRun?.seenSeq ?? 0;
    const messages = database.messages
      .filter(
        (message) =>
          message.channelId === channelId &&
          message.kind !== "denial" &&
          message.kind !== "conflict" &&
          message.authorId !== agent.id &&
          (legacySince !== null ? message.createdAt > legacySince : message.seq > seenSeq),
      )
      .sort((left, right) => left.seq - right.seq)
      .slice(-CONTEXT_MESSAGES);
    if (messages.length === 0 && !conflict) return null;
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
            String(this.config.traceBudget) +
            " agent runs.",
        );
      }
      if (trigger.authorKind !== "user") {
        chain.push(
          "The latest message is from another agent, not the human. If the original request is already resolved, reply in one short line without @mentioning anyone (or say nothing new). @mention an agent only when you need a reply or an action from it; answers and acknowledgements need no mention — an answer is routed back to whoever asked automatically.",
        );
      }
    }
    const sections: string[] = [];
    if (conflict) sections.push(...this.conflictPromptBlock(channel, conflict), "");
    if (messages.length > 0) {
      sections.push(
        conflict
          ? "Messages in #" + channel.name + " since you last read it:"
          : "New messages in #" + channel.name + " addressed to you:",
        "",
        ...lines,
        "",
      );
    }
    if (chain.length > 0) sections.push(...chain, "");
    const replyChannel = replyChannelId
      ? database.channels.find((item) => item.id === replyChannelId)
      : undefined;
    const destination =
      replyChannel && replyChannel.id !== channel.id
        ? (replyChannel.kind === "dm"
            ? "your DM with " +
              (replyChannel.memberIds.includes(USER_ID) ? this.config.userName : "the requester")
            : "#" + replyChannel.name) + " (where you were originally asked)"
        : "#" + channel.name;
    const offerSilence = conflict !== null || trigger?.authorKind !== "user";
    const groupTask =
      channel.kind !== "dm" &&
      !this.config.turnTaking &&
      (conflict !== null || trigger?.authorKind !== "user" || mentions(trigger?.content ?? "", "everyone", []));
    sections.push(
      (conflict ? "Reply with your regenerated contribution. It" : "Respond to these messages. Your reply") +
        " is posted to " +
        destination +
        " automatically; use the launchpad tools only to act elsewhere or coordinate with other agents." +
        (groupTask
          ? " If this is a shared task that still has steps left, end your reply with @everyone so the others are woken for the next step."
          : "") +
        (offerSilence
          ? " If there is nothing useful to add, reply exactly " + NO_REPLY + " and nothing is posted."
          : ""),
    );
    return sections.join("\n");
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
      prompt: "",
      output: null,
      error: null,
      usage: null,
      events: [],
      seenSeq: null,
      conflicts: options.inheritedConflicts ?? 0,
      conflict: null,
      silent: false,
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
      const prompt = typeof options.prompt === "function" ? options.prompt(database) : options.prompt;
      if (prompt === null) throw new NothingToDoError();
      run.prompt = prompt;
      if (options.channelId) {
        // The prompt covers the channel up to here; that is what the agent has now seen.
        const channel = database.channels.find((item) => item.id === options.channelId);
        if (channel) {
          run.seenSeq = channel.lastSeq;
          this.sync.reads.advance(agent.id, channelKey(channel.id), channel.lastSeq);
        }
      }
      database.runs.push(run);
      for (const grant of database.grants) {
        if (grant.agentId === agent.id && grant.runId === null) grant.runId = run.id;
      }
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
      const rendered: Agent = { ...agentAtStart, policy: this.effectivePolicy(agentAtStart, run.id) };
      await renderCodexHome({
        dir: codexHome,
        config: this.config,
        agent: rendered,
        scriptsDir: runtimeScriptsDirForCodex(this.config),
        integrations: this.integrations?.forAgent(rendered).map((entry) => ({
          name: entry.integration.name,
          kind: entry.integration.kind,
          url: entry.integration.url,
          command: entry.integration.command,
          args: entry.integration.args,
          enabledTools: entry.enabledTools,
        })),
        credentialsFile: (await this.integrations?.credentialsFor(rendered)) ?? null,
      });
      await this.workspaces.writeInstructions(rendered, this.instructionContext(rendered));
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        runId: run.id,
        workspacePath: agentAtStart.workspacePath,
        codexHome,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        sandboxMode: effectiveSandboxMode(this.config, rendered),
        env: { AGENT_TOKEN: token, LAUNCHPAD_URL: this.config.agentApiBaseUrl },
        onEvent: (event) => {
          if (events.length < MAX_EVENTS_PER_RUN) events.push(event);
        },
      });
      const outcome = await this.finishRun(agentAtStart, run, result, events);
      if (outcome.posted) {
        await this.wakeMembers(outcome.posted.channelId, outcome.posted);
      } else if (outcome.conflict && outcome.channelId) {
        this.regenerateAfterConflict(agentAtStart, run, outcome.channelId, outcome.conflict);
      } else if (outcome.silent) {
        await this.passTurn(agentAtStart, run);
      }
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
      this.conflictCounts.delete(run.id);
      if (this.store.peek().grants.some((grant) => grant.runId === run.id)) {
        await this.store.mutate((database) => {
          database.grants = database.grants.filter((grant) => grant.runId !== run.id);
        });
      }
      await this.drainPendingWakes(agentAtStart.id);
    }
  }

  /**
   * Completes the run and posts its reply to the channel that woke it — under
   * the channel lock and the same read-before-act check as the post_message
   * tool, in one mutation with the completion bookkeeping. A stale reply is not
   * posted: the run completes with `conflict` set and the caller queues a
   * regenerate turn. A `[no reply]` posts nothing and wakes nobody.
   */
  private async finishRun(
    agentAtStart: Agent,
    run: AgentRun,
    result: RunnerResult,
    events: RunEvent[],
  ): Promise<{
    posted: ChannelMessage | null;
    conflict: Conflict | null;
    channelId: string | null;
    silent: boolean;
  }> {
    const output = result.output.trim();
    const silent = isNoReply(output);
    // The reply goes where the agent was asked (reply routing), else where it was woken.
    const channelId = run.replyChannelId ?? run.channelId ?? agentAtStart.dmChannelId;
    const channel = channelId
      ? (this.store.peek().channels.find((item) => item.id === channelId) ?? null)
      : null;
    const posting = channel !== null && !silent;
    let lease: Lease | null = null;
    let busy: Conflict | null = null;
    if (posting && channel) {
      try {
        lease = await this.sync.locks.acquire(channelKey(channel.id), "run:" + run.id);
      } catch (error) {
        if (!(error instanceof LockTimeoutError)) throw error;
        busy = this.busyConflict(agentAtStart, channel, output, run.id, error.holder);
      }
    }
    try {
      const outcome = await this.store.mutate((database) => {
        const completedAt = now();
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return { posted: null, conflict: null };
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.silent = silent;
        storedRun.completedAt = completedAt;
        if (agent.status === "busy") agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
        let posted: ChannelMessage | null = null;
        let conflict: Conflict | null = null;
        if (posting && channel) {
          conflict = busy ?? this.staleCheck(database, agent, channel.id, output, run.id);
          if (conflict) {
            storedRun.conflicts += 1;
            storedRun.conflict = conflict;
            events.push(this.conflictEvent(conflict, channel.name));
            this.appendConflictNotice(database, agent, channel.id, conflict, run.id, "auto_post");
          } else {
            posted = this.appendMessage(database, channel.id, {
              authorId: agent.id,
              authorName: agent.name,
              authorKind: agent.kind,
              kind: "message",
              content: output,
              runId: run.id,
              approvalId: null,
              ...this.replyLineage(database, agent, channel, run.id),
            });
            this.sync.reads.advance(agent.id, channelKey(channel.id), posted.seq);
          }
        }
        storedRun.events = events;
        return { posted, conflict };
      });
      if (posting && channel) {
        await this.recordSync(
          agentAtStart,
          run.id,
          "auto_post",
          channel,
          outcome.posted
            ? { ok: true, message: outcome.posted }
            : { ok: false, conflict: outcome.conflict ?? this.busyConflict(agentAtStart, channel, output, run.id, null) },
        );
      }
      return { ...outcome, channelId: channel?.id ?? null, silent };
    } finally {
      lease?.release();
    }
  }

  /**
   * The reply lost a race: owe the agent a regenerate turn carrying the
   * feedback, hung off the message that beat it. Drained right after this run
   * settles (one active run per agent). Past the per-turn limit the notice
   * already says the agent stopped; nothing more is queued.
   */
  private regenerateAfterConflict(
    agent: Agent,
    run: AgentRun,
    channelId: string,
    conflict: Conflict,
  ): void {
    if (conflict.attempt > conflict.limit) return;
    const triggerId = conflict.winnerMessageId ?? run.triggerMessageId;
    if (!triggerId) return;
    this.deferWake(agent.id, channelId, triggerId, conflict);
  }

  private async drainPendingWakes(agentId: string): Promise<void> {
    const pending = this.pendingWakes.get(agentId);
    if (!pending || pending.size === 0) return;
    const [entry] = pending;
    if (!entry) return;
    const [channelId, wake] = entry;
    pending.delete(channelId);
    if (pending.size === 0) this.pendingWakes.delete(agentId);
    const agent = this.getAgent(agentId);
    if (agent.status !== "ready") return;
    const trigger = this.store.peek().messages.find((item) => item.id === wake.messageId);
    try {
      await this.startRun(agent, {
        trigger: wake.conflict ? "conflict" : "channel",
        channelId,
        prompt: (database) =>
          this.buildChannelPrompt(database, agent, channelId, trigger, wake.conflict),
        traceId: trigger?.traceId ?? null,
        triggerMessageId: trigger?.id ?? null,
        inheritedConflicts: wake.conflict?.attempt ?? 0,
      });
    } catch (error) {
      if (error instanceof NothingToDoError) await this.drainPendingWakes(agentId);
    }
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
      turnTaking: this.config.turnTaking,
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
