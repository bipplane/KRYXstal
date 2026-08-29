import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "../api";
import type { AgentRun, Channel, ChannelMessage, Decision, Overview, RunEvent, RunEventType, Trace } from "../types";
import {
  Avatar,
  clockTime,
  EffectBadge,
  EmptyState,
  ErrorNote,
  fullTime,
  MessageContent,
  Spinner,
  StatusPill,
  Tag,
  truncate,
  useNow,
} from "./ui";

interface TraceViewProps {
  /** Any message in the chain; the server resolves it to the root. */
  messageId: string;
  overview: Overview | null;
  /** Leave the trace. Receives the channel the root prompt was posted in, if known. */
  onBack: (channelId: string | null) => void;
  onSelectAgent: (agentId: string) => void;
  onOpenRun: (agentId: string, runId: string) => void;
}

const POLL_MS = 2000;
const MAX_DEPTH = 6;
const LAYOUT_KEY = "launchpad-trace-layout";

type Layout = "tree" | "timeline";

function loadLayout(): Layout {
  try {
    return window.localStorage.getItem(LAYOUT_KEY) === "timeline" ? "timeline" : "tree";
  } catch {
    return "tree";
  }
}

function saveLayout(layout: Layout): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // Storage unavailable: the toggle still works for this page view.
  }
}
const INDENT_PX = 20;
const LONG_CONTENT = 600;

// ---------- timeline model ----------

type TraceItem =
  | { kind: "message"; key: string; time: number; order: 1; depth: number; channelId: string | null; message: ChannelMessage }
  | { kind: "run"; key: string; time: number; order: 0; depth: number; channelId: string | null; run: AgentRun; decisions: Decision[] }
  | { kind: "decision"; key: string; time: number; order: 2; depth: number; channelId: string | null; decision: Decision };

function ms(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return new Date(iso).getTime();
}

/** Depth of every message, following parentMessageId up to the root (0). Missing parents count as 1. */
function messageDepths(trace: Trace): Map<string, number> {
  const byId = new Map(trace.messages.map((m) => [m.id, m]));
  const depths = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const message = byId.get(id);
    let depth: number;
    if (!message || id === trace.rootId || !message.parentMessageId) {
      depth = id === trace.rootId ? 0 : 1;
    } else if (!byId.has(message.parentMessageId) || seen.has(message.parentMessageId)) {
      depth = 1;
    } else {
      seen.add(id);
      depth = resolve(message.parentMessageId, seen) + 1;
    }
    depths.set(id, depth);
    return depth;
  };
  for (const message of trace.messages) resolve(message.id, new Set());
  return depths;
}

