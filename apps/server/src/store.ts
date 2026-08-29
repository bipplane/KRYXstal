import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PRESETS } from "./policy.js";
import type { Agent, ChannelMessage, Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 2,
  agents: [],
  integrations: [],
  grants: [],
  channels: [],
  messages: [],
  runs: [],
  decisions: [],
  approvals: [],
});

interface LegacyAgent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: string;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LegacyMessage {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface LegacyRun {
  id: string;
  agentId: string;
  status: string;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: Database["runs"][number]["usage"];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Legacy DM channel id used until AgentService creates real DM channels on init. */
export const legacyDmChannelId = (agentId: string): string => "legacy-dm:" + agentId;

export function migrateV1(raw: {
  agents: LegacyAgent[];
  messages: LegacyMessage[];
  runs: LegacyRun[];
}): Database {
  const database = emptyDatabase();
  const names = new Map(raw.agents.map((agent) => [agent.id, agent.name]));
  database.agents = raw.agents.map(
    (agent): Agent => ({
      id: agent.id,
      kind: "principal",
      ownIntegrationIds: [],
      name: agent.name,
      description: agent.description,
      instructions: agent.instructions,
      status: agent.status === "busy" ? "ready" : (agent.status as Agent["status"]),
      principalId: agent.id,
      parentAgentId: null,
      policy: structuredClone(PRESETS.worker),
      dmChannelId: null,
      workspacePath: agent.workspacePath,
      codexThreadId: agent.codexThreadId,
      lastError: agent.lastError,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      expiresAt: null,
    }),
  );
  database.messages = raw.messages.map(
    (message): ChannelMessage => ({
      id: message.id,
      channelId: legacyDmChannelId(message.agentId),
      authorId: message.role === "user" ? "user" : message.agentId,
      authorName: message.role === "user" ? "You" : (names.get(message.agentId) ?? "agent"),
      authorKind: message.role === "user" ? "user" : "principal",
      kind: "message",
      content: message.content,
      runId: message.runId,
      approvalId: null,
      traceId: message.id,
      parentMessageId: null,
      createdAt: message.createdAt,
    }),
  );
  database.runs = raw.runs.map((run) => ({
    id: run.id,
    agentId: run.agentId,
    status: run.status as Database["runs"][number]["status"],
    trigger: "user",
    channelId: null,
    replyChannelId: null,
    traceId: null,
    triggerMessageId: null,
    prompt: run.prompt,
    output: run.output,
    error: run.error,
    usage: run.usage,
    events: [],
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
  }));
  return database;
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown; agents?: unknown };
      if (!Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      if (parsed.version === 1) {
        this.data = migrateV1(parsed as Parameters<typeof migrateV1>[0]);
        await this.persist();
      } else if (parsed.version === 2) {
        this.data = { ...emptyDatabase(), ...(parsed as Database) };
      } else {
        throw new Error("Unsupported database format");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  /** Read-only view without cloning; do not mutate the result. */
  peek(): Readonly<Database> {
    return this.data;
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
