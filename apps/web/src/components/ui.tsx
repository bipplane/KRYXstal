import { useEffect, useState, type ReactNode } from "react";
import type { AgentStatus, AuthorKind, Effect, RunStatus } from "../types";

// ---------- time helpers ----------

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Math.max(0, now - then);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 7) return d + "d ago";
  return new Date(iso).toLocaleDateString();
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function fullTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

/** Re-renders the caller on an interval so relative timestamps stay fresh. */
export function useNow(intervalMs = 15000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.charAt(0).toUpperCase();
}

export function truncate(text: string, max = 160): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "…";
}

// ---------- primitives ----------

export function StatusPill({ status }: { status: AgentStatus | RunStatus }) {
  return (
    <span className={"pill pill-" + status}>
      <span className="pill-dot" />
      {status}
    </span>
  );
}

export function EffectBadge({ effect }: { effect: Effect }) {
  return <span className={"effect effect-" + effect}>{effect}</span>;
}

export function Tag({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "purple" | "red" }) {
  return <span className={"tag tag-" + tone}>{children}</span>;
}

export function Avatar({
  name,
  kind = "principal",
  size = "md",
}: {
  name: string;
  kind?: AuthorKind | "principal" | "session";
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span className={"avatar avatar-" + size + " avatar-" + kind} title={name} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={"status-dot status-dot-" + status} title={status} />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" />
      {label ? <span className="spinner-label">{label}</span> : null}
    </span>
  );
}

export function EmptyState({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {children}
    </div>
  );
}

export function Section({
  title,
  count,
  open,
  defaultOpen = false,
  onToggle,
  children,
  actions,
}: {
  title: string;
  count?: number;
  /** Controlled open state; falls back to internal state when undefined. */
  open?: boolean;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = open ?? internalOpen;
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setInternalOpen(next);
    onToggle?.(next);
  };
  return (
    <section className={"section" + (isOpen ? " section-open" : "")}>
      <header className="section-head">
        <button type="button" className="section-toggle" onClick={toggle} aria-expanded={isOpen}>
          <span className="section-chevron">{isOpen ? "▾" : "▸"}</span>
          <span className="section-title">{title}</span>
          {count !== undefined ? <span className="section-count">{count}</span> : null}
        </button>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </header>
      {isOpen ? <div className="section-body">{children}</div> : null}
    </section>
  );
}

export function Modal({
  title,
  onClose,
  children,
  width = 640,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        style={{ width: "min(" + width + "px, 100%)" }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="error-note" role="alert">
      {message}
    </div>
  );
}

// ---------- message content (newlines + fenced code, no markdown lib) ----------

const FENCE = /```([^\n`]*)\n?([\s\S]*?)```/g;

export function MessageContent({ content }: { content: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of content.matchAll(FENCE)) {
    const start = match.index ?? 0;
    if (start > last) {
      parts.push(
        <p key={"t" + index++} className="msg-text">
          {content.slice(last, start)}
        </p>,
      );
    }
    const lang = match[1].trim();
    parts.push(
      <pre key={"c" + index++} className="msg-code" data-lang={lang || undefined}>
        <code>{match[2].replace(/\n$/, "")}</code>
      </pre>,
    );
    last = start + match[0].length;
  }
  if (last < content.length) {
    parts.push(
      <p key={"t" + index++} className="msg-text">
        {content.slice(last)}
      </p>,
    );
  }
  if (parts.length === 0) return null;
  return <div className="msg-content">{parts}</div>;
}