function buildTimeline(trace: Trace): TraceItem[] {
  const depths = messageDepths(trace);
  const decisionsByRun = new Map<string, Decision[]>();
  const looseDecisions: Decision[] = [];
  for (const decision of trace.decisions) {
    if (decision.runId && trace.runs.some((r) => r.id === decision.runId)) {
      const list = decisionsByRun.get(decision.runId) ?? [];
      list.push(decision);
      decisionsByRun.set(decision.runId, list);
    } else {
      looseDecisions.push(decision);
    }
  }

  const items: TraceItem[] = [];
  for (const message of trace.messages) {
    items.push({
      kind: "message",
      key: "m:" + message.id,
      time: ms(message.createdAt),
      order: 1,
      depth: depths.get(message.id) ?? 1,
      channelId: message.channelId,
      message,
    });
  }
  for (const run of trace.runs) {
    const triggerDepth = run.triggerMessageId ? depths.get(run.triggerMessageId) : undefined;
    items.push({
      kind: "run",
      key: "r:" + run.id,
      time: ms(run.startedAt ?? run.createdAt),
      order: 0,
      depth: triggerDepth === undefined ? 1 : triggerDepth + 1,
      channelId: run.channelId,
      run,
      decisions: decisionsByRun.get(run.id) ?? [],
    });
  }
  for (const decision of looseDecisions) {
    items.push({
      kind: "decision",
      key: "d:" + decision.id,
      time: ms(decision.createdAt),
      order: 2,
      depth: 1,
      channelId: null,
      decision,
    });
  }

  // Stable chronological sort; on ties, runs precede the messages they produced.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ta = Number.isNaN(a.item.time) ? 0 : a.item.time;
      const tb = Number.isNaN(b.item.time) ? 0 : b.item.time;
      if (ta !== tb) return ta - tb;
      if (a.item.order !== b.item.order) return a.item.order - b.item.order;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

// ---------- tree model ----------

interface TreeNode {
  item: TraceItem;
  children: TreeNode[];
}

/**
 * Lineage tree: a run hangs off the message that woke it (`triggerMessageId`);
 * a message hangs off the run that produced it (`runId`), or else off the message
 * it replies to (`parentMessageId`). Anything unattached hangs off the root.
 */
function buildTree(trace: Trace): TreeNode | null {
  const items = buildTimeline(trace); // already chronologically sorted
  const nodes = new Map<string, TreeNode>();
  for (const item of items) nodes.set(item.key, { item, children: [] });
  const rootNode = nodes.get("m:" + trace.rootId);
  if (!rootNode) return null;
  const runKeys = new Set(trace.runs.map((r) => "r:" + r.id));
  const messageKeys = new Set(trace.messages.map((m) => "m:" + m.id));

  const parentKey = (item: TraceItem): string | null => {
    if (item.kind === "run") {
      const key = item.run.triggerMessageId ? "m:" + item.run.triggerMessageId : null;
      return key && messageKeys.has(key) ? key : "m:" + trace.rootId;
    }
    if (item.kind === "message") {
      if (item.message.id === trace.rootId) return null;
      const byRun = item.message.runId ? "r:" + item.message.runId : null;
      if (byRun && runKeys.has(byRun)) return byRun;
      const byParent = item.message.parentMessageId ? "m:" + item.message.parentMessageId : null;
      if (byParent && messageKeys.has(byParent) && byParent !== item.key) return byParent;
      return "m:" + trace.rootId;
    }
    const byRun = item.decision.runId ? "r:" + item.decision.runId : null;
    return byRun && runKeys.has(byRun) ? byRun : "m:" + trace.rootId;
  };

  // Guard against cycles: a node may only attach to a parent that is not its own descendant.
  const ancestors = (key: string): Set<string> => {
    const seen = new Set<string>();
    let cursor: string | null = key;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = nodes.get(cursor);
      cursor = node ? parentKey(node.item) : null;
    }
    return seen;
  };

  for (const item of items) {
    const node = nodes.get(item.key);
    if (!node || item.key === rootNode.item.key) continue;
    let target = parentKey(item);
    if (!target || !nodes.has(target) || ancestors(target).has(item.key)) target = rootNode.item.key;
    nodes.get(target)?.children.push(node);
  }
  return rootNode;
}

function formatDuration(msTotal: number): string {
  if (!Number.isFinite(msTotal) || msTotal < 0) return "—";
  const s = msTotal / 1000;
  if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s).toString()) + "s";
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  if (m < 60) return m + "m " + rest + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m - h * 60) + "m";
}

/** Latest timestamp touched by anything in the trace. */
function lastActivity(trace: Trace): number {
  let latest = ms(trace.root.createdAt);
  const bump = (iso: string | null | undefined) => {
    const t = ms(iso);
    if (!Number.isNaN(t) && t > latest) latest = t;
  };
  for (const m of trace.messages) bump(m.createdAt);
  for (const r of trace.runs) {
    bump(r.completedAt ?? r.startedAt ?? r.createdAt);
    for (const e of r.events) bump(e.createdAt);
  }
  for (const d of trace.decisions) bump(d.createdAt);
  return latest;
}

// ---------- lookups ----------

interface Lookups {
  channel: (id: string | null) => Channel | null;
  channelLabel: (id: string | null) => string | null;
  agentName: (id: string) => string;
}

