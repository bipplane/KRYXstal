import { useEffect, useMemo, useState } from "react";
import {
  ACTIONS,
  type Agent,
  type AgentInput,
  type Channel,
  type Effect,
  type Integration,
  type Policy,
  type PolicyPreset,
  type PolicyPresets,
  type Statement,
} from "../types";
import { globMatch, isMcpAction, isUsableIntegration, mcpAction, mcpAll, toolAccess } from "../mcp";
import { ErrorNote, Modal, Tag } from "./ui";

type PresetName = Exclude<PolicyPreset, "custom">;

const PRESET_ORDER: PresetName[] = ["reader", "worker", "deployer", "admin"];

const PRESET_BLURB: Record<PresetName, string> = {
  reader: "Read-only observer: can read its channels, nothing else.",
  worker: "Reads and posts in channels, runs commands and edits files in its workspace.",
  deployer: "Everything a worker does, plus network access for deploy-style commands.",
  admin: "Wide open: can spawn sessions, create channels and request new principals.",
};

interface StatementRow {
  key: number;
  effect: Effect;
  actions: string;
  resources: string;
}

interface AgentWizardProps {
  mode: "create" | "edit";
  agent?: Agent;
  presets: PolicyPresets | null;
  channels: Channel[];
  integrations: Integration[];
  initialChannelIds: string[];
  onClose: () => void;
  onSubmit: (input: AgentInput) => Promise<void>;
}

let rowSeq = 0;
const nextKey = () => ++rowSeq;

function toRows(statements: Statement[]): StatementRow[] {
  return statements.map((s) => ({
    key: nextKey(),
    effect: s.effect,
    actions: s.actions.join(", "),
    resources: s.resources.join(", "),
  }));
}

function splitList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function fromRows(rows: StatementRow[]): Statement[] {
  return rows
    .map((r) => ({ effect: r.effect, actions: splitList(r.actions), resources: splitList(r.resources) }))
    .filter((s) => s.actions.length > 0 || s.resources.length > 0);
}

// ---------- integration tools <-> statement rows ----------

/** The allow-row action pattern that grants `action` on resource `*`, if any. */
function grantedBy(rows: StatementRow[], action: string): string | null {
  for (const row of rows) {
    if (row.effect !== "allow") continue;
    if (!splitList(row.resources).some((r) => globMatch(r, "*"))) continue;
    const hit = splitList(row.actions).find((pattern) => globMatch(pattern, action));
    if (hit) return hit;
  }
  return null;
}

/** Drops the exact actions from every allow row; rows we empty out are removed. */
function withoutActions(rows: StatementRow[], actions: Set<string>): StatementRow[] {
  const next: StatementRow[] = [];
  for (const row of rows) {
    if (row.effect !== "allow") {
      next.push(row);
      continue;
    }
    const before = splitList(row.actions);
    const kept = before.filter((a) => !actions.has(a));
    if (kept.length === before.length) next.push(row);
    else if (kept.length > 0) next.push({ ...row, actions: kept.join(", ") });
  }
  return next;
}

/** Adds actions to the mcp-only allow row on `*`, creating it when there is none. */
function withActions(rows: StatementRow[], actions: string[]): StatementRow[] {
  const index = rows.findIndex((row) => {
    if (row.effect !== "allow" || splitList(row.resources).join(",") !== "*") return false;
    const existing = splitList(row.actions);
    return existing.length > 0 && existing.every(isMcpAction);
  });
  if (index < 0) {
    return [...rows, { key: nextKey(), effect: "allow", actions: actions.join(", "), resources: "*" }];
  }
  const existing = splitList(rows[index].actions);
  const merged = [...existing, ...actions.filter((a) => !existing.includes(a))];
  return rows.map((row, i) => (i === index ? { ...row, actions: merged.join(", ") } : row));
}

