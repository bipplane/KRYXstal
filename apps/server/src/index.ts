import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

// Load the repo-root .env (and a cwd .env) without overriding real environment variables.
for (const candidate of [
  fileURLToPath(new URL("../../../.env", import.meta.url)),
  path.resolve(".env"),
]) {
  try {
    process.loadEnvFile(candidate);
  } catch {
    // Missing file: nothing to load.
  }
}

const config = loadConfig();

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

const app = await createApp(config, service);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
app.log.info(
  { agentApiBaseUrl: config.agentApiBaseUrl, scripts: config.runtimeScriptsDir },
  "Agent identity API ready",
);
