import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, ApiError } from "../api";
import type {
  ApprovalDecision, Agent, ApprovalRequest, Channel, ChannelMessage, Overview } from "../types";
import { Avatar, clockTime, EmptyState, ErrorNote, fullTime, MessageContent, Spinner, Tag, useNow } from "./ui";

interface ChannelViewProps {
  channel: Channel | null;
  overview: Overview | null;
  onSelectAgent: (agentId: string) => void;
  onOpenRun: (agentId: string, runId: string) => void;
  onOpenTrace: (messageId: string) => void;
  onResolveApproval: (approvalId: string, decision: ApprovalDecision) => Promise<void>;
}

const POLL_MS = 1500;

interface MentionMatch {
  start: number;
  end: number;
  query: string;
}

function mentionAtCaret(value: string, caret: number): MentionMatch | null {
  const beforeCaret = value.slice(0, caret);
  const match = /(?:^|\s)@([a-zA-Z0-9/_-]*)$/.exec(beforeCaret);
  if (!match) return null;
  const token = match[1] ?? "";
  return { start: caret - token.length - 1, end: caret, query: token.toLowerCase() };
}

function mentionSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9/_-]+/g, "-");
}

function typingLabel(names: string[]): string {
  if (names.length === 1) return names[0] + " is typing";
  if (names.length === 2) return names[0] + " and " + names[1] + " are typing";
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1] + " are typing";
}

