import { useEffect, useState } from "react";
import { api } from "../api";
import { isUsableIntegration, toolAccess } from "../mcp";
import type { Agent, Integration } from "../types";
import { ErrorNote, Tag } from "./ui";

/** Inspector → Policy: which integration tools this agent may call, and whose login it uses. */
export default function AgentIntegrations({
  agent,
  integrations,
  onRefresh,
}: {
  agent: Agent;
  integrations: Integration[];
  onRefresh: () => Promise<void>;
}) {
  const ownIds = agent.ownIntegrationIds ?? [];
  const visible = integrations.filter((i) => isUsableIntegration(i) || ownIds.includes(i.id));
  if (visible.length === 0) {
    return (
      <div className="integ-agent">
        <span className="muted small">Integrations</span>
        <span className="muted small"> — none connected</span>
      </div>
    );
  }
  return (
    <div className="integ-agent">
      <span className="muted small">Integrations</span>
      <ul className="integ-agent-list">
        {visible.map((integration) => (
          <AgentIntegrationRow
            key={integration.id}
            agent={agent}
            integration={integration}
            own={ownIds.includes(integration.id)}
            onRefresh={onRefresh}
          />
        ))}
      </ul>
    </div>
  );
}

function AgentIntegrationRow({
  agent,
  integration,
  own,
  onRefresh,
}: {
  agent: Agent;
  integration: Integration;
  own: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(false);

  // The per-agent OAuth flow finishes in another tab; polling flips `own` once it lands.
  useEffect(() => {
    if (own) setHint(false);
  }, [own]);

  const access = integration.tools.map((tool) => ({ tool, effect: toolAccess(agent.policy.statements, integration, tool) }));
  const allowed = access.filter((a) => a.effect === "allow");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const useOwn = () =>
    run(async () => {
      const { url } = await api.agentIntegrationLogin(agent.id, integration.id);
      window.open(url, "_blank", "noopener");
      setHint(true);
      await onRefresh();
    });
  const useShared = () =>
    run(async () => {
      await api.agentIntegrationLogout(agent.id, integration.id);
      await onRefresh();
    });

  return (
    <li className="integ-agent-row">
      <div className="integ-agent-head">
        <span className="integ-name">{integration.name}</span>
        {own ? <Tag tone="purple">own identity</Tag> : null}
        <span className="muted small">
          {allowed.length} of {integration.tools.length} tool{integration.tools.length === 1 ? "" : "s"}
        </span>
        {integration.auth === "oauth" ? (
          <button
            type="button"
            className="link-btn small integ-agent-login"
            disabled={busy}
            onClick={() => void (own ? useShared() : useOwn())}
          >
            {busy ? "…" : own ? "Use shared login" : "Use own login"}
          </button>
        ) : null}
      </div>
      {hint && !own ? (
        <div className="integ-hint small">Finish authorising in the browser tab — this updates automatically.</div>
      ) : null}
      <ErrorNote message={error} />
      {integration.tools.length === 0 ? (
        <div className="muted small">No tools discovered.</div>
      ) : (
        <ul className="integ-agent-tools">
          {access.map(({ tool, effect }) => (
            <li key={tool.name} className={"integ-agent-tool integ-agent-tool-" + (effect ?? "none")} title={tool.description || undefined}>
              <code>{tool.name}</code>
              {tool.readOnly ? <Tag>read-only</Tag> : null}
              {effect === "deny" ? <Tag tone="red">denied</Tag> : null}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
