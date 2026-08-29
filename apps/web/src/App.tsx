import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError, setAuthToken, setUnauthorizedHandler } from "./api";
import AgentWizard from "./components/AgentWizard";
import ChannelDialog from "./components/ChannelDialog";
import ChannelView from "./components/ChannelView";
import Inspector, { type RunFocus } from "./components/Inspector";
import IntegrationsPanel from "./components/IntegrationsPanel";
import Sidebar from "./components/Sidebar";
import TraceView from "./components/TraceView";
import { Spinner } from "./components/ui";
import type {
  ApprovalDecision, Agent, AgentInput, Channel, Overview, PolicyPresets, SystemInfo } from "./types";

const TOKEN_KEY = "launchpad-token";
const OVERVIEW_POLL_MS = 2000;

type AuthState = "checking" | "locked" | "open";

type WizardState = { mode: "create" } | { mode: "edit"; agent: Agent };

function readStoredToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeToken(token: string): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // localStorage may be unavailable; the token still lives in memory for this session.
  }
}

function pickDefaultChannel(channels: Channel[]): string | null {
  const visible = channels.filter((c) => c.kind !== "dm" && !c.archivedAt);
  const general = visible.find((c) => c.name === "general" && c.kind !== "system");
  return (general ?? visible.find((c) => c.kind === "public") ?? visible[0])?.id ?? null;
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [authRequired, setAuthRequired] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [presets, setPresets] = useState<PolicyPresets | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [runFocus, setRunFocus] = useState<RunFocus | null>(null);
  const [traceMessageId, setTraceMessageId] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WizardState | null>(null);
  const [channelDialog, setChannelDialog] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const pickedDefault = useRef(false);
  const missingChannelPolls = useRef(0);
  const missingAgentPolls = useRef(0);

  // ---------- auth gate ----------

  const lock = useCallback((notice: string | null) => {
    setAuthToken("");
    storeToken("");
    setAuthNotice(notice);
    setAuth("locked");
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => lock("That token was rejected. Enter a valid token to continue."));
    return () => setUnauthorizedHandler(null);
  }, [lock]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { required } = await api.auth();
        if (cancelled) return;
        setAuthRequired(required);
        if (!required) {
          setAuth("open");
          return;
        }
        const stored = readStoredToken();
        if (stored) {
          setAuthToken(stored);
          setAuth("open");
        } else {
          setAuth("locked");
        }
      } catch (err) {
        if (cancelled) return;
        setBootError(err instanceof Error ? err.message : "Could not reach the server");
        setAuth("locked");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------- data loading ----------

  const refreshOverview = useCallback(async () => {
    try {
      const next = await api.overview();
      setOverview(next);
      setOverviewError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setOverviewError(err instanceof Error ? err.message : "Failed to load overview");
    }
  }, []);

  useEffect(() => {
    if (auth !== "open") return;
    let cancelled = false;
    setBootError(null);
    void api
      .system()
      .then((info) => {
        if (!cancelled) setSystem(info);
      })
      .catch(() => undefined);
    void api
      .policyPresets()
      .then((p) => {
        if (!cancelled) setPresets(p);
      })
      .catch(() => undefined);
    void refreshOverview();
    const timer = window.setInterval(() => void refreshOverview(), OVERVIEW_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [auth, refreshOverview]);

  // Pick a default channel the first time the overview lands; drop selections that have
  // gone missing for two consecutive polls (one miss can be an in-flight poll racing a create).
  useEffect(() => {
    if (!overview) return;
    if (!pickedDefault.current) {
      pickedDefault.current = true;
      setSelectedChannelId((current) => current ?? pickDefaultChannel(overview.channels));
      return;
    }
    setSelectedChannelId((current) => {
      if (!current || overview.channels.some((c) => c.id === current)) {
        missingChannelPolls.current = 0;
        return current ?? pickDefaultChannel(overview.channels);
      }
      missingChannelPolls.current += 1;
      if (missingChannelPolls.current < 2) return current;
      missingChannelPolls.current = 0;
      return pickDefaultChannel(overview.channels);
    });
    setSelectedAgentId((current) => {
      if (!current || overview.agents.some((a) => a.id === current)) {
        missingAgentPolls.current = 0;
        return current;
      }
      missingAgentPolls.current += 1;
      if (missingAgentPolls.current < 2) return current;
      missingAgentPolls.current = 0;
      return null;
    });
  }, [overview]);

  const selectedChannel = useMemo(
    () => overview?.channels.find((c) => c.id === selectedChannelId) ?? null,
    [overview, selectedChannelId],
  );
  const selectedAgent = useMemo(
    () => overview?.agents.find((a) => a.id === selectedAgentId) ?? null,
    [overview, selectedAgentId],
  );

  // ---------- handlers ----------

  const selectAgentAndDm = useCallback((agent: Agent) => {
    setSelectedAgentId(agent.id);
    if (agent.dmChannelId) {
      setTraceMessageId(null);
      setSelectedChannelId(agent.dmChannelId);
    }
  }, []);

  const selectAgentById = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
  }, []);

  const openRun = useCallback((agentId: string, runId: string) => {
    setSelectedAgentId(agentId);
    setRunFocus({ agentId, runId, nonce: Date.now() });
  }, []);

  const openTrace = useCallback((messageId: string) => {
    setTraceMessageId(messageId);
  }, []);

  /** Leave the trace, landing on the channel the root prompt was posted in (when known). */
  const closeTrace = useCallback((channelId: string | null) => {
    setTraceMessageId(null);
    if (channelId) setSelectedChannelId(channelId);
  }, []);

  // Picking a channel from the sidebar or inspector leaves the trace view.
  const selectChannel = useCallback((channelId: string) => {
    setTraceMessageId(null);
    setSelectedChannelId(channelId);
  }, []);

  const startAgent = useCallback(
    async (agent: Agent) => {
      await api.startAgent(agent.id);
      await refreshOverview();
    },
    [refreshOverview],
  );

  const stopAgent = useCallback(
    async (agent: Agent) => {
      await api.stopAgent(agent.id);
      await refreshOverview();
    },
    [refreshOverview],
  );

  const deleteAgent = useCallback(
    async (agent: Agent) => {
      await api.deleteAgent(agent.id);
      setSelectedAgentId((current) => (current === agent.id ? null : current));
      setSelectedChannelId((current) => (current && current === agent.dmChannelId ? null : current));
      await refreshOverview();
    },
    [refreshOverview],
  );

  const submitWizard = useCallback(
    async (input: AgentInput) => {
      if (wizard?.mode === "edit") {
        await api.updateAgent(wizard.agent.id, input);
        setSelectedAgentId(wizard.agent.id);
      } else {
        const { agent } = await api.createAgent(input);
        setSelectedAgentId(agent.id);
      }
      setWizard(null);
      await refreshOverview();
    },
    [wizard, refreshOverview],
  );

  const submitChannel = useCallback(
    async (input: { name: string; description: string; memberIds: string[] }) => {
      const { channel } = await api.createChannel(input);
      setChannelDialog(false);
      setSelectedChannelId(channel.id);
      await refreshOverview();
    },
    [refreshOverview],
  );

  const resolveApproval = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      await api.resolveApproval(approvalId, decision);
      await refreshOverview();
    },
    [refreshOverview],
  );

  // ---------- render ----------

  if (auth === "checking") {
    return (
      <div className="auth-screen">
        <Spinner label="Connecting…" />
      </div>
    );
  }

  if (auth === "locked") {
    return (
      <UnlockScreen
        notice={bootError ?? authNotice}
        required={authRequired}
        onUnlock={(token) => {
          setAuthToken(token);
          storeToken(token);
          setAuthNotice(null);
          setBootError(null);
          setAuth("open");
        }}
        onRetry={() => window.location.reload()}
      />
    );
  }

  const nonDmChannels = (overview?.channels ?? []).filter((c) => c.kind !== "dm" && !c.archivedAt);

  return (
    <div className="app">
      {overviewError ? (
        <div className="banner banner-error">
          {overviewError}
          <button type="button" className="link-btn" onClick={() => void refreshOverview()}>
            retry
          </button>
        </div>
      ) : null}
      <div className="layout">
        <Sidebar
          system={system}
          overview={overview}
          selectedChannelId={selectedChannelId}
          selectedAgentId={selectedAgentId}
          onSelectChannel={selectChannel}
          onSelectAgent={selectAgentAndDm}
          onNewAgent={() => setWizard({ mode: "create" })}
          onNewChannel={() => setChannelDialog(true)}
          onOpenIntegrations={() => setIntegrationsOpen(true)}
        />
        {traceMessageId ? (
          <TraceView
            key={traceMessageId}
            messageId={traceMessageId}
            overview={overview}
            onBack={closeTrace}
            onSelectAgent={selectAgentById}
            onOpenRun={openRun}
          />
        ) : (
          <ChannelView
            channel={selectedChannel}
            overview={overview}
            onSelectAgent={selectAgentById}
            onOpenRun={openRun}
            onOpenTrace={openTrace}
            onResolveApproval={resolveApproval}
          />
        )}
        <Inspector
          agent={selectedAgent}
          overview={overview}
          runFocus={runFocus}
          onStart={startAgent}
          onStop={stopAgent}
          onEdit={(agent) => setWizard({ mode: "edit", agent })}
          onDelete={deleteAgent}
          onSelectChannel={selectChannel}
          onSelectAgent={(agent) => setSelectedAgentId(agent.id)}
          onClear={() => setSelectedAgentId(null)}
          onRefresh={refreshOverview}
        />
      </div>

      {wizard ? (
        <AgentWizard
          key={wizard.mode === "edit" ? wizard.agent.id : "create"}
          mode={wizard.mode}
          agent={wizard.mode === "edit" ? wizard.agent : undefined}
          presets={presets}
          channels={nonDmChannels}
          integrations={overview?.integrations ?? []}
          initialChannelIds={
            wizard.mode === "edit"
              ? nonDmChannels.filter((c) => c.memberIds.includes(wizard.agent.id)).map((c) => c.id)
              : []
          }
          onClose={() => setWizard(null)}
          onSubmit={submitWizard}
        />
      ) : null}

      {channelDialog ? (
        <ChannelDialog agents={overview?.agents ?? []} onClose={() => setChannelDialog(false)} onSubmit={submitChannel} />
      ) : null}

      {integrationsOpen ? (
        <IntegrationsPanel
          integrations={overview?.integrations ?? []}
          onClose={() => setIntegrationsOpen(false)}
          onRefresh={refreshOverview}
        />
      ) : null}
    </div>
  );
}

function UnlockScreen({
  notice,
  required,
  onUnlock,
  onRetry,
}: {
  notice: string | null;
  required: boolean;
  onUnlock: (token: string) => void;
  onRetry: () => void;
}) {
  const [token, setToken] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) onUnlock(token.trim());
  };
  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-name">Launchpad</div>
        <h1>Unlock the control plane</h1>
        <p>
          {required
            ? "This server requires an access token. It is stored locally in your browser."
            : "The server could not be reached. Check that it is running, then try again."}
        </p>
        {notice ? <div className="error-note">{notice}</div> : null}
        {required ? (
          <>
            <label className="field">
              <span className="field-label">Access token</span>
              <input
                autoFocus
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="paste token"
              />
            </label>
            <button type="submit" className="btn btn-primary btn-block" disabled={!token.trim()}>
              Unlock
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary btn-block" onClick={onRetry}>
            Retry
          </button>
        )}
      </form>
    </div>
  );
}
