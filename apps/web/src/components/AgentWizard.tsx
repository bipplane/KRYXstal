import { useEffect, useMemo, useState } from "react";
import {
  ACTIONS,
  type Agent,
  type AgentInput,
  type Channel,
  type Effect,
  type Policy,
  type PolicyPreset,
  type PolicyPresets,
  type Statement,
} from "../types";
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

export default function AgentWizard({
  mode,
  agent,
  presets,
  channels,
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
        </div>
      ) : null}
    </Modal>
  );
}
