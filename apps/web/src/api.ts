import type {
  ApprovalDecision,
  Agent,
  AgentInput,
  AgentRun,
  ApprovalRequest,
  Channel,
  ChannelMessage,
  Decision,
  Integration,
  IntegrationInput,
  IntegrationLogin,
  Overview,
  PolicyPresets,
  SystemInfo,
  Trace,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let authToken = "";
let unauthorizedHandler: (() => void) | null = null;

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

/** Called whenever any request comes back 401. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...((options.headers as Record<string, string> | undefined) ?? {}),
  };
  let response: Response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : "Network error", 0);
  }
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    if (response.status === 401 && unauthorizedHandler) {
      unauthorizedHandler();
    }
    throw new ApiError(data.error ?? "Request failed (" + response.status + ")", response.status);
  }
  return data;
}

function json(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  overview: () => request<Overview>("/api/overview"),
  policyPresets: () => request<PolicyPresets>("/api/policy/presets"),

  createAgent: (body: AgentInput) => request<{ agent: Agent }>("/api/agents", json("POST", body)),
  updateAgent: (id: string, body: Partial<AgentInput>) =>
    request<{ agent: Agent }>("/api/agents/" + encodeURIComponent(id), json("PATCH", body)),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + encodeURIComponent(id), {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + encodeURIComponent(id) + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + encodeURIComponent(id) + "/stop", {
      method: "POST",
    }),
  runs: (id: string) => request<{ runs: AgentRun[] }>("/api/agents/" + encodeURIComponent(id) + "/runs"),
  agentDecisions: (id: string) =>
    request<{ decisions: Decision[] }>("/api/agents/" + encodeURIComponent(id) + "/decisions"),

  messages: (channelId: string, limit = 200) =>
    request<{ messages: ChannelMessage[] }>(
      "/api/channels/" + encodeURIComponent(channelId) + "/messages?limit=" + String(limit),
    ),
  sendMessage: (channelId: string, content: string) =>
    request<{ message: ChannelMessage }>(
      "/api/channels/" + encodeURIComponent(channelId) + "/messages",
      json("POST", { content }),
    ),
  createChannel: (body: { name: string; description: string; memberIds: string[] }) =>
    request<{ channel: Channel }>("/api/channels", json("POST", body)),

  resolveApproval: (id: string, decision: ApprovalDecision) =>
    request<{ approval: ApprovalRequest }>(
      "/api/approvals/" + encodeURIComponent(id),
      json("POST", { decision }),
    ),
  decisions: (limit = 100) =>
    request<{ decisions: Decision[] }>("/api/decisions?limit=" + String(limit)),

  /** Everything caused by one root message; `messageId` may be any message in the chain. */
  trace: (messageId: string) => request<Trace>("/api/traces/" + encodeURIComponent(messageId)),

  // ---------- integrations (external MCP servers) ----------

  integrations: () => request<{ integrations: Integration[] }>("/api/integrations"),
  createIntegration: (body: IntegrationInput) =>
    request<{ integration: Integration }>("/api/integrations", json("POST", body)),
  deleteIntegration: (id: string) =>
    request<{ ok: true }>("/api/integrations/" + encodeURIComponent(id), { method: "DELETE" }),
  /** Starts the shared OAuth login; open `url` in a new tab, then poll the overview for `status`. */
  integrationLogin: (id: string) =>
    request<IntegrationLogin>("/api/integrations/" + encodeURIComponent(id) + "/login", { method: "POST" }),
  integrationLogout: (id: string) =>
    request<{ integration: Integration }>("/api/integrations/" + encodeURIComponent(id) + "/logout", {
      method: "POST",
    }),
  /** Re-runs tool discovery (tools/list) against the server. */
  discoverIntegration: (id: string) =>
    request<{ integration: Integration }>("/api/integrations/" + encodeURIComponent(id) + "/discover", {
      method: "POST",
    }),
  /** Per-agent login: the agent gets its own identity at the provider instead of the shared one. */
  agentIntegrationLogin: (agentId: string, integrationId: string) =>
    request<IntegrationLogin>(
      "/api/agents/" + encodeURIComponent(agentId) + "/integrations/" + encodeURIComponent(integrationId) + "/login",
      { method: "POST" },
    ),
  agentIntegrationLogout: (agentId: string, integrationId: string) =>
    request<{ agent: Agent }>(
      "/api/agents/" + encodeURIComponent(agentId) + "/integrations/" + encodeURIComponent(integrationId) + "/logout",
      { method: "POST" },
    ),
};
