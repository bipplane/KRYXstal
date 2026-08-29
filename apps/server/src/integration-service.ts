import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { agentCodexHome, type AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { discoverHttpTools, discoverStdioTools } from "./mcp-client.js";
import { evaluate, mayEverPrefix } from "./policy.js";
import { INHERITED_ENV } from "./codex-runner.js";
import type { JsonStore } from "./store.js";
import type {
  Agent,
  Integration,
  IntegrationInput,
  IntegrationLogin,
  IntegrationTool,
} from "./types.js";

const now = () => new Date().toISOString();
const SLUG = /^[a-z][a-z0-9-]{0,39}$/;
const LOGIN_URL_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
export const CREDENTIALS_FILE = ".credentials.json";

/** What the Codex config renderer needs per integration for one agent. */
export interface RenderedIntegration {
  integration: Integration;
  /** null = no restriction known (tools not discovered); the hook still enforces. */
  enabledTools: string[] | null;
}

interface ActiveLogin {
  key: string;
  child: ChildProcess;
  started: number;
}

/**
 * External MCP servers: registration, OAuth login through `codex mcp login`,
 * tool discovery, and the per-agent view (which servers/tools a policy allows).
 *
 * Shared login state lives in `<codexHome>/oauth/.credentials.json`; a per-agent
 * login writes the same file into that agent's own $CODEX_HOME instead.
 */
export class IntegrationService {
  private readonly logins = new Map<string, ActiveLogin>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
  ) {}

  get oauthHome(): string {
    return path.join(this.config.codexHome, "oauth");
  }

  sharedCredentialsFile(): string {
    return path.join(this.oauthHome, CREDENTIALS_FILE);
  }

  async initialize(): Promise<void> {
    await mkdir(this.oauthHome, { recursive: true });
    await this.store.mutate((database) => {
      database.integrations ??= [];
      for (const integration of database.integrations) {
        if (integration.status === "connecting") {
          integration.status = "unconnected";
          integration.lastError = "Login interrupted by a server restart";
        }
      }
    });
  }

  list(): Integration[] {
    return structuredClone(this.store.peek().integrations);
  }

  get(id: string): Integration {
    const integration = this.store.peek().integrations.find((item) => item.id === id);
    if (!integration) throw new HttpError(404, "Integration not found");
    return structuredClone(integration);
  }

  byName(name: string): Integration | undefined {
    return this.store.peek().integrations.find((item) => item.name === name);
  }

  async create(input: IntegrationInput): Promise<Integration> {
    const name = input.name.trim().toLowerCase();
    if (!SLUG.test(name)) {
      throw new HttpError(400, "Name must be a slug: lowercase letters, digits and dashes");
    }
    if (name === "launchpad") throw new HttpError(400, "That name is reserved");
    const auth = input.kind === "stdio" ? "none" : (input.auth ?? "oauth");
    if (input.kind === "http" && !input.url) throw new HttpError(400, "URL is required");
    if (input.kind === "stdio" && !input.command) throw new HttpError(400, "Command is required");
    const integration: Integration = {
      id: randomUUID(),
      name,
      kind: input.kind,
      url: input.kind === "http" ? (input.url?.trim() ?? null) : null,
      command: input.kind === "stdio" ? (input.command?.trim() ?? null) : null,
      args: input.args ?? [],
      auth,
      status: "unconnected",
      tools: [],
      lastError: null,
      connectedAt: null,
      createdAt: now(),
    };
    await this.store.mutate((database) => {
      if (database.integrations.some((item) => item.name === name)) {
        throw new HttpError(409, "An integration named " + name + " already exists");
      }
      database.integrations.push(integration);
    });
    if (auth === "none") {
      // No login needed: try discovery right away so the wizard can show tools.
      await this.discover(integration.id).catch(() => undefined);
      return this.get(integration.id);
    }
    return integration;
  }

  async remove(id: string): Promise<void> {
    this.get(id);
    this.abortLogin(id);
    await this.store.mutate((database) => {
      database.integrations = database.integrations.filter((item) => item.id !== id);
      for (const agent of database.agents) {
        agent.ownIntegrationIds = agent.ownIntegrationIds.filter((item) => item !== id);
      }
    });
  }

  // ------------------------------------------------------------------ login

  /** Starts `codex mcp login`; resolves with the authorize URL once Codex prints it. */
  async startLogin(id: string, agent: Agent | null): Promise<IntegrationLogin> {
    const integration = this.get(id);
    if (integration.auth !== "oauth") throw new HttpError(400, "This integration does not use OAuth");
    const key = agent ? id + ":" + agent.id : id;
    // Retrying the same login replaces the stale attempt (it may be waiting on a callback that never came).
    const stale = this.logins.get(key);
    if (stale) {
      stale.child.kill("SIGTERM");
      this.logins.delete(key);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if ([...this.logins.values()].some((login) => Date.now() - login.started < LOGIN_TIMEOUT_MS)) {
      throw new HttpError(409, "Another login is in progress; finish it first (one callback port)");
    }
    const home = agent ? agentCodexHome(this.config, agent.id) : this.oauthHome;
    await mkdir(home, { recursive: true });
    const child = spawn(
      this.config.codexBin,
      [...this.overrides(integration), "mcp", "login", integration.name],
      { env: this.env(home), stdio: ["ignore", "pipe", "pipe"] },
    );
    const active: ActiveLogin = { key, child, started: Date.now() };
    this.logins.set(key, active);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

    if (!agent) await this.patch(id, { status: "connecting", lastError: null });
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex did not print an authorize URL")), LOGIN_URL_TIMEOUT_MS);
      const check = () => {
        const match = /https?:\/\/\S+/.exec(stdout);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      };
      child.stdout?.on("data", check);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          const match = /https?:\/\/\S+/.exec(stdout);
          resolve(match?.[0] ?? "");
        } else {
          reject(new Error((stderr || stdout).trim() || "codex mcp login exited with code " + code));
        }
      });
      check();
    }).catch(async (error: Error) => {
      this.logins.delete(key);
      child.kill("SIGTERM");
      if (!agent) await this.patch(id, { status: "error", lastError: error.message });
      throw new HttpError(502, error.message);
    });

    const killTimer = setTimeout(() => child.kill("SIGTERM"), LOGIN_TIMEOUT_MS);
    killTimer.unref();
    child.once("exit", (code) => {
      clearTimeout(killTimer);
      this.logins.delete(key);
      void this.finishLogin(id, agent, code === 0, (stderr || stdout).trim());
    });
    return { integrationId: id, agentId: agent?.id ?? null, url };
  }

  private async finishLogin(
    id: string,
    agent: Agent | null,
    ok: boolean,
    detail: string,
  ): Promise<void> {
    if (agent) {
      if (!ok) return;
      await this.store.mutate((database) => {
        const stored = database.agents.find((item) => item.id === agent.id);
        if (stored && !stored.ownIntegrationIds.includes(id)) stored.ownIntegrationIds.push(id);
      });
      return;
    }
    if (!ok) {
      await this.patch(id, { status: "error", lastError: detail || "Login failed" });
      return;
    }
    await this.patch(id, { status: "connected", connectedAt: now(), lastError: null });
    await this.discover(id).catch(() => undefined);
  }

  private abortLogin(id: string): void {
    for (const [key, login] of this.logins) {
      if (key === id || key.startsWith(id + ":")) {
        login.child.kill("SIGTERM");
        this.logins.delete(key);
      }
    }
  }

  async logout(id: string, agent: Agent | null): Promise<Integration> {
    const integration = this.get(id);
    this.abortLogin(agent ? id + ":" + agent.id : id);
    const home = agent ? agentCodexHome(this.config, agent.id) : this.oauthHome;
    await new Promise<void>((resolve) => {
      const child = spawn(
        this.config.codexBin,
        [...this.overrides(integration), "mcp", "logout", integration.name],
        { env: this.env(home), stdio: "ignore" },
      );
      const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", () => resolve());
    });
    if (agent) {
      await this.store.mutate((database) => {
        const stored = database.agents.find((item) => item.id === agent.id);
        if (stored) stored.ownIntegrationIds = stored.ownIntegrationIds.filter((item) => item !== id);
      });
      return this.get(id);
    }
    return this.patch(id, { status: "unconnected", connectedAt: null, lastError: null, tools: [] });
  }

  // -------------------------------------------------------------- discovery

  async discover(id: string): Promise<Integration> {
    const integration = this.get(id);
    try {
      let tools: IntegrationTool[];
      if (integration.kind === "http") {
        const token =
          integration.auth === "oauth"
            ? await this.readAccessToken(this.sharedCredentialsFile(), integration)
            : null;
        if (integration.auth === "oauth" && !token) {
          throw new Error("No stored OAuth token; connect first");
        }
        tools = await discoverHttpTools(integration.url ?? "", token);
      } else {
        tools = await discoverStdioTools(integration.command ?? "", integration.args, {});
      }
      const status = integration.auth === "none" ? "connected" : integration.status;
      return await this.patch(id, {
        tools,
        status,
        lastError: null,
        ...(integration.auth === "none" && !integration.connectedAt ? { connectedAt: now() } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.patch(id, { lastError: "Tool discovery failed: " + message });
      throw new HttpError(502, "Tool discovery failed: " + message);
    }
  }

  /** Tolerant reader for Codex's `.credentials.json`: finds an access token for this server. */
  async readAccessToken(file: string, integration: Integration): Promise<string | null> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const candidates: Array<{ token: string; context: string }> = [];
    const walk = (value: unknown, context: string) => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, context + "[" + index + "]"));
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (typeof record.access_token === "string") {
        candidates.push({ token: record.access_token, context: context + " " + JSON.stringify(record.url ?? "") });
      }
      for (const [key, child] of Object.entries(record)) walk(child, context + "/" + key);
    };
    walk(parsed, "");
    const preferred = candidates.find(
      (candidate) =>
        (integration.url && candidate.context.includes(integration.url)) ||
        candidate.context.includes(integration.name),
    );
    return preferred?.token ?? candidates[0]?.token ?? null;
  }

  // ------------------------------------------------------------ per-agent view

  /** Integrations this agent's policy could ever use, with the tool allowlist for Codex. */
  forAgent(agent: Agent): RenderedIntegration[] {
    return this.list()
      .filter((integration) => integration.status === "connected")
      .filter((integration) => mayEverPrefix(agent.policy, "mcp:" + integration.name + ":"))
      .map((integration) => ({
        integration,
        enabledTools:
          integration.tools.length === 0
            ? null
            : integration.tools
                .filter(
                  (tool) =>
                    evaluate(agent.policy, "mcp:" + integration.name + ":" + tool.name, "*").effect ===
                    "allow",
                )
                .map((tool) => tool.name),
      }))
      .filter((entry) => entry.enabledTools === null || entry.enabledTools.length > 0);
  }

  /** Credentials file to place in the agent's $CODEX_HOME, or null when it keeps its own. */
  async credentialsFor(agent: Agent): Promise<string | null> {
    if (agent.ownIntegrationIds.length > 0) return null;
    try {
      await access(this.sharedCredentialsFile());
      return this.sharedCredentialsFile();
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------------- helpers

  private overrides(integration: Integration): string[] {
    const flags = [
      "-c",
      'mcp_oauth_credentials_store="file"',
      "-c",
      "mcp_oauth_callback_port=" + this.config.oauthCallbackPort,
    ];
    if (integration.kind === "http") {
      flags.push("-c", "mcp_servers." + integration.name + ".url=" + JSON.stringify(integration.url));
    } else {
      flags.push("-c", "mcp_servers." + integration.name + ".command=" + JSON.stringify(integration.command));
      flags.push("-c", "mcp_servers." + integration.name + ".args=" + JSON.stringify(integration.args));
    }
    return flags;
  }

  private env(home: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { CODEX_HOME: home, NO_COLOR: "1" };
    for (const name of INHERITED_ENV) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }

  private async patch(id: string, changes: Partial<Integration>): Promise<Integration> {
    return this.store.mutate((database) => {
      const integration = database.integrations.find((item) => item.id === id);
      if (!integration) throw new HttpError(404, "Integration not found");
      Object.assign(integration, changes);
      return structuredClone(integration);
    });
  }
}
