import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { ACTIONS } from "./types.js";
import type { AgentService } from "./agent-service.js";
import type { RunIdentity } from "./types.js";

const idParams = z.object({ id: z.string().uuid() });
const nameParams = z.object({ name: z.string().trim().min(1).max(80) });
const statementSchema = z.object({
  effect: z.enum(["allow", "deny"]),
  actions: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
  resources: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
});
const policySchema = z.object({
  preset: z.enum(["reader", "worker", "deployer", "admin", "custom"]),
  statements: z.array(statementSchema).max(100),
  delegable: z.array(z.string().trim().min(1).max(80)).max(50),
});
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
  policy: policySchema.optional(),
  channelIds: z.array(z.string().uuid()).max(50).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const createChannelBody = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).optional(),
  memberIds: z.array(z.string()).max(100).optional(),
});
const approvalBody = z.object({ decision: z.enum(["approve", "deny"]) });
const messagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  after: z.string().optional(),
});
const evaluateBody = z.object({
  tool_name: z.string().max(200),
  tool_input: z.unknown().optional(),
});
const agentCreateChannelBody = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).optional(),
  members: z.array(z.string().max(80)).max(50).optional(),
});
const spawnBody = z.object({
  name: z.string().trim().min(1).max(40),
  instructions: z.string().trim().min(1).max(10_000),
  actions: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  channels: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  task: z.string().max(50_000).optional(),
});
const closeBody = z.object({ agentId: z.string().uuid() });
const requestPrincipalBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().trim().min(1).max(10_000),
  preset: z.enum(["reader", "worker", "deployer", "admin"]),
  channels: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
});

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  const identities = new WeakMap<FastifyRequest, RunIdentity>();
  const identityOf = (request: FastifyRequest): RunIdentity => {
    const identity = identities.get(request);
    if (!identity) throw new HttpError(401, "Agent identity required");
    return identity;
  };

  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? request.url;
    if (!url.startsWith("/api/")) return;
    if (url.startsWith("/api/agent/") || url.startsWith("/api/iam/")) {
      const identity = service.resolveToken(bearer(request));
      if (!identity) return reply.code(401).send({ error: "Invalid or expired agent token" });
      identities.set(request, identity);
      return;
    }
    if (!config.authToken || url === "/api/health" || url === "/api/auth") return;
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(bearer(request));
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  // ------------------------------------------------------------- user API

  app.get("/api/health", async () => ({ ok: true, service: "volc-agent-launchpad" }));
  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));
  app.get("/api/system", async () => service.systemInfo());
  app.get("/api/overview", async () => service.overview());
  app.get("/api/policy/presets", async () => {
    const { presets } = service.policyPresets();
    return { presets, actions: ["*", ...ACTIONS] };
  });

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = idParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = idParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = idParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.get("/api/agents/:id/decisions", async (request) => {
    const { id } = idParams.parse(request.params);
    return { decisions: service.getDecisions(id) };
  });

  /** Legacy playground endpoint: posts to the Agent's DM channel. */
  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = messageBody.parse(request.body);
    return reply.code(202).send(await service.sendMessage(id, body.content));
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  app.get("/api/channels", async () => ({ channels: service.listChannels() }));

  app.post("/api/channels", async (request, reply) => {
    const body = createChannelBody.parse(request.body);
    return reply.code(201).send({ channel: await service.createChannel(body) });
  });

  app.get("/api/channels/:id/messages", async (request) => {
    const { id } = idParams.parse(request.params);
    const query = messagesQuery.parse(request.query);
    return { messages: service.getMessages(id, query.limit, query.after) };
  });

  app.post("/api/channels/:id/messages", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = messageBody.parse(request.body);
    return reply.code(201).send({ message: await service.postUserMessage(id, body.content) });
  });

  app.get("/api/decisions", async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return { decisions: service.getDecisions(undefined, query.limit) };
  });

  app.get("/api/traces/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    return service.getTrace(id);
  });

  app.post("/api/approvals/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = approvalBody.parse(request.body);
    return { approval: await service.resolveApproval(id, body.decision) };
  });

  // ------------------------------------------------------ agent identity API

  app.post("/api/iam/evaluate", async (request) => {
    const identity = identityOf(request);
    const body = evaluateBody.parse(request.body);
    return service.evaluateToolCall(identity, body.tool_name, body.tool_input);
  });

  app.get("/api/agent/me", async (request) => {
    const identity = identityOf(request);
    return { agent: service.getAgent(identity.agentId), runId: identity.runId };
  });

  app.get("/api/agent/channels", async (request) => {
    const identity = identityOf(request);
    return { channels: service.agentChannels(identity) };
  });

  app.get("/api/agent/channels/:name/messages", async (request) => {
    const identity = identityOf(request);
    const { name } = nameParams.parse(request.params);
    const query = messagesQuery.parse(request.query);
    return { messages: await service.agentReadChannel(identity, name, query.limit) };
  });

  app.post("/api/agent/channels/:name/messages", async (request, reply) => {
    const identity = identityOf(request);
    const { name } = nameParams.parse(request.params);
    const body = messageBody.parse(request.body);
    return reply
      .code(201)
      .send({ message: await service.agentPostMessage(identity, name, body.content) });
  });

  app.post("/api/agent/channels", async (request, reply) => {
    const identity = identityOf(request);
    const body = agentCreateChannelBody.parse(request.body);
    return reply.code(201).send({ channel: await service.agentCreateChannel(identity, body) });
  });

  app.post("/api/agent/spawn", async (request, reply) => {
    const identity = identityOf(request);
    const body = spawnBody.parse(request.body);
    const session = await service.agentSpawn(identity, body);
    return reply.code(201).send({
      session: {
        id: session.id,
        name: session.name,
        dmChannelId: session.dmChannelId,
        policy: session.policy,
      },
      note: "Message the session in its DM channel or @mention it; it is woken automatically.",
    });
  });

  app.post("/api/agent/close", async (request) => {
    const identity = identityOf(request);
    const body = closeBody.parse(request.body);
    const closed = await service.agentClose(identity, body.agentId);
    return { agent: { id: closed.id, name: closed.name, status: closed.status } };
  });

  app.post("/api/agent/requests", async (request, reply) => {
    const identity = identityOf(request);
    const body = requestPrincipalBody.parse(request.body);
    const approval = await service.agentRequestPrincipal(identity, body);
    return reply.code(201).send({
      approval: { id: approval.id, status: approval.status },
      note: "Posted to #approvals. The human decides; you will be notified in your DM channel.",
    });
  });

  // -------------------------------------------------------------- static UI

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
      ...(error instanceof HttpError && error.details ? error.details : {}),
    });
  });

  return app;
}