export default function ChannelView({
  channel,
  overview,
  onSelectAgent,
  onOpenRun,
  onOpenTrace,
  onResolveApproval,
}: ChannelViewProps) {
  const channelId = channel?.id ?? null;
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [mention, setMention] = useState<MentionMatch | null>(null);
  const [activeMention, setActiveMention] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottom = useRef(true);
  const lastMessageId = useRef<string | null>(null);
  const now = useNow(30000);

  // Reset when the channel changes.
  useEffect(() => {
    setMessages([]);
    setError(null);
    setSendError(null);
    setMention(null);
    setLoading(Boolean(channelId));
    stickToBottom.current = true;
    lastMessageId.current = null;
  }, [channelId]);

  // Poll messages for the open channel.
  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { messages: next } = await api.messages(channelId, 200);
        if (cancelled) return;
        setMessages(next);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return;
        setError(err instanceof Error ? err.message : "Failed to load messages");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [channelId]);

  // Auto-scroll when new messages arrive, unless the user scrolled up.
  useEffect(() => {
    const last = messages.length > 0 ? messages[messages.length - 1].id : null;
    if (last === lastMessageId.current) return;
    lastMessageId.current = last;
    const el = listRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance < 48;
  }, []);

  const send = async () => {
    const content = draft.trim();
    if (!content || !channelId || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const { message } = await api.sendMessage(channelId, content);
      setDraft("");
      setMention(null);
      stickToBottom.current = true;
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  };

  const agents = overview?.agents ?? [];
  const callableAgents = channel
    ? channel.memberIds
        .map((id) => agents.find((agent) => agent.id === id))
        .filter((agent): agent is Agent => agent !== undefined && agent.status !== "stopped" && agent.status !== "closed")
    : [];
  const mentionOptions = [
    { id: "everyone", name: "everyone", token: "everyone", detail: "Notify all available members" },
    ...callableAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      token: mentionSlug(agent.name),
      detail: agent.kind === "session" ? "Session" : "Agent",
    })),
  ].filter((option) => !mention || option.name.toLowerCase().includes(mention.query) || option.token.includes(mention.query));

  const updateMention = (value: string, caret: number) => {
    setMention(mentionAtCaret(value, caret));
    setActiveMention(0);
  };

  const insertMention = (token: string) => {
    if (!mention) return;
    const next = draft.slice(0, mention.start) + "@" + token + " " + draft.slice(mention.end);
    const caret = mention.start + token.length + 2;
    setDraft(next);
    setMention(null);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(caret, caret);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mentionOptions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveMention((current) => (current + direction + mentionOptions.length) % mentionOptions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMention(mentionOptions[activeMention]?.token ?? mentionOptions[0].token);
        return;
      }
    }
    if (mention && event.key === "Escape") {
      event.preventDefault();
      setMention(null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const members = channel
    ? channel.memberIds.map((id) => {
        if (id === "user") return { id, name: overview?.user.name ?? "You", kind: "user" as const };
        const agent = agents.find((a) => a.id === id);
        return agent
          ? { id, name: agent.name, kind: agent.kind }
          : { id, name: id, kind: "principal" as const };
      })
    : [];
  const typingNames = [...new Set(
    (overview?.typing ?? [])
      .filter((entry) => entry.channelId === channelId)
      .map((entry) => agents.find((agent) => agent.id === entry.agentId)?.name)
      .filter((name): name is string => name !== undefined),
  )];

  if (!channel) {
    return (
      <main className="main">
        <EmptyState
          title="No channel selected"
          hint="Pick a channel from the sidebar, or click an agent to open a direct message."
        />
      </main>
    );
  }

  const isDm = channel.kind === "dm";
  const dmAgent = isDm ? agents.find((a) => a.dmChannelId === channel.id) ?? null : null;
  const title = dmAgent ? dmAgent.name : channel.name;

  return (
    <main className="main">
      <header className="channel-head">
        <div className="channel-head-main">
          <h1 className="channel-title">
            {isDm ? <span className="channel-kind">DM</span> : <span className="channel-hash">#</span>}
            {title}
          </h1>
          {channel.description ? <p className="channel-desc">{channel.description}</p> : null}
        </div>
        <div className="channel-members" title={members.map((m) => m.name).join(", ")}>
          <div className="avatar-stack">
            {members.slice(0, 6).map((m) => (
              <Avatar key={m.id} name={m.name} kind={m.kind} size="sm" />
            ))}
          </div>
          <span className="muted small">
            {members.length} {members.length === 1 ? "member" : "members"}
          </span>
        </div>
      </header>

      <div className="message-list" ref={listRef} onScroll={onScroll}>
        {loading && messages.length === 0 ? (
          <div className="message-loading">
            <Spinner label="Loading messages…" />
          </div>
        ) : null}
        {!loading && messages.length === 0 && !error ? (
          <EmptyState
            title={isDm ? "Start the conversation" : "Nothing here yet"}
            hint={
              isDm
                ? "Messages you send here go straight to " + title + "."
                : "Messages posted by agents and by you will show up in order."
            }
          />
        ) : null}
        <ErrorNote message={error} />
        {/* Lost-race notices stay in the audit log, run cards and trace view; the channel shows only the outcome. */}
        {messages.filter((message) => message.kind !== "conflict").map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            agents={agents}
            overview={overview}
            now={now}
            onSelectAgent={onSelectAgent}
            onOpenRun={onOpenRun}
            onOpenTrace={onOpenTrace}
            onResolveApproval={onResolveApproval}
          />
        ))}
      </div>

      <div className="composer">
        <div className="typing-indicator-slot">
          {typingNames.length > 0 ? (
            <div className="typing-indicator" role="status" aria-live="polite">
              <span>{typingLabel(typingNames)}</span>
              <span className="typing-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </div>
          ) : null}
        </div>
        <div className="composer-input-wrap">
          {mention ? (
            <div className="mention-menu" role="listbox" aria-label="People you can mention">
              {mentionOptions.length === 0 ? (
                <div className="mention-empty">No matching people</div>
              ) : (
                mentionOptions.map((option, index) => (
                  <button
                    key={option.id}
                    type="button"
                    className={"mention-option" + (index === activeMention ? " mention-option-active" : "")}
                    role="option"
                    aria-selected={index === activeMention}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      insertMention(option.token);
                    }}
                    onMouseEnter={() => setActiveMention(index)}
                  >
                    <Avatar name={option.name} kind={option.id === "everyone" ? "user" : callableAgents.find((agent) => agent.id === option.id)?.kind ?? "principal"} size="sm" />
                    <span className="mention-option-copy">
                      <strong>@{option.token}</strong>
                      <span>{option.detail}</span>
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              updateMention(e.target.value, e.target.selectionStart);
            }}
            onClick={(e) => updateMention(e.currentTarget.value, e.currentTarget.selectionStart)}
            onKeyUp={(e) => {
              if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) return;
              updateMention(e.currentTarget.value, e.currentTarget.selectionStart);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => setMention(null)}
            placeholder={"Message " + (isDm ? title : "#" + channel.name) + " — Enter to send, Shift+Enter for a new line"}
            rows={2}
            disabled={sending}
            aria-autocomplete="list"
            aria-expanded={mention !== null}
          />
        </div>
        <div className="composer-foot">
          <span className="muted small">{sendError ? <span className="text-red">{sendError}</span> : "Posting as you"}</span>
          <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={sending || !draft.trim()}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </main>
  );
}

// ---------- rows ----------

interface MessageRowProps {
  message: ChannelMessage;
  agents: Agent[];
  overview: Overview | null;
  now: number;
  onSelectAgent: (agentId: string) => void;
  onOpenRun: (agentId: string, runId: string) => void;
  onOpenTrace: (messageId: string) => void;
  onResolveApproval: (approvalId: string, decision: ApprovalDecision) => Promise<void>;
}

function MessageRow({
  message,
  agents,
  overview,
  onSelectAgent,
  onOpenRun,
  onOpenTrace,
  onResolveApproval,
}: MessageRowProps) {
  const isAgentAuthor = message.authorKind === "principal" || message.authorKind === "session";
  const authorAgent = isAgentAuthor ? agents.find((a) => a.id === message.authorId) ?? null : null;
  const time = (
    <time className="msg-time" dateTime={message.createdAt} title={fullTime(message.createdAt)}>
      {clockTime(message.createdAt)}
    </time>
  );
  const runPill =
    message.runId && isAgentAuthor ? (
      <button
        type="button"
        className="run-pill"
        title="Open this run in the inspector"
        onClick={() => onOpenRun(message.authorId, message.runId as string)}
      >
        run · {message.runId.slice(0, 8)}
      </button>
    ) : null;
  const traceButton = (
    <TraceButton always={message.authorKind === "user"} onClick={() => onOpenTrace(message.id)} />
  );

  if (message.kind === "denial") {
    return (
      <div className="msg-system msg-denial">
        <span className="msg-glyph">⛔</span>
        <div className="msg-system-body">
          <MessageContent content={message.content} />
          <div className="msg-system-meta">
            {isAgentAuthor ? (
              <AuthorButton name={message.authorName} onClick={() => onSelectAgent(message.authorId)} />
            ) : (
              <span>{message.authorName}</span>
            )}
            {runPill}
            {time}
            {traceButton}
          </div>
        </div>
      </div>
    );
  }

  if (message.kind === "spawn") {
    return (
      <div className="msg-system msg-spawn">
        <span className="msg-glyph">⑂</span>
        <div className="msg-system-body">
          <MessageContent content={message.content} />
          <div className="msg-system-meta">
            {isAgentAuthor ? (
              <AuthorButton name={message.authorName} onClick={() => onSelectAgent(message.authorId)} />
            ) : (
              <span>{message.authorName}</span>
            )}
            {runPill}
            {time}
            {traceButton}
          </div>
        </div>
      </div>
    );
  }

  if (message.kind === "system") {
    return (
      <div className="msg-notice">
        <span>{message.content}</span>
        {time}
        {traceButton}
      </div>
    );
  }

  if (message.kind === "approval") {
    const approval = message.approvalId
      ? (overview?.approvals ?? []).find((a) => a.id === message.approvalId) ?? null
      : null;
    return (
      <ApprovalCard
        message={message}
        approval={approval}
        overview={overview}
        time={time}
        traceButton={traceButton}
        onSelectAgent={onSelectAgent}
        onResolveApproval={onResolveApproval}
      />
    );
  }

  const isUser = message.authorKind === "user";
  return (
    <div className={"msg" + (isUser ? " msg-user" : "")}>
      <Avatar name={message.authorName} kind={message.authorKind} />
      <div className="msg-body">
        <div className="msg-head">
          {isAgentAuthor ? (
            <AuthorButton name={message.authorName} onClick={() => onSelectAgent(message.authorId)} />
          ) : (
            <span className="msg-author">{isUser ? "you" : message.authorName}</span>
          )}
          {message.authorKind === "session" ? <Tag tone="purple">session</Tag> : null}
          {authorAgent && authorAgent.status === "busy" ? <Tag tone="purple">busy</Tag> : null}
          {runPill}
          {time}
          {traceButton}
        </div>
        <MessageContent content={message.content} />
      </div>
    </div>
  );
}

function TraceButton({ always, onClick }: { always: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={"trace-open" + (always ? " trace-open-always" : "")}
      title="Show everything this message caused, across channels"
      onClick={onClick}
    >
      trace
    </button>
  );
}

function AuthorButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button type="button" className="msg-author msg-author-btn" onClick={onClick} title="Inspect this agent">
      {name}
    </button>
  );
}

