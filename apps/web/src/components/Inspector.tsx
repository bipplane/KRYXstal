import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Agent, AgentRun, Channel, Decision, Overview, RunEvent, RunEventType } from "../types";
import {
  Avatar,
  EffectBadge,
  EmptyState,
  ErrorNote,
  fullTime,
  relativeTime,
  Section,
  Spinner,
  StatusDot,
  StatusPill,
  Tag,
  truncate,
  useNow,
} from "./ui";

const POLL_MS = 2000;

export interface RunFocus {
  agentId: string;
  runId: string;
  /** Changes on every request so re-clicking the same run re-focuses it. */
  nonce: number;
}

interface InspectorProps {
  agent: Agent | null;
  overview: Overview | null;
  runFocus: RunFocus | null;
  onStart: (agent: Agent) => Promise<void>;
  onStop: (agent: Agent) => Promise<void>;
  onEdit: (agent: Agent) => void;
  onDelete: (agent: Agent) => Promise<void>;
  onSelectChannel: (channelId: string) => void;
  onSelectAgent: (agent: Agent) => void;
  onClear: () => void;
}

export default function Inspector(props: InspectorProps) {
  const { agent } = props;
  return (
    <aside className="inspector">
      {agent ? <AgentInspector key={agent.id} {...props} agent={agent} /> : <GlobalAudit />}
    </aside>
  );
}

// ---------- per-agent ----------

