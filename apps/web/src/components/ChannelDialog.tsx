import { useState, type FormEvent } from "react";
import type { Agent } from "../types";
import { ErrorNote, Modal, StatusDot, Tag } from "./ui";

interface ChannelDialogProps {
  agents: Agent[];
  onClose: () => void;
  onSubmit: (input: { name: string; description: string; memberIds: string[] }) => Promise<void>;
}

export default function ChannelDialog({ agents, onClose, onSubmit }: ChannelDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => {
    setMemberIds((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Channel name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: trimmed, description: description.trim(), memberIds });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create channel");
      setBusy(false);
    }
  };

  const eligible = agents.filter((a) => a.status !== "closed");

  return (
    <Modal title="New channel" onClose={onClose} width={460}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Name</span>
          <div className="input-prefix">
            <span>#</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="build-pipeline"
              maxLength={64}
            />
          </div>
        </label>
        <label className="field">
          <span className="field-label">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this channel for?"
          />
        </label>
        <div className="field">
          <span className="field-label">Members</span>
          {eligible.length === 0 ? (
            <div className="muted small">No agents to add yet — you can add members later by editing an agent.</div>
          ) : (
            <ul className="check-list">
              {eligible.map((agent) => (
                <li key={agent.id}>
                  <label className="check-item">
                    <input type="checkbox" checked={memberIds.includes(agent.id)} onChange={() => toggle(agent.id)} />
                    <StatusDot status={agent.status} />
                    <span>{agent.name}</span>
                    {agent.kind === "session" ? <Tag>session</Tag> : null}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <ErrorNote message={error} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create channel"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
