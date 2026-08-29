import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  /** Host path of the runtime scripts (MCP server + IAM hook). */
  RUNTIME_SCRIPTS_DIR: z.string().optional(),
  /** URL the Codex runtime uses to reach this control plane. */
  AGENT_API_BASE_URL: z.string().url().optional(),
  USER_NAME: z.string().trim().min(1).max(40).default("You"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  /** `ark` (default) or `local-codex`: reuse the login of a Codex CLI installed on this machine. */
  MODEL_PROVIDER: z.enum(["ark", "local-codex"]).default("ark"),
  /** Codex home whose auth.json is reused in local-codex mode. */
  LOCAL_CODEX_HOME: z.string().optional(),
  /** Optional model override in local-codex mode (defaults to the Codex CLI default). */
  CODEX_MODEL: z.string().trim().optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

/** Path the Codex process inside a Runtime container sees the scripts at. */
export const CONTAINER_SCRIPTS_DIR = "/opt/launchpad";

const defaultScriptsDir = fileURLToPath(new URL("../../../runtime", import.meta.url));

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  const engineName = env.CONTAINER_ENGINE.split(/[\\/]/).at(-1)?.toLowerCase() ?? "docker";
  const defaultAgentApiBaseUrl =
    env.RUNTIME_PROVIDER === "container"
      ? "http://" +
        (engineName === "podman" ? "host.containers.internal" : "host.docker.internal") +
        ":" +
        env.PORT
      : "http://127.0.0.1:" + env.PORT;
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    runtimeScriptsDir: path.resolve(env.RUNTIME_SCRIPTS_DIR ?? defaultScriptsDir),
    agentApiBaseUrl: (env.AGENT_API_BASE_URL ?? defaultAgentApiBaseUrl).replace(/\/+$/, ""),
    userName: env.USER_NAME,
    authToken,
    modelProvider: env.MODEL_PROVIDER,
    localCodexHome: path.resolve(env.LOCAL_CODEX_HOME ?? path.join(homedir(), ".codex")),
    codexModel: env.CODEX_MODEL ?? "",
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

/** True when a model can be reached: Ark credentials, or local Codex login reuse. */
export function isModelConfigured(config: AppConfig): boolean {
  return config.modelProvider === "local-codex" || isArkConfigured(config);
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

/** Scripts directory as seen by the Codex process for the configured runtime provider. */
export function runtimeScriptsDirForCodex(config: AppConfig): string {
  return config.runtimeProvider === "container" ? CONTAINER_SCRIPTS_DIR : config.runtimeScriptsDir;
}

/** Per-agent $CODEX_HOME on the host. */
export function agentCodexHome(config: AppConfig, agentId: string): string {
  return path.join(config.codexHome, "agents", agentId);
}