function useLookups(trace: Trace | null, overview: Overview | null): Lookups {
  return useMemo(() => {
    const channels = new Map<string, Channel>();
    for (const c of overview?.channels ?? []) channels.set(c.id, c);
    for (const c of trace?.channels ?? []) channels.set(c.id, c);
    const agents = new Map<string, { name: string; kind: "principal" | "session" }>();
    for (const a of overview?.agents ?? []) agents.set(a.id, { name: a.name, kind: a.kind });
    for (const a of trace?.agents ?? []) agents.set(a.id, { name: a.name, kind: a.kind });
    const userName = overview?.user.name ?? "you";

    const channel = (id: string | null) => (id ? channels.get(id) ?? null : null);
    const channelLabel = (id: string | null) => {
      const c = channel(id);
      if (!c) return id ? id.slice(0, 8) : null;
      if (c.kind !== "dm") return "#" + c.name;
      const other = c.memberIds.find((m) => m !== "user");
      const agent = other ? agents.get(other) : undefined;
      return "DM · " + (agent ? agent.name : userName);
    };
    return {
      channel,
      channelLabel,
      agentName: (id) => agents.get(id)?.name ?? id,
    };
  }, [trace, overview]);
}

// ---------- view ----------

export default function TraceView({ messageId, overview, onBack, onSelectAgent, onOpenRun }: TraceViewProps) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retryNonce, setRetryNonce] = useState(0);
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const chooseLayout = (next: Layout) => {
    setLayout(next);
    saveLayout(next);
  };
  const live = trace?.live ?? false;
  const now = useNow(live ? 1000 : 10000);
  const lookups = useLookups(trace, overview);

  // Fetch once, then keep polling only while the trace is live.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let wasLive = false;
    const schedule = () => {
      timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    const tick = async () => {
      try {
        const next = await api.trace(messageId);
        if (cancelled) return;
        setTrace(next);
        setError(null);
        setNotFound(false);
        wasLive = next.live;
        if (next.live) schedule();
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          setError(err.message || "No trace found for this message");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load trace");
        // A transient failure while something is still running should not stop the live view.
        if (wasLive) schedule();
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [messageId, retryNonce]);

  const timeline = useMemo(() => (trace ? buildTimeline(trace) : []), [trace]);
  const tree = useMemo(() => (trace ? buildTree(trace) : null), [trace]);

  const rootChannelId = trace?.root.channelId ?? null;
  const rootChannelLabel = lookups.channelLabel(rootChannelId);

  if (loading && !trace) {
    return (
      <main className="main trace">
        <TraceHeaderBar onBack={() => onBack(null)} backLabel="Back" />
        <div className="message-loading">
          <Spinner label="Loading trace…" />
        </div>
      </main>
    );
  }

  if (!trace) {
    return (
      <main className="main trace">
        <TraceHeaderBar onBack={() => onBack(null)} backLabel="Back" />
        <div className="trace-error">
          <ErrorNote message={error ?? "Failed to load trace"} />
          {!notFound ? (
            <button type="button" className="link-btn" onClick={() => setRetryNonce((n) => n + 1)}>
              retry
            </button>
          ) : (
            <p className="muted small">
              The message may have been deleted, or it is not part of any recorded chain.
            </p>
          )}
        </div>
      </main>
    );
  }

  const channelCount = new Set(
    [...trace.messages.map((m) => m.channelId), ...trace.runs.map((r) => r.channelId)].filter(Boolean),
  ).size;
  const denialMessages = trace.messages.filter((m) => m.kind === "denial").length;
  const denyDecisions = trace.decisions.filter((d) => d.effect === "deny").length;
  const denials = Math.max(denialMessages, denyDecisions);
  const end = live ? now : lastActivity(trace);
  const totalDuration = formatDuration(end - ms(trace.root.createdAt));
  const onlyRoot = trace.messages.length <= 1 && trace.runs.length === 0 && trace.decisions.length === 0;
  const root = trace.root;
  const rootIsAgent = root.authorKind === "principal" || root.authorKind === "session";

  return (
    <main className="main trace">
      <TraceHeaderBar
        onBack={() => onBack(rootChannelId)}
        backLabel={rootChannelLabel ? "Back to " + rootChannelLabel : "Back"}
        live={live}
        layout={layout}
        onLayout={chooseLayout}
      />

      <div className="trace-scroll">
        <section className="trace-root">
          <Avatar name={root.authorName} kind={root.authorKind} />
          <div className="trace-root-body">
            <div className="msg-head">
              {rootIsAgent ? (
                <button type="button" className="msg-author msg-author-btn" onClick={() => onSelectAgent(root.authorId)}>
                  {root.authorName}
                </button>
              ) : (
                <span className="msg-author">{root.authorKind === "user" ? "you" : root.authorName}</span>
              )}
              <ChannelChip label={rootChannelLabel} />
              <time className="msg-time" dateTime={root.createdAt} title={fullTime(root.createdAt)}>
                {clockTime(root.createdAt)}
              </time>
            </div>
            <LongContent content={root.content} />
          </div>
        </section>

        <div className="trace-summary muted small">
          <span>
            {trace.messages.length} {trace.messages.length === 1 ? "message" : "messages"}
          </span>
          <span>· {trace.runs.length} {trace.runs.length === 1 ? "run" : "runs"}</span>
          <span>· {channelCount} {channelCount === 1 ? "channel" : "channels"}</span>
          <span className={denials > 0 ? "text-red" : ""}>
            · {denials} {denials === 1 ? "denial" : "denials"}
          </span>
          <span>· {totalDuration}</span>
        </div>

        <ErrorNote message={error} />

        {onlyRoot ? (
          <EmptyState
            title="Nothing was woken by this message yet"
            hint={
              live
                ? "An agent is still working on it. This view updates as runs and replies land."
                : "No agent run, reply, or policy decision has been linked to this message."
            }
          />
        ) : layout === "tree" && tree ? (
          <ol className="trace-tree" role="tree">
            {tree.children.length === 0 ? null : (
              <TreeChildren
                nodes={tree.children}
                parentChannelId={tree.item.channelId}
                depth={1}
                trace={trace}
                now={now}
                overview={overview}
                lookups={lookups}
                onSelectAgent={onSelectAgent}
                onOpenRun={onOpenRun}
              />
            )}
          </ol>
        ) : (
          <ol className="trace-list">
            {timeline.map((item, index) => {
              const previous = previousChannel(timeline, index);
              const hop =
                item.channelId && previous !== undefined && previous !== item.channelId ? (
                  <li key={item.key + ":hop"} className="trace-hop" aria-label="channel changed">
                    <span className="trace-hop-line" />
                    <span className="trace-hop-label">→ {lookups.channelLabel(item.channelId)}</span>
                    <span className="trace-hop-line" />
                  </li>
                ) : null;
              return (
                <TraceRowFragment
                  key={item.key}
                  hop={hop}
                  item={item}
                  isRoot={item.kind === "message" && item.message.id === trace.rootId}
                  now={now}
                  overview={overview}
                  lookups={lookups}
                  onSelectAgent={onSelectAgent}
                  onOpenRun={onOpenRun}
                />
              );
            })}
          </ol>
        )}
      </div>
    </main>
  );
}

/** Channel of the nearest earlier item that has one; undefined when this is the first placed item. */
function previousChannel(items: TraceItem[], index: number): string | null | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i].channelId) return items[i].channelId;
  }
  return undefined;
}