export default function AgentWizard({
  mode,
  agent,
  presets,
  channels,
  integrations,
  initialChannelIds,
  onClose,
  onSubmit,
}: AgentWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [preset, setPreset] = useState<PolicyPreset>(agent?.policy.preset ?? "worker");
  const [rows, setRows] = useState<StatementRow[]>(() => toRows(agent?.policy.statements ?? []));
  const [delegable, setDelegable] = useState<string[]>(agent?.policy.delegable ?? []);
  const [advanced, setAdvanced] = useState(agent?.policy.preset === "custom");
  const [channelIds, setChannelIds] = useState<string[]>(initialChannelIds);
  const [presetSeeded, setPresetSeeded] = useState(mode === "edit");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // For a new agent, seed the form from the default preset once presets arrive.
  useEffect(() => {
    if (presetSeeded || !presets) return;
    const initial = presets.presets[preset === "custom" ? "worker" : preset];
    if (initial) {
      setRows(toRows(initial.statements));
      setDelegable([...initial.delegable]);
    }
    setPresetSeeded(true);
  }, [presets, preset, presetSeeded]);

  const actionOptions = useMemo<string[]>(() => {
    const base = presets?.actions?.length ? [...presets.actions] : [...ACTIONS];
    return ["*", ...base.filter((a) => a !== "*")];
  }, [presets]);

  const applyPreset = (target: PresetName) => {
    setPreset(target);
    const policy: Policy | undefined = presets?.presets[target];
    if (policy) {
      setRows(toRows(policy.statements));
      setDelegable([...policy.delegable]);
    }
  };

  const markCustom = () => setPreset("custom");

  const updateRow = (key: number, patch: Partial<Omit<StatementRow, "key">>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    markCustom();
  };
  const removeRow = (key: number) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
    markCustom();
  };
  const addRow = () => {
    setRows((prev) => [...prev, { key: nextKey(), effect: "allow", actions: "", resources: "" }]);
    markCustom();
  };
  const toggleDelegable = (action: string) => {
    setDelegable((prev) => (prev.includes(action) ? prev.filter((a) => a !== action) : [...prev, action]));
    markCustom();
  };
  const toggleChannel = (id: string) => {
    setChannelIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  };

  // Integration tool checkboxes are a view over the statement rows, so they stay in sync with the table.
  const usableIntegrations = integrations.filter(isUsableIntegration);
  const statements = useMemo(() => fromRows(rows), [rows]);

  const toggleTool = (integration: Integration, tool: string) => {
    const action = mcpAction(integration.name, tool);
    const all = mcpAll(integration.name);
    setRows((prev) => {
      const by = grantedBy(prev, action);
      if (by === action) return withoutActions(prev, new Set([action]));
      if (by === all) {
        // Expand the wildcard into the remaining tools so only this one is dropped.
        const others = integration.tools.filter((t) => t.name !== tool).map((t) => mcpAction(integration.name, t.name));
        const next = withoutActions(prev, new Set([all]));
        return others.length > 0 ? withActions(next, others) : next;
      }
      if (by) return prev; // granted by a broader pattern: edit that statement instead
      return withActions(prev, [action]);
    });
    markCustom();
  };

  const toggleAllTools = (integration: Integration) => {
    const all = mcpAll(integration.name);
    const toolActions = integration.tools.map((t) => mcpAction(integration.name, t.name));
    setRows((prev) => {
      const by = grantedBy(prev, all);
      const explicitAll = prev.some((r) => r.effect === "allow" && splitList(r.actions).includes(all));
      const everyTool = toolActions.length > 0 && toolActions.every((a) => grantedBy(prev, a) === a);
      if (explicitAll || everyTool) return withoutActions(prev, new Set([all, ...toolActions]));
      if (by) return prev; // granted by a broader pattern
      return withActions(withoutActions(prev, new Set(toolActions)), [all]);
    });
    markCustom();
  };

  const mcpGrants = rows
    .filter((row) => splitList(row.actions).some(isMcpAction))
    .map((row) => ({ key: row.key, effect: row.effect, actions: splitList(row.actions).filter(isMcpAction), resources: row.resources }));

  const nameValid = name.trim().length > 0;

  const submit = async () => {
    if (!nameValid) {
      setStep(1);
      setError("Name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    const input: AgentInput = {
      name: name.trim(),
      description: description.trim(),
      instructions,
      policy: { preset, statements: fromRows(rows), delegable },
      channelIds,
    };
    try {
      await onSubmit(input);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
      setBusy(false);
    }
  };

  const selectedChannels = channels.filter((c) => channelIds.includes(c.id));

  const footer = (
    <>
      <div className="wizard-foot-left">
        {step > 1 ? (
          <button type="button" className="btn" disabled={busy} onClick={() => setStep((s) => (s === 3 ? 2 : 1))}>
            Back
          </button>
        ) : null}
      </div>
      <div className="wizard-foot-right">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        {step < 3 ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={step === 1 && !nameValid}
            onClick={() => {
              setError(null);
              setStep((s) => (s === 1 ? 2 : 3));
            }}
          >
            Next
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy || !nameValid} onClick={() => void submit()}>
            {busy ? "Saving…" : mode === "create" ? "Create agent" : "Save changes"}
          </button>
        )}
      </div>
    </>
  );

  return (
    <Modal title={mode === "create" ? "New agent" : "Edit " + (agent?.name ?? "agent")} onClose={onClose} width={720} footer={footer}>
      <ol className="steps">
        {(["Identity", "Policy", "Channels"] as const).map((label, i) => {
          const n = (i + 1) as 1 | 2 | 3;
          const state = n === step ? "current" : n < step ? "done" : "todo";
          return (
            <li key={label} className={"step step-" + state}>
              <button
                type="button"
                className="step-btn"
                disabled={n > 1 && !nameValid}
                onClick={() => setStep(n)}
              >
                <span className="step-num">{state === "done" ? "✓" : n}</span>
                <span>{label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <ErrorNote message={error} />

      {step === 1 ? (
        <div className="form">
          <label className="field">
            <span className="field-label">
              Name <span className="req">*</span>
            </span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="reviewer" maxLength={64} />
          </label>
          <label className="field">
            <span className="field-label">Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Reviews pull requests and reports back in #build-pipeline"
            />
          </label>
          <label className="field">
            <span className="field-label">Instructions</span>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={8}
              placeholder="System prompt for this agent. What it's responsible for, how it should behave, who it talks to."
            />
          </label>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="form">
          <div className="field">
            <span className="field-label">Preset</span>
            {!presets ? <div className="muted small">Loading presets…</div> : null}
            <div className="preset-grid">
              {PRESET_ORDER.map((p) => (
                <label key={p} className={"preset-card" + (preset === p ? " preset-card-active" : "")}>
                  <input type="radio" name="preset" value={p} checked={preset === p} onChange={() => applyPreset(p)} disabled={!presets} />
                  <span className="preset-name">{p}</span>
                  <span className="preset-blurb">{PRESET_BLURB[p]}</span>
                  {presets ? (
                    <span className="muted small">
                      {presets.presets[p].statements.length} statement{presets.presets[p].statements.length === 1 ? "" : "s"} ·{" "}
                      {presets.presets[p].delegable.length} delegable
                    </span>
                  ) : null}
                </label>
              ))}
              <label className={"preset-card preset-card-custom" + (preset === "custom" ? " preset-card-active" : "")}>
                <input type="radio" name="preset" value="custom" checked={preset === "custom"} onChange={() => setPreset("custom")} />
                <span className="preset-name">custom</span>
                <span className="preset-blurb">Hand-edited statements. Selected automatically when you change anything below.</span>
              </label>
            </div>
          </div>

          <div className="field">
            <span className="field-label">Integrations</span>
            <div className="muted small">
              Tools from connected MCP servers this agent may call. Each becomes an <code>allow</code> on{" "}
              <code>mcp:&lt;integration&gt;:&lt;tool&gt;</code>.
            </div>
            {usableIntegrations.length === 0 ? (
              <div className="grant-preview muted small">
                No connected integrations. Add and connect one from the sidebar first.
              </div>
            ) : (
              <ul className="integ-pick-list">
                {usableIntegrations.map((integration) => {
                  const all = mcpAll(integration.name);
                  const allBy = grantedBy(rows, all);
                  const allLocked = allBy !== null && allBy !== all;
                  const everyTool =
                    integration.tools.length > 0 &&
                    integration.tools.every((t) => grantedBy(rows, mcpAction(integration.name, t.name)) !== null);
                  const allChecked = allBy !== null || everyTool;
                  return (
                    <li key={integration.id} className="integ-pick">
                      <label className="check-item integ-pick-head" title={allLocked ? "Granted by " + allBy + " — edit it in the statements table" : undefined}>
                        <input type="checkbox" checked={allChecked} disabled={allLocked} onChange={() => toggleAllTools(integration)} />
                        <span className="integ-name">{integration.name}</span>
                        <Tag>{integration.kind}</Tag>
                        <span className="muted small">
                          all tools{allLocked ? " · via " : ""}
                          {allLocked ? <code>{allBy}</code> : null}
                        </span>
                      </label>
                      {integration.tools.length === 0 ? (
                        <div className="muted small integ-pick-empty">No tools discovered yet.</div>
                      ) : (
                        <ul className="check-list check-list-grid integ-pick-tools">
                          {integration.tools.map((tool) => {
                            const action = mcpAction(integration.name, tool.name);
                            const by = grantedBy(rows, action);
                            const locked = by !== null && by !== action && by !== all;
                            const denied = toolAccess(statements, integration, tool) === "deny";
                            return (
                              <li key={tool.name}>
                                <label className="check-item" title={locked ? "Granted by " + by + " — edit it in the statements table" : undefined}>
                                  <input type="checkbox" checked={by !== null} disabled={locked} onChange={() => toggleTool(integration, tool.name)} />
                                  <code>{tool.name}</code>
                                  {tool.readOnly ? <Tag>read-only</Tag> : null}
                                  {denied ? <Tag tone="red">denied</Tag> : null}
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="field">
            <label className="check-item">
              <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
              <span>Advanced — edit statements and delegable actions</span>
            </label>
          </div>

          {advanced ? (
            <>
              <div className="field">
                <div className="field-label-row">
                  <span className="field-label">Statements</span>
                  <button type="button" className="link-btn" onClick={addRow}>
                    + Add statement
                  </button>
                </div>
                <div className="table-wrap">
                  <table className="table statement-table">
                    <thead>
                      <tr>
                        <th>Effect</th>
                        <th>Actions (comma-separated)</th>
                        <th>Resources (comma-separated)</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="muted small">
                            No statements. Everything is denied by default.
                          </td>
                        </tr>
                      ) : null}
                      {rows.map((row) => (
                        <tr key={row.key} className={"row-" + row.effect}>
                          <td>
                            <select value={row.effect} onChange={(e) => updateRow(row.key, { effect: e.target.value as Effect })}>
                              <option value="allow">allow</option>
                              <option value="deny">deny</option>
                            </select>
                          </td>
                          <td>
                            <input
                              value={row.actions}
                              onChange={(e) => updateRow(row.key, { actions: e.target.value })}
                              placeholder="channel:read, shell:exec"
                              list="wizard-actions"
                            />
                          </td>
                          <td>
                            <input
                              value={row.resources}
                              onChange={(e) => updateRow(row.key, { resources: e.target.value })}
                              placeholder="channel:general, cmd:npm test, *"
                            />
                          </td>
                          <td>
                            <button type="button" className="icon-btn" onClick={() => removeRow(row.key)} aria-label="Remove statement">
                              ×
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <datalist id="wizard-actions">
                  {actionOptions.map((a) => (
                    <option key={a} value={a} />
                  ))}
                </datalist>
                <div className="muted small">
                  Resources look like <code>channel:&lt;name&gt;</code>, <code>cmd:&lt;argv prefix&gt;</code> or <code>*</code>.
                </div>
              </div>

              <div className="field">
                <span className="field-label">Delegable actions</span>
                <div className="muted small">What this agent may grant to sessions it spawns.</div>
                <ul className="check-list check-list-grid">
                  {actionOptions.map((action) => (
                    <li key={action}>
                      <label className="check-item">
                        <input type="checkbox" checked={delegable.includes(action)} onChange={() => toggleDelegable(action)} />
                        <code>{action}</code>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <div className="policy-summary">
              <div className="muted small">
                {rows.length} statement{rows.length === 1 ? "" : "s"} · {delegable.length} delegable action
                {delegable.length === 1 ? "" : "s"}
                {preset === "custom" ? " · custom" : ""}
              </div>
              <ul className="grant-list">
                {rows.map((row) => (
                  <li key={row.key} className={"grant grant-" + row.effect}>
                    <span className={"effect effect-" + row.effect}>{row.effect}</span>
                    <code>{row.actions || "—"}</code>
                    <span className="muted">on</span>
                    <code>{row.resources || "—"}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}

      {step === 3 ? (
        <div className="form">
          <div className="field">
            <span className="field-label">Channels</span>
            {channels.length === 0 ? (
              <div className="muted small">No channels exist yet. Create one from the sidebar first.</div>
            ) : (
              <ul className="check-list">
                {channels.map((channel) => (
                  <li key={channel.id}>
                    <label className="check-item">
                      <input type="checkbox" checked={channelIds.includes(channel.id)} onChange={() => toggleChannel(channel.id)} />
                      <span className="nav-hash">#</span>
                      <span>{channel.name}</span>
                      {channel.kind === "system" ? <Tag>system</Tag> : null}
                      {channel.description ? <span className="muted small">— {channel.description}</span> : null}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="field">
            <span className="field-label">Effective grants</span>
            <div className="muted small">Joining a channel grants read and post on it, in addition to the policy above.</div>
            {selectedChannels.length === 0 ? (
              <div className="grant-preview muted small">No channel grants.</div>
            ) : (
              <ul className="grant-list grant-preview">
                {selectedChannels.map((channel) => (
                  <li key={channel.id} className="grant grant-allow">
                    <span className="effect effect-allow">allow</span>
                    <code>channel:read, channel:post</code>
                    <span className="muted">on</span>
                    <code>channel:{channel.name}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="field">
            <span className="field-label">Integration tools</span>
            {mcpGrants.length === 0 ? (
              <div className="grant-preview muted small">No integration tools granted.</div>
            ) : (
              <ul className="grant-list grant-preview">
                {mcpGrants.map((grant) => (
                  <li key={grant.key} className={"grant grant-" + grant.effect}>
                    <span className={"effect effect-" + grant.effect}>{grant.effect}</span>
                    <code>{grant.actions.join(", ")}</code>
                    <span className="muted">on</span>
                    <code>{grant.resources || "—"}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
