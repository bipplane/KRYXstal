import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import type {
  AgentRunner,
  RunEvent,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
  events: RunEvent[];
  onEvent?: ((event: RunEvent) => void) | undefined;
}

export function newParsedEvents(
  threadId: string | null,
  onEvent?: ((event: RunEvent) => void) | undefined,
): ParsedEvents {
  return { messages: [], threadId, usage: null, errors: [], events: [], onEvent };
}

export function buildCodexArgs(
  request: Pick<RunnerRequest, "prompt" | "threadId" | "sandboxMode">,
  workspacePath: string,
): string[] {
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--sandbox",
    request.sandboxMode,
    "--skip-git-repo-check",
    "--dangerously-bypass-hook-trust",
    "-C",
    workspacePath,
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

const MAX_DETAIL = 4_000;

function clip(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_DETAIL ? text.slice(0, MAX_DETAIL) + "…" : text;
}

export function itemToRunEvent(item: Record<string, unknown>): RunEvent | null {
  const base = {
    id: typeof item.id === "string" ? item.id : randomUUID(),
    status: typeof item.status === "string" ? item.status : null,
    exitCode: typeof item.exit_code === "number" ? item.exit_code : null,
    createdAt: new Date().toISOString(),
  };
  switch (item.type) {
    case "command_execution": {
      const command = Array.isArray(item.command)
        ? item.command.map(String).join(" ")
        : String(item.command ?? "");
      return {
        ...base,
        type: "command_execution",
        summary: command,
        detail: clip(item.aggregated_output),
      };
    }
    case "mcp_tool_call": {
      return {
        ...base,
        type: "mcp_tool_call",
        summary: String(item.server ?? "mcp") + "." + String(item.tool ?? "?"),
        detail: clip({ arguments: item.arguments, result: item.result, error: item.error }),
      };
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return {
        ...base,
        type: "file_change",
        summary:
          changes
            .map((change) => {
              const record = change as Record<string, unknown>;
              return String(record.kind ?? "edit") + " " + String(record.path ?? "");
            })
            .join(", ") || "file change",
        detail: null,
      };
    }
    case "web_search":
      return { ...base, type: "web_search", summary: String(item.query ?? "web search"), detail: null };
    case "reasoning":
      return { ...base, type: "reasoning", summary: clip(item.text) ?? "", detail: null };
    default:
      return null;
  }
}

export function parseCodexEventLine(line: string, parsed: ParsedEvents): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    } else {
      const runEvent = itemToRunEvent(item);
      if (runEvent) {
        parsed.events.push(runEvent);
        parsed.onEvent?.(runEvent);
      }
    }
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }

  if (event.type === "turn.failed" && event.error && typeof event.error === "object") {
    const detail = (event.error as Record<string, unknown>).message;
    if (typeof detail === "string") parsed.errors.push(detail);
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(message);
  }
}

/** Environment variables safe to inherit from the control plane into a Codex process. */
export const INHERITED_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "TERM",
  "XDG_RUNTIME_DIR",
] as const;

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(this.config.codexHome, {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    const args = buildCodexArgs(request, request.workspacePath);
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(request.codexHome, request.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(request.agentId, active);

    const parsed = newParsedEvents(request.threadId, request.onEvent);
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          parseCodexEventLine(line, parsed);
        }
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        parseCodexEventLine(stdout.trim(), parsed);
      }
      if (active.cancelled) {
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        throw new Error("Codex timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new Error("Codex exited with code " + exitCode + ": " + detail);
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new Error("Codex completed without an agent message");
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
      };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(
    codexHome: string,
    extra: Record<string, string>,
  ): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: codexHome,
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
      ...extra,
    };
    for (const name of INHERITED_ENV) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