function TraceHeaderBar({
  onBack,
  backLabel,
  live = false,
  layout,
  onLayout,
}: {
  onBack: () => void;
  backLabel: string;
  live?: boolean;
  layout?: Layout;
  onLayout?: (layout: Layout) => void;
}) {
  return (
    <header className="channel-head trace-head">
      <div className="channel-head-main trace-head-main">
        <h1 className="channel-title">Trace</h1>
        {live ? (
          <span className="trace-live" title="At least one run in this chain is still queued or running">
            <span className="trace-live-dot" />
            running…
          </span>
        ) : null}
      </div>
      {layout && onLayout ? (
        <div className="trace-layout" role="radiogroup" aria-label="Trace layout">
          <button
            type="button"
            role="radio"
            aria-checked={layout === "tree"}
            className={"trace-layout-btn" + (layout === "tree" ? " is-active" : "")}
            onClick={() => onLayout("tree")}
            title="Nest each message under the run that produced it, and each run under the message that woke it"
          >
            Tree
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={layout === "timeline"}
            className={"trace-layout-btn" + (layout === "timeline" ? " is-active" : "")}
            onClick={() => onLayout("timeline")}
            title="Everything in time order"
          >
            Timeline
          </button>
        </div>
      ) : null}
      <button type="button" className="btn btn-sm" onClick={onBack}>
        ← {backLabel}
      </button>
    </header>
  );
}

