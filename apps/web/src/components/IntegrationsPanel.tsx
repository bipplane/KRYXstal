import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import type { Integration, IntegrationAuth, IntegrationInput, IntegrationKind } from "../types";
import { ErrorNote, fullTime, Modal, relativeTime, StatusPill, Tag, useNow } from "./ui";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

interface IntegrationsPanelProps {
  integrations: Integration[];
  onClose: () => void;
  /** Re-fetches the overview so the list reflects the server after each action. */
  onRefresh: () => Promise<void>;
}

export default function IntegrationsPanel({ integrations, onClose, onRefresh }: IntegrationsPanelProps) {
  const now = useNow(10000);
  const [adding, setAdding] = useState(integrations.length === 0);

  return (
    <Modal title="Integrations" onClose={onClose} width={720}>
      <div className="integ-panel">
        <p className="muted small integ-intro">
          External MCP servers your agents may call. Log in once here; each tool becomes an action named{" "}
          <code>mcp:&lt;integration&gt;:&lt;tool&gt;</code> that you grant per agent in its policy.
        </p>

        {integrations.length === 0 ? (
          <div className="integ-empty muted small">No integrations yet. Add one below.</div>
        ) : (
          <ul className="integ-list">
            {integrations.map((integration) => (
              <IntegrationRow key={integration.id} integration={integration} now={now} onRefresh={onRefresh} />
            ))}
          </ul>
        )}

        <div className="integ-add">
          <div className="field-label-row">
            <span className="field-label">Add integration</span>
            <button type="button" className="link-btn" onClick={() => setAdding((v) => !v)}>
              {adding ? "hide" : "+ Add integration"}
            </button>
          </div>
          {adding ? (
            <AddIntegrationForm
              onCreated={async () => {
                setAdding(false);
                await onRefresh();
              }}
            />
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

// ---------- one integration ----------

type RowBusy = "login" | "logout" | "discover" | "remove" | null;
type RowConfirm = "disconnect" | "remove" | null;

function IntegrationRow({
  integration,
  now,
  onRefresh,
}: {
  integration: Integration;
  now: number;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<RowBusy>(null);
  const [confirm, setConfirm] = useState<RowConfirm>(null);
  const [error, setError] = useState<string | null>(null);
  const [loginHint, setLoginHint] = useState(false);

  // The OAuth flow finishes in another tab; the polled status tells us when it lands.
  useEffect(() => {
    if (integration.status === "connected" || integration.status === "error") setLoginHint(false);
  }, [integration.status]);

  const run = async (kind: Exclude<RowBusy, null>, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      setConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const connect = () =>
    run("login", async () => {
      const { url } = await api.integrationLogin(integration.id);
      window.open(url, "_blank", "noopener");
      setLoginHint(true);
      await onRefresh();
    });
  const disconnect = () =>
    run("logout", async () => {
      await api.integrationLogout(integration.id);
      await onRefresh();
    });
  const discover = () =>
    run("discover", async () => {
      await api.discoverIntegration(integration.id);
      await onRefresh();
    });
  const remove = () =>
    run("remove", async () => {
      await api.deleteIntegration(integration.id);
      await onRefresh();
    });

  const isOauth = integration.auth === "oauth";
  const connected = integration.status === "connected";
  const connecting = integration.status === "connecting";
  const canConnect = isOauth && !connected && !connecting;
  const target = integration.kind === "http" ? integration.url : [integration.command, ...integration.args].filter(Boolean).join(" ");

  return (
    <li className={"integ-row integ-row-" + integration.status}>
      <div className="integ-head">
        <button type="button" className="integ-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="section-chevron">{open ? "▾" : "▸"}</span>
          <span className="integ-name">{integration.name}</span>
        </button>
        <Tag>{integration.kind}</Tag>
        <Tag tone={isOauth ? "purple" : "muted"}>{integration.auth}</Tag>
        <StatusPill status={integration.status} />
        <span className="muted small integ-meta">
          {integration.tools.length} tool{integration.tools.length === 1 ? "" : "s"}
          {integration.connectedAt ? (
            <span title={fullTime(integration.connectedAt)}> · connected {relativeTime(integration.connectedAt, now)}</span>
          ) : null}
        </span>
      </div>

      {target ? (
        <div className="integ-target muted small" title={target}>
          <code>{target}</code>
        </div>
      ) : null}

      {integration.status === "error" && integration.lastError ? (
        <div className="error-note small">{integration.lastError}</div>
      ) : null}

      {loginHint || connecting ? (
        <div className="integ-hint small">Finish authorising in the browser tab — this updates automatically.</div>
      ) : null}

      <div className="integ-actions">
        {canConnect ? (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void connect()}>
            {busy === "login" ? "Opening…" : integration.status === "error" ? "Retry connect" : "Connect"}
          </button>
        ) : null}
        {isOauth && connected ? (
          confirm === "disconnect" ? (
            <span className="confirm-inline">
              <span>Disconnect {integration.name}?</span>
              <button type="button" className="btn btn-danger btn-sm" disabled={busy !== null} onClick={() => void disconnect()}>
                {busy === "logout" ? "Disconnecting…" : "Confirm"}
              </button>
              <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setConfirm("disconnect")}>
              Disconnect
            </button>
          )
        ) : null}
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void discover()}>
          {busy === "discover" ? "Refreshing…" : "Refresh tools"}
        </button>
        {confirm === "remove" ? (
          <span className="confirm-inline">
            <span>Remove {integration.name}?</span>
            <button type="button" className="btn btn-danger btn-sm" disabled={busy !== null} onClick={() => void remove()}>
              {busy === "remove" ? "Removing…" : "Confirm"}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="btn btn-sm btn-danger-ghost" disabled={busy !== null} onClick={() => setConfirm("remove")}>
            Remove
          </button>
        )}
      </div>
      <ErrorNote message={error} />

      {open ? (
        integration.tools.length === 0 ? (
          <div className="muted small integ-tools-empty">
            No tools discovered yet{isOauth && !connected ? " — connect first" : " — try “Refresh tools”"}.
          </div>
        ) : (
          <ul className="integ-tools">
            {integration.tools.map((tool) => (
              <li key={tool.name} className="integ-tool">
                <div className="integ-tool-head">
                  <code>{tool.name}</code>
                  {tool.readOnly ? <Tag>read-only</Tag> : null}
                </div>
                {tool.description ? <div className="muted small integ-tool-desc">{tool.description}</div> : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </li>
  );
}

// ---------- add form ----------

function AddIntegrationForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<IntegrationKind>("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [auth, setAuth] = useState<IntegrationAuth>("oauth");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveAuth: IntegrationAuth = kind === "stdio" ? "none" : auth;
  const nameValid = NAME_RE.test(name.trim());
  const targetValid = kind === "http" ? url.trim().length > 0 : command.trim().length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!nameValid) {
      setError("Name must be a slug: lowercase letters, digits and dashes.");
      return;
    }
    if (!targetValid) {
      setError(kind === "http" ? "URL is required." : "Command is required.");
      return;
    }
    const input: IntegrationInput =
      kind === "http"
        ? { name: name.trim(), kind, url: url.trim(), auth: effectiveAuth }
        : {
            name: name.trim(),
            kind,
            command: command.trim(),
            args: args.split(/\s+/).map((a) => a.trim()).filter(Boolean),
            auth: "none",
          };
    setBusy(true);
    setError(null);
    try {
      await api.createIntegration(input);
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add integration");
      setBusy(false);
    }
  };

  return (
    <form className="form integ-form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">
          Name <span className="req">*</span>
        </span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          placeholder="linear"
          maxLength={64}
          pattern="[a-z0-9][a-z0-9-]*"
        />
        <span className="muted small">Used as the MCP server name and in action names: <code>mcp:{name.trim() || "<name>"}:*</code></span>
      </label>

      <div className="integ-form-grid">
        <div className="field">
          <span className="field-label">Kind</span>
          <div className="integ-radios">
            {(["http", "stdio"] as const).map((k) => (
              <label key={k} className={"integ-radio" + (kind === k ? " integ-radio-active" : "")}>
                <input type="radio" name="integ-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                <code>{k}</code>
                <span className="muted small">{k === "http" ? "remote server (URL)" : "local process"}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label">Auth</span>
          <div className="integ-radios">
            {(["oauth", "none"] as const).map((a) => (
              <label key={a} className={"integ-radio" + (effectiveAuth === a ? " integ-radio-active" : "") + (kind === "stdio" ? " integ-radio-disabled" : "")}>
                <input
                  type="radio"
                  name="integ-auth"
                  value={a}
                  checked={effectiveAuth === a}
                  disabled={kind === "stdio"}
                  onChange={() => setAuth(a)}
                />
                <code>{a}</code>
                <span className="muted small">{a === "oauth" ? "log in once in the browser" : "no login"}</span>
              </label>
            ))}
          </div>
          {kind === "stdio" ? <span className="muted small">Local processes don’t use OAuth.</span> : null}
        </div>
      </div>

      {kind === "http" ? (
        <label className="field">
          <span className="field-label">
            URL <span className="req">*</span>
          </span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.linear.app/mcp" inputMode="url" />
        </label>
      ) : (
        <div className="integ-form-grid">
          <label className="field">
            <span className="field-label">
              Command <span className="req">*</span>
            </span>
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
          </label>
          <label className="field">
            <span className="field-label">Args</span>
            <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-github" />
            <span className="muted small">Space-separated.</span>
          </label>
        </div>
      )}

      <ErrorNote message={error} />
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !nameValid || !targetValid}>
          {busy ? "Adding…" : "Add integration"}
        </button>
      </div>
    </form>
  );
}