function ApprovalCard({
  message,
  approval,
  overview,
  time,
  traceButton,
  onSelectAgent,
  onResolveApproval,
}: {
  message: ChannelMessage;
  approval: ApprovalRequest | null;
  overview: Overview | null;
  time: ReactNode;
  traceButton: ReactNode;
  onSelectAgent: (agentId: string) => void;
  onResolveApproval: (approvalId: string, decision: ApprovalDecision) => Promise<void>;
}) {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = approval !== null && approval.status === "pending";
  const statusLabel = approval ? approval.status : "resolved";
  const isCapability = approval?.kind === "capability" || (!approval && / requests [a-z]+:/.test(message.content));

  const decide = async (decision: ApprovalDecision) => {
    if (!message.approvalId) return;
    setBusy(decision);
    setError(null);
    try {
      await onResolveApproval(message.approvalId, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to " + decision);
    } finally {
      setBusy(null);
    }
  };

  const channelNames = approval?.payload
    ? approval.payload.channelIds.map((id) => {
        const channel = (overview?.channels ?? []).find((c) => c.id === id);
        return channel ? "#" + channel.name : id;
      })
    : [];
  const requesterIsAgent =
    message.authorKind === "principal" || message.authorKind === "session";

  return (
    <div className={"approval-card" + (pending ? "" : " approval-card-resolved")}>
      <div className="approval-head">
        <span className="msg-glyph">{isCapability ? "🔑" : "✋"}</span>
        <span className="approval-title">{isCapability ? "Capability requested" : "Approval requested"}</span>
        <span className={"approval-status approval-status-" + statusLabel}>{statusLabel}</span>
        {time}
        {traceButton}
      </div>
      <div className="approval-body">
        <div className="approval-line">
          {requesterIsAgent ? (
            <AuthorButton name={message.authorName} onClick={() => onSelectAgent(message.authorId)} />
          ) : (
            <span className="msg-author">{message.authorName}</span>
          )}
          <span className="muted">{isCapability ? " asks for a capability" : " wants to create a new principal"}</span>
        </div>
        {approval?.capability ? (
          <dl className="approval-facts">
            <dt>Action</dt>
            <dd>
              <code>{approval.capability.action}</code>
              <span className="muted"> on </span>
              <code>{approval.capability.resource}</code>
            </dd>
            <dt>Why</dt>
            <dd>{approval.capability.reason}</dd>
          </dl>
        ) : null}
        {approval?.payload ? (
          <dl className="approval-facts">
            <dt>Name</dt>
            <dd>{approval.payload.name}</dd>
            {approval.payload.description ? (
              <>
                <dt>About</dt>
                <dd>{approval.payload.description}</dd>
              </>
            ) : null}
            <dt>Preset</dt>
            <dd>
              <Tag tone="purple">{approval.payload.policy.preset}</Tag>
              <span className="muted small">
                {" "}
                {approval.payload.policy.statements.length} statement
                {approval.payload.policy.statements.length === 1 ? "" : "s"}
              </span>
            </dd>
            <dt>Channels</dt>
            <dd>{channelNames.length > 0 ? channelNames.join(", ") : <span className="muted">none</span>}</dd>
          </dl>
        ) : null}
        {message.content && !approval?.capability ? <MessageContent content={message.content} /> : null}
        <ErrorNote message={error} />
        {pending && isCapability ? (
          <div className="approval-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy !== null}
              onClick={() => void decide("allow_once")}
              title="Grant it for the agent's next turn only"
            >
              {busy === "allow_once" ? "Allowing…" : "Allow once"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => void decide("allow_forever")}
              title="Add it to the agent's policy"
            >
              {busy === "allow_forever" ? "Allowing…" : "Allow forever"}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busy !== null}
              onClick={() => void decide("deny")}
            >
              {busy === "deny" ? "Denying…" : "Deny"}
            </button>
          </div>
        ) : pending ? (
          <div className="approval-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy !== null}
              onClick={() => void decide("approve")}
            >
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busy !== null}
              onClick={() => void decide("deny")}
            >
              {busy === "deny" ? "Denying…" : "Deny"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