// ---------- tree rows ----------

interface TreeProps {
  nodes: TreeNode[];
  parentChannelId: string | null;
  depth: number;
  trace: Trace;
  now: number;
  overview: Overview | null;
  lookups: Lookups;
  onSelectAgent: (agentId: string) => void;
  onOpenRun: (agentId: string, runId: string) => void;
}

function TreeChildren({ nodes, parentChannelId, depth, trace, now, overview, lookups, onSelectAgent, onOpenRun }: TreeProps) {
  return (
    <>
      {nodes.map((node) => {
        const item = node.item;
        const hopped = item.channelId !== null && parentChannelId !== null && item.channelId !== parentChannelId;
        return (
          <li key={item.key} className={"trace-node trace-node-" + item.kind} role="treeitem" aria-level={depth}>
            <div className="trace-node-row">
              <span className="trace-node-elbow" aria-hidden="true" />
              <div className="trace-item-body">
                {hopped ? (
                  <span className="trace-node-hop" title="This step happened in a different channel than its parent">
                    → {lookups.channelLabel(item.channelId)}
                  </span>
                ) : null}
                <ItemBody
                  item={item}
                  isRoot={false}
                  now={now}
                  overview={overview}
                  lookups={lookups}
                  onSelectAgent={onSelectAgent}
                  onOpenRun={onOpenRun}
                />
              </div>
            </div>
            {node.children.length > 0 ? (
              <ol className="trace-children" role="group">
                <TreeChildren
                  nodes={node.children}
                  parentChannelId={item.channelId ?? parentChannelId}
                  depth={depth + 1}
                  trace={trace}
                  now={now}
                  overview={overview}
                  lookups={lookups}
                  onSelectAgent={onSelectAgent}
                  onOpenRun={onOpenRun}
                />
              </ol>
            ) : null}
          </li>
        );
      })}
    </>
  );
}

function ChannelChip({ label }: { label: string | null }) {
  if (!label) return null;
  return <span className="trace-chip">{label}</span>;
}

// ---------- rows ----------

interface RowProps {
  hop: ReactNode;
  item: TraceItem;
  isRoot: boolean;
  now: number;
  overview: Overview | null;
  lookups: Lookups;
  onSelectAgent: (agentId: string) => void;
  onOpenRun: (agentId: string, runId: string) => void;
}

function ItemBody({ item, isRoot, now, overview, lookups, onSelectAgent, onOpenRun }: Omit<RowProps, "hop">) {
  if (item.kind === "message") {
    return (
      <MessageItem
        message={item.message}
        isRoot={isRoot}
        channelLabel={lookups.channelLabel(item.channelId)}
        overview={overview}
        onSelectAgent={onSelectAgent}
      />
    );
  }
  if (item.kind === "run") {
    return (
      <RunItem
        run={item.run}
        decisions={item.decisions}
        now={now}
        lookups={lookups}
        onSelectAgent={onSelectAgent}
        onOpenRun={onOpenRun}
      />
    );
  }
  return <DecisionItem decision={item.decision} />;
}

function TraceRowFragment({ hop, item, isRoot, now, overview, lookups, onSelectAgent, onOpenRun }: RowProps) {
  const depth = Math.min(item.depth, MAX_DEPTH);
  const rails: ReactNode[] = [];
  for (let i = 0; i < depth; i += 1) rails.push(<span key={i} className="trace-rail" style={{ width: INDENT_PX }} />);
  return (
    <>
      {hop}
      <li className={"trace-item trace-item-" + item.kind} data-depth={depth}>
        {rails}
        <div className="trace-item-body">
          <ItemBody
            item={item}
            isRoot={isRoot}
            now={now}
            overview={overview}
            lookups={lookups}
            onSelectAgent={onSelectAgent}
            onOpenRun={onOpenRun}
          />
        </div>
      </li>
    </>
  );
}

