import type { Agent, Channel, Overview, SystemInfo } from "../types";
import { StatusDot, Tag } from "./ui";

interface SidebarProps {
  system: SystemInfo | null;
  overview: Overview | null;
  selectedChannelId: string | null;
  selectedAgentId: string | null;
  onSelectChannel: (channelId: string) => void;
  onSelectAgent: (agent: Agent) => void;
  onNewAgent: () => void;
  onNewChannel: () => void;
  onOpenIntegrations: () => void;
}

export default function Sidebar({
  system,
  overview,
  selectedChannelId,
  selectedAgentId,
  onSelectChannel,
  onSelectAgent,
  onNewAgent,
  onNewChannel,
  onOpenIntegrations,
}: SidebarProps) {
  const channels = (overview?.channels ?? []).filter((c) => c.kind !== "dm" && !c.archivedAt);
  const agents = overview?.agents ?? [];
  const integrations = overview?.integrations ?? [];
  const principals = agents.filter((a) => a.kind === "principal");
  const sessionsByParent = new Map<string, Agent[]>();
  for (const agent of agents) {
    if (agent.kind === "session") {
      const key = agent.parentAgentId ?? agent.principalId;
      const list = sessionsByParent.get(key) ?? [];
      list.push(agent);
      sessionsByParent.set(key, list);
    }
  }
  const orphanSessions = agents.filter(
    (a) => a.kind === "session" && !agents.some((p) => p.id === (a.parentAgentId ?? a.principalId)),
  );
  const pendingApprovals = (overview?.approvals ?? []).filter((a) => a.status === "pending").length;

  const renderChannel = (channel: Channel) => {
    const isApprovals = channel.kind === "system" && channel.name === "approvals";
    const active = channel.id === selectedChannelId;
    return (
      <li key={channel.id}>
        <button
          type="button"
          className={"nav-item" + (active ? " nav-item-active" : "")}
          onClick={() => onSelectChannel(channel.id)}
          title={channel.description || channel.name}
        >
          <span className="nav-hash">#</span>
          <span className="nav-label">{channel.name}</span>
          {isApprovals && pendingApprovals > 0 ? <span className="badge">{pendingApprovals}</span> : null}
        </button>
      </li>
    );
  };

  const renderAgent = (agent: Agent, nested: boolean) => {
    const active = agent.id === selectedAgentId;
    return (
      <li key={agent.id}>
        <button
          type="button"
          className={
            "nav-item nav-agent" +
            (nested ? " nav-agent-nested" : "") +
            (active ? " nav-item-active" : "") +
            (agent.status === "closed" ? " nav-agent-closed" : "")
          }
          onClick={() => onSelectAgent(agent)}
          title={agent.description || agent.name}
        >
          {nested ? <span className="nav-branch">└</span> : null}
          <StatusDot status={agent.status} />
          <span className="nav-label">{agent.name}</span>
          {nested ? <Tag>session</Tag> : null}
        </button>
      </li>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-name">Launchpad</div>
        <RuntimePill system={system} />
      </div>

      <nav className="sidebar-scroll">
        <div className="nav-group">
          <div className="nav-group-head">
            <span>Channels</span>
            <button type="button" className="link-btn" onClick={onNewChannel}>
              + New channel
            </button>
          </div>
          {channels.length === 0 ? (
            <div className="nav-empty">No channels yet</div>
          ) : (
            <ul className="nav-list">{channels.map(renderChannel)}</ul>
          )}
        </div>

        <div className="nav-group">
          <div className="nav-group-head">
            <span>Agents</span>
          </div>
          {agents.length === 0 ? (
            <div className="nav-empty">No agents yet. Create one to get started.</div>
          ) : (
            <ul className="nav-list">
              {principals.map((principal) => [
                renderAgent(principal, false),
                ...(sessionsByParent.get(principal.id) ?? []).map((session) => renderAgent(session, true)),
              ])}
              {orphanSessions.map((session) => renderAgent(session, true))}
            </ul>
          )}
        </div>

        <div className="nav-group">
          <div className="nav-group-head">
            <span>Integrations</span>
            <button type="button" className="link-btn" onClick={onOpenIntegrations}>
              {integrations.length === 0 ? "+ Add" : "Manage"}
            </button>
          </div>
          {integrations.length === 0 ? (
            <div className="nav-empty">No MCP servers connected yet.</div>
          ) : (
            <ul className="nav-list">
              {integrations.map((integration) => (
                <li key={integration.id}>
                  <button
                    type="button"
                    className="nav-item integ-nav"
                    onClick={onOpenIntegrations}
                    title={integration.status + (integration.lastError ? ": " + integration.lastError : "")}
                  >
                    <span className={"integ-dot integ-dot-" + integration.status} />
                    <span className="nav-label">{integration.name}</span>
                    <span className="muted small">{integration.tools.length}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </nav>

      <div className="sidebar-foot">
        <button type="button" className="btn btn-primary btn-block" onClick={onNewAgent}>
          + New agent
        </button>
      </div>
    </aside>
  );
}

function RuntimePill({ system }: { system: SystemInfo | null }) {
  if (!system) {
    return <div className="runtime-pill runtime-pill-muted">connecting…</div>;
  }
  const parts = ["Codex", system.containerEngine ?? system.runtimeProvider];
  if (system.modelProvider === "local-codex") parts.push("local login");
  const warn = !system.arkConfigured;
  return (
    <div
      className={"runtime-pill" + (warn ? " runtime-pill-warn" : "")}
      title={
        [
          "Runtime: " + system.runtimeProvider,
          "Model provider: " + (system.modelProvider ?? "ark"),
          "Sandbox: " + system.codexSandboxMode,
          "Codex: " + (system.codexAvailable ? "available" : "missing"),
          system.arkModel ? "Model: " + system.arkModel : "",
          warn ? "Ark is not configured — set ARK credentials on the server." : "",
        ]
          .filter(Boolean)
          .join("\n")
      }
    >
      <span className={"runtime-dot" + (warn || !system.codexAvailable ? " runtime-dot-warn" : "")} />
      <span className="runtime-label">
        {parts.join(" · ")}
        {warn ? <span className="runtime-warn"> · Ark not configured</span> : null}
      </span>
    </div>
  );
}