function AgentInspector({
  agent,
  overview,
  runFocus,
  onStart,
  onStop,
  onEdit,
  onDelete,
  onSelectChannel,
  onSelectAgent,
  onClear,
}: InspectorProps & { agent: Agent }) {
  const now = useNow(10000);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [runsOpen, setRunsOpen] = useState(true);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(() => new Set());
  const pendingScroll = useRef<string | null>(null);

  // Poll runs + decisions while this agent is open.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [r, d] = await Promise.all([api.runs(agent.id), api.agentDecisions(agent.id)]);
        if (cancelled) return;
        setRuns(r.runs);
        setDecisions(d.decisions);
        setPollError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return;
        setPollError(err instanceof Error ? err.message : "Failed to load activity");
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [agent.id]);

  // Focus a run when asked to (from a run pill in the channel).
  useEffect(() => {
    if (!runFocus || runFocus.agentId !== agent.id) return;
    setRunsOpen(true);
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      next.add(runFocus.runId);
      return next;
    });
    pendingScroll.current = runFocus.runId;
  }, [runFocus, agent.id]);

  useEffect(() => {
    const id = pendingScroll.current;
    if (!id || !runs) return;
    const el = document.getElementById("run-" + id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("run-flash");
      window.setTimeout(() => el.classList.remove("run-flash"), 1600);
      pendingScroll.current = null;
    }
  }, [runs, runsOpen, expandedRuns]);

  const run = async (kind: "start" | "stop" | "delete", fn: () => Promise<void>) => {
    setBusy(kind);
    setActionError(null);
    try {
      await fn();
      if (kind === "delete") setConfirmDelete(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const agents = overview?.agents ?? [];
  const channels = (overview?.channels ?? []).filter((c) => c.memberIds.includes(agent.id) && !c.archivedAt);
  const sessions = agents.filter((a) => a.kind === "session" && a.parentAgentId === agent.id);
  const parent = agent.parentAgentId ? agents.find((a) => a.id === agent.parentAgentId) ?? null : null;
  const canStart = agent.status === "stopped" || agent.status === "error";
  const canStop = agent.status === "ready" || agent.status === "busy";
  const isClosed = agent.status === "closed";

  const toggleRun = (id: string) =>
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="inspector-scroll">
      <header className="inspector-head">
        <div className="inspector-title-row">
          <Avatar name={agent.name} kind={agent.kind} size="lg" />
          <div className="inspector-title">
            <div className="inspector-name-row">
              <h2 className={isClosed ? "strike" : ""}>{agent.name}</h2>
              <Tag tone={agent.kind === "session" ? "purple" : "muted"}>{agent.kind}</Tag>
            </div>
            <div className="inspector-sub">
              <StatusPill status={agent.status} />
              {parent ? (
                <button type="button" className="link-btn" onClick={() => onSelectAgent(parent)}>
                  ↑ {parent.name}
                </button>
              ) : null}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClear} title="Back to audit log" aria-label="Close inspector">
            ×
          </button>
        </div>
        {agent.description ? <p className="inspector-desc">{agent.description}</p> : null}
        {agent.lastError ? <div className="error-note">{agent.lastError}</div> : null}
        <dl className="kv small">
          <dt>Created</dt>
          <dd title={fullTime(agent.createdAt)}>{relativeTime(agent.createdAt, now)}</dd>
          {agent.expiresAt ? (
            <>
              <dt>Expires</dt>
              <dd title={fullTime(agent.expiresAt)}>{relativeTime(agent.expiresAt, now)}</dd>
            </>
          ) : null}
          {agent.dmChannelId ? (
            <>
              <dt>DM</dt>
              <dd>
                <button type="button" className="link-btn" onClick={() => onSelectChannel(agent.dmChannelId as string)}>
                  open direct message
                </button>
              </dd>
            </>
          ) : null}
        </dl>

        <div className="inspector-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={!canStart || busy !== null}
            onClick={() => void run("start", () => onStart(agent))}
          >
            {busy === "start" ? "Starting…" : "Start"}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!canStop || busy !== null}
            onClick={() => void run("stop", () => onStop(agent))}
          >
            {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
          <button type="button" className="btn btn-sm" disabled={isClosed || busy !== null} onClick={() => onEdit(agent)}>
            Edit
          </button>
          {confirmDelete ? (
            <span className="confirm-inline">
              <span>Delete {agent.name}?</span>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={busy !== null}
                onClick={() => void run("delete", () => onDelete(agent))}
              >
                {busy === "delete" ? "Deleting…" : "Confirm"}
              </button>
              <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-sm btn-danger-ghost" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
        </div>
        <ErrorNote message={actionError} />
      </header>

      <Section title="Policy" defaultOpen>
        <PolicyView agent={agent} />
      </Section>

      <Section title="Channels" count={channels.length}>
        {channels.length === 0 ? (
          <div className="muted small">Not a member of any channel.</div>
        ) : (
          <ul className="plain-list">
            {channels.map((channel) => (
              <li key={channel.id}>
                <button type="button" className="link-row" onClick={() => onSelectChannel(channel.id)}>
                  <span className="nav-hash">{channel.kind === "dm" ? "@" : "#"}</span>
                  <span>{channelLabel(channel, agents, overview)}</span>
                  <span className="muted small">{channel.memberIds.length}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Sessions" count={sessions.length}>
        {sessions.length === 0 ? (
          <div className="muted small">No sessions spawned by this agent.</div>
        ) : (
          <ul className="plain-list">
            {sessions.map((session) => (
              <li key={session.id}>
                <button type="button" className="link-row" onClick={() => onSelectAgent(session)}>
                  <StatusDot status={session.status} />
                  <span className={session.status === "closed" ? "strike" : ""}>{session.name}</span>
                  <span className="muted small">{relativeTime(session.createdAt, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Runs" count={runs?.length} open={runsOpen} onToggle={setRunsOpen}>
        {pollError ? <ErrorNote message={pollError} /> : null}
        {runs === null ? (
          <Spinner label="Loading runs…" />
        ) : runs.length === 0 ? (
          <div className="muted small">No runs yet. Message this agent to start one.</div>
        ) : (
          <ul className="run-list">
            {runs.map((r) => (
              <RunCard
                key={r.id}
                run={r}
                now={now}
                expanded={expandedRuns.has(r.id)}
                onToggle={() => toggleRun(r.id)}
                channel={r.channelId ? (overview?.channels ?? []).find((c) => c.id === r.channelId) ?? null : null}
                onSelectChannel={onSelectChannel}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Decisions" count={decisions?.length}>
        {decisions === null ? (
          <Spinner label="Loading decisions…" />
        ) : decisions.length === 0 ? (
          <div className="muted small">No policy decisions recorded.</div>
        ) : (
          <DecisionList decisions={decisions} now={now} showAgent={false} />
        )}
      </Section>
    </div>
  );
}

function channelLabel(channel: Channel, agents: Agent[], overview: Overview | null): string {
  if (channel.kind !== "dm") return channel.name;
  const other = channel.memberIds.find((id) => id !== "user");
  const agent = other ? agents.find((a) => a.id === other) : null;
  return agent ? agent.name + " ↔ " + (overview?.user.name ?? "you") : channel.name;
}

// ---------- policy ----------

function PolicyView({ agent }: { agent: Agent }) {
  const { policy } = agent;
  return (
    <div className="policy">
      <div className="policy-preset">
        <span className="muted small">Preset</span>
        <Tag tone="purple">{policy.preset}</Tag>
      </div>
      {policy.statements.length === 0 ? (
        <div className="muted small">No statements — everything is denied by default.</div>
      ) : (
        <div className="table-wrap">
          <table className="table policy-table">
            <thead>
              <tr>
                <th>Effect</th>
                <th>Actions</th>
                <th>Resources</th>
              </tr>
            </thead>
            <tbody>
              {policy.statements.map((statement, index) => (
                <tr key={index} className={"row-" + statement.effect}>
                  <td>
                    <EffectBadge effect={statement.effect} />
                  </td>
                  <td>
                    <CodeList items={statement.actions} />
                  </td>
                  <td>
                    <CodeList items={statement.resources} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="policy-delegable">
        <span className="muted small">Delegable to sessions</span>
        {policy.delegable.length === 0 ? (
          <span className="muted small"> — nothing</span>
        ) : (
          <CodeList items={policy.delegable} />
        )}
      </div>
    </div>
  );
}

function CodeList({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="muted small">—</span>;
  return (
    <span className="code-list">
      {items.map((item, i) => (
        <code key={i}>{item}</code>
      ))}
    </span>
  );
}

// ---------- runs ----------

const EVENT_GLYPH: Record<RunEventType, string> = {
  command_execution: "$",
  mcp_tool_call: "⚙",
  file_change: "✎",
  web_search: "⌕",
  reasoning: "…",
  conflict: "⇄",
};

const TRIGGER_LABEL: Record<AgentRun["trigger"], string> = {
  user: "you",
  channel: "channel",
  spawn: "spawn",
  conflict: "regenerate",
};

function RunCard({
  run,
  now,
  expanded,
  onToggle,
  channel,
  onSelectChannel,
}: {
  run: AgentRun;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  channel: Channel | null;
  onSelectChannel: (id: string) => void;
}) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const promptLong = run.prompt.length > 160;
  const outputLong = (run.output ?? "").length > 400;
  const when = run.startedAt ?? run.createdAt;
  const duration =
    run.startedAt && run.completedAt
      ? Math.max(0, Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)) + "s"
      : null;

  return (
    <li className={"run" + (expanded ? " run-expanded" : "")} id={"run-" + run.id}>
      <div className="run-head">
        <StatusPill status={run.status} />
        <span className="muted small">via {TRIGGER_LABEL[run.trigger]}</span>
        {run.conflict ? (
          <Tag tone="red">lost race</Tag>
        ) : run.conflicts > 0 ? (
          <Tag tone="purple">
            {run.conflicts} conflict{run.conflicts === 1 ? "" : "s"}
          </Tag>
        ) : null}
        {run.silent ? <Tag>no reply</Tag> : null}
        {channel ? (
          <button type="button" className="link-btn small" onClick={() => onSelectChannel(channel.id)}>
            #{channel.name}
          </button>
        ) : null}
        <span className="muted small run-time" title={fullTime(when)}>
          {relativeTime(when, now)}
          {duration ? " · " + duration : ""}
        </span>
      </div>
      <div className="run-prompt">
        <span className="muted small">Prompt</span>
        <p className="pre-wrap">{promptOpen || !promptLong ? run.prompt : truncate(run.prompt, 160)}</p>
        {promptLong ? (
          <button type="button" className="link-btn small" onClick={() => setPromptOpen((v) => !v)}>
            {promptOpen ? "show less" : "show more"}
          </button>
        ) : null}
      </div>
      {run.error ? <div className="error-note small">{run.error}</div> : null}
      {run.conflict ? (
        <div className="run-conflict small">
          <span className="msg-glyph">⇄</span>{" "}
          {run.conflict.cause === "busy"
            ? "Reply not posted: the channel was busy."
            : "Reply not posted: " +
              (run.conflict.winnerName ?? "someone") +
              " got there first with “" +
              truncate(run.conflict.winnerContent ?? "", 80) +
              "”."}{" "}
          {run.conflict.attempt > run.conflict.limit
            ? "Stopped after " + run.conflict.limit + " lost races."
            : "A regenerate turn was queued."}
        </div>
      ) : null}
      {run.output ? (
        <div className="run-output">
          <span className="muted small">{run.conflict ? "Rejected reply" : run.silent ? "Reply (not posted)" : "Output"}</span>
          <p className="pre-wrap">{outputOpen || !outputLong ? run.output : truncate(run.output, 400)}</p>
          {outputLong ? (
            <button type="button" className="link-btn small" onClick={() => setOutputOpen((v) => !v)}>
              {outputOpen ? "show less" : "show more"}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="run-foot">
        <button type="button" className="link-btn small" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? "▾" : "▸"} {run.events.length} event{run.events.length === 1 ? "" : "s"}
        </button>
        {run.usage ? (
          <span className="muted small" title="input / cached / output tokens">
            {run.usage.inputTokens ?? 0} / {run.usage.cachedInputTokens ?? 0} / {run.usage.outputTokens ?? 0} tok
          </span>
        ) : null}
        <code className="muted small">{run.id.slice(0, 8)}</code>
      </div>
      {expanded ? (
        run.events.length === 0 ? (
          <div className="muted small timeline-empty">No events recorded for this run.</div>
        ) : (
          <ol className="timeline">
            {run.events.map((event) => (
              <TimelineEvent key={event.id} event={event} />
            ))}
          </ol>
        )
      ) : null}
    </li>
  );
}

function TimelineEvent({ event }: { event: RunEvent }) {
  const [open, setOpen] = useState(false);
  const failed = event.exitCode !== null && event.exitCode !== 0;
  return (
    <li className={"timeline-item timeline-" + event.type + (failed ? " timeline-failed" : "")}>
      <span className="timeline-glyph" title={event.type}>
        {EVENT_GLYPH[event.type] ?? "•"}
      </span>
      <div className="timeline-body">
        <div className="timeline-summary">
          <span className="pre-wrap">{event.summary}</span>
        </div>
        <div className="timeline-meta muted small">
          <span>{event.type.replace("_", " ")}</span>
          {event.status ? <span>· {event.status}</span> : null}
          {event.exitCode !== null ? <span className={failed ? "text-red" : ""}>· exit {event.exitCode}</span> : null}
          <span title={fullTime(event.createdAt)}>· {new Date(event.createdAt).toLocaleTimeString()}</span>
          {event.detail ? (
            <button type="button" className="link-btn small" onClick={() => setOpen((v) => !v)}>
              {open ? "hide detail" : "detail"}
            </button>
          ) : null}
        </div>
        {open && event.detail ? <pre className="msg-code small">{event.detail}</pre> : null}
      </div>
    </li>
  );
}

// ---------- decisions ----------

function DecisionList({ decisions, now, showAgent }: { decisions: Decision[]; now: number; showAgent: boolean }) {
  return (
    <ul className="decision-list">
      {decisions.map((d) => (
        <li key={d.id} className={"decision decision-" + d.effect}>
          <div className="decision-head">
            <EffectBadge effect={d.effect} />
            {showAgent ? <span className="decision-agent">{d.agentName}</span> : null}
            <code className="decision-action">{d.action}</code>
            <span className="muted">→</span>
            <code className="decision-resource">{d.resource}</code>
          </div>
          <div className="decision-meta muted small">
            <span>{d.tool}</span>
            <span>· {d.source}</span>
            {d.runId ? <span>· run {d.runId.slice(0, 8)}</span> : null}
            <span title={fullTime(d.createdAt)}>· {relativeTime(d.createdAt, now)}</span>
          </div>
          {d.reason ? <div className="decision-reason small">{d.reason}</div> : null}
        </li>
      ))}
    </ul>
  );
}

function GlobalAudit() {
  const now = useNow(10000);
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const { decisions: next } = await api.decisions(100);
        if (cancelled) return;
        setDecisions(next);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return;
        setError(err instanceof Error ? err.message : "Failed to load audit log");
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const allowed = decisions?.filter((d) => d.effect === "allow").length ?? 0;
  const denied = decisions?.filter((d) => d.effect === "deny").length ?? 0;
  const conflicts = decisions?.filter((d) => d.effect === "conflict").length ?? 0;

  return (
    <div className="inspector-scroll">
      <header className="inspector-head">
        <div className="inspector-name-row">
          <h2>Audit log</h2>
        </div>
        <p className="inspector-desc">
          Every policy and synchronisation decision across all agents, newest first. Select an agent to
          inspect it.
        </p>
        {decisions ? (
          <div className="audit-stats">
            <span className="effect effect-allow">{allowed} allowed</span>
            <span className="effect effect-deny">{denied} denied</span>
            <span className="effect effect-conflict" title="Lost races: not policy denials">
              {conflicts} lost {conflicts === 1 ? "race" : "races"}
            </span>
          </div>
        ) : null}
      </header>
      <div className="section-body">
        <ErrorNote message={error} />
        {decisions === null && !error ? (
          <Spinner label="Loading audit log…" />
        ) : decisions && decisions.length === 0 ? (
          <EmptyState title="No decisions yet" hint="Policy checks will appear here as agents act." />
        ) : decisions ? (
          <DecisionList decisions={decisions} now={now} showAgent />
        ) : null}
      </div>
    </div>
  );
}