function AuthorName({ message, onSelectAgent }: { message: ChannelMessage; onSelectAgent: (id: string) => void }) {
  const isAgent = message.authorKind === "principal" || message.authorKind === "session";
  if (isAgent) {
    return (
      <button
        type="button"
        className="msg-author msg-author-btn"
        onClick={() => onSelectAgent(message.authorId)}
        title="Inspect this agent"
      >
        {message.authorName}
      </button>
    );
  }
  return <span className="msg-author">{message.authorKind === "user" ? "you" : message.authorName}</span>;
}

function MessageItem({
  message,
  isRoot,
  channelLabel,
  overview,
  onSelectAgent,
}: {
  message: ChannelMessage;
  isRoot: boolean;
  channelLabel: string | null;
  overview: Overview | null;
  onSelectAgent: (id: string) => void;
}) {
  const time = (
    <time className="msg-time" dateTime={message.createdAt} title={fullTime(message.createdAt)}>
      {clockTime(message.createdAt)}
    </time>
  );

  if (message.kind === "denial" || message.kind === "spawn") {
    const denial = message.kind === "denial";
    return (
      <div className={"msg-system trace-msg " + (denial ? "msg-denial" : "msg-spawn")}>
        <span className="msg-glyph">{denial ? "⛔" : "⑂"}</span>
        <div className="msg-system-body">
          <LongContent content={message.content} />
          <div className="msg-system-meta">
            <AuthorName message={message} onSelectAgent={onSelectAgent} />
            <ChannelChip label={channelLabel} />
            {time}
          </div>
        </div>
      </div>
    );
  }

  if (message.kind === "system") {
    return (
      <div className="msg-notice trace-notice">
        <ChannelChip label={channelLabel} />
        <span>{message.content}</span>
        {time}
      </div>
    );
  }

  if (message.kind === "approval") {
    const approval = message.approvalId
      ? (overview?.approvals ?? []).find((a) => a.id === message.approvalId) ?? null
      : null;
    const status = approval ? approval.status : "resolved";
    return (
      <div className={"approval-card trace-approval" + (status === "pending" ? "" : " approval-card-resolved")}>
        <div className="approval-head">
          <span className="msg-glyph">✋</span>
          <span className="approval-title">Approval requested</span>
          <span className={"approval-status approval-status-" + status}>{status}</span>
          <ChannelChip label={channelLabel} />
          {time}
        </div>
        <div className="approval-body">
          <div className="approval-line">
            <AuthorName message={message} onSelectAgent={onSelectAgent} />
            <span className="muted">
              {" "}
              {approval?.capability ? (
                <>
                  asks for <code>{approval.capability.action}</code> on <code>{approval.capability.resource}</code>
                </>
              ) : (
                <>wants to create {approval?.payload ? <strong>{approval.payload.name}</strong> : "a new principal"}</>
              )}
            </span>
          </div>
          {message.content ? <LongContent content={message.content} /> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={"msg trace-msg" + (message.authorKind === "user" ? " msg-user" : "") + (isRoot ? " trace-msg-root" : "")}>
      <Avatar name={message.authorName} kind={message.authorKind} size="sm" />
      <div className="msg-body">
        <div className="msg-head">
          <AuthorName message={message} onSelectAgent={onSelectAgent} />
          {message.authorKind === "session" ? <Tag tone="purple">session</Tag> : null}
          {isRoot ? <Tag tone="muted">root</Tag> : null}
          <ChannelChip label={channelLabel} />
          {time}
        </div>
        <LongContent content={message.content} />
      </div>
    </div>
  );
}

const EVENT_GLYPH: Record<RunEventType, string> = {
  command_execution: "$",
  mcp_tool_call: "⚙",
  file_change: "✎",
  web_search: "⌕",
  reasoning: "…",
};

function RunItem({
  run,
  decisions,
  now,
  lookups,
  onSelectAgent,
  onOpenRun,
}: {
  run: AgentRun;
  decisions: Decision[];
  now: number;
  lookups: Lookups;
  onSelectAgent: (id: string) => void;
  onOpenRun: (agentId: string, runId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const name = lookups.agentName(run.agentId);
  const channelLabel = lookups.channelLabel(run.channelId);
  const started = ms(run.startedAt ?? run.createdAt);
  const active = run.status === "running" || run.status === "queued";
  let timing: string;
  if (run.status === "queued") timing = "queued";
  else if (run.status === "running") timing = "running for " + formatDuration(now - started);
  else if (run.completedAt) timing = run.status + " in " + formatDuration(ms(run.completedAt) - started);
  else timing = run.status;
  const detailCount = run.events.length + decisions.length;

  return (
    <div className={"trace-run" + (active ? " trace-run-active" : "") + (run.status === "failed" ? " trace-run-failed" : "")}>
      <div className="trace-run-head">
        <button
          type="button"
          className="trace-run-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? "Hide events and decisions" : "Show events and decisions"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <button
          type="button"
          className="trace-run-title"
          onClick={() => onOpenRun(run.agentId, run.id)}
          title="Open this run in the inspector"
        >
          <span className="trace-run-play">▶</span>
          <strong>{name}</strong> run
          {channelLabel ? (
            <>
              <span className="muted"> · woke in </span>
              <span className="trace-chip">{channelLabel}</span>
            </>
          ) : null}
          <span className="muted"> · {timing}</span>
        </button>
        <StatusPill status={run.status} />
        <span className="muted small trace-run-count">
          {run.events.length} {run.events.length === 1 ? "event" : "events"}
          {decisions.length > 0 ? " · " + decisions.length + (decisions.length === 1 ? " decision" : " decisions") : ""}
        </span>
        <time className="msg-time" dateTime={run.startedAt ?? run.createdAt} title={fullTime(run.startedAt ?? run.createdAt)}>
          {clockTime(run.startedAt ?? run.createdAt)}
        </time>
      </div>
      {run.error ? <div className="error-note small trace-run-error">{run.error}</div> : null}
      {expanded ? (
        <div className="trace-run-detail">
          {detailCount === 0 ? (
            <div className="muted small">No events or decisions recorded for this run.</div>
          ) : null}
          {run.events.length > 0 ? (
            <ol className="timeline">
              {run.events.map((event) => (
                <RunEventRow key={event.id} event={event} />
              ))}
            </ol>
          ) : null}
          {decisions.length > 0 ? (
            <ul className="decision-list trace-decisions">
              {decisions.map((d) => (
                <li key={d.id} className={"decision decision-" + d.effect}>
                  <DecisionBody decision={d} onSelectAgent={onSelectAgent} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RunEventRow({ event }: { event: RunEvent }) {
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
          <span title={fullTime(event.createdAt)}>· {clockTime(event.createdAt)}</span>
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

function DecisionBody({ decision, onSelectAgent }: { decision: Decision; onSelectAgent?: (id: string) => void }) {
  return (
    <>
      <div className="decision-head">
        <EffectBadge effect={decision.effect} />
        {onSelectAgent ? (
          <button type="button" className="link-btn" onClick={() => onSelectAgent(decision.agentId)}>
            {decision.agentName}
          </button>
        ) : (
          <span className="decision-agent">{decision.agentName}</span>
        )}
        <code className="decision-action">{decision.action}</code>
        <span className="muted">→</span>
        <code className="decision-resource">{decision.resource}</code>
      </div>
      <div className="decision-meta muted small">
        <span>{decision.tool}</span>
        <span>· {decision.source}</span>
        <span title={fullTime(decision.createdAt)}>· {clockTime(decision.createdAt)}</span>
      </div>
      {decision.reason ? <div className="decision-reason small">{decision.reason}</div> : null}
    </>
  );
}

/** A decision that could not be attached to any run in the trace. */
function DecisionItem({ decision }: { decision: Decision }) {
  return (
    <div className={"decision trace-decision-loose decision-" + decision.effect}>
      <DecisionBody decision={decision} />
    </div>
  );
}

/** Message content with a "show more" fold once it gets long. */
function LongContent({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const long = content.length > LONG_CONTENT;
  const rendered = open || !long ? content : truncate(content, LONG_CONTENT);
  return (
    <>
      <MessageContent content={rendered} />
      {long ? (
        <button type="button" className="link-btn small trace-more" onClick={() => setOpen((v) => !v)}>
          {open ? "show less" : "show more"}
        </button>
      ) : null}
    </>
  );
}
