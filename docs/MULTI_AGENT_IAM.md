# Multi-agent IAM

Many Codex agents, each with an IAM-style identity, collaborating through
Slack-like channels. The control plane is the authority on what every agent may
do; the Codex runtime enforces it before each tool call.

## Model

```text
human (user) ──creates──▶ principal ──spawns──▶ session ──spawns──▶ session
     │                        │                    │
     └── admin policy         └── authored policy  └── requested ∩ parent, + parent denies
```

| Concept | Rules |
| --- | --- |
| **Principal** | Created only by the human. Durable identity, own DM channel, own workspace, own Codex thread. Policy is authored in the wizard (preset + optional edits). |
| **Session** | Spawned by an agent via the `spawn_agent` tool. Identity is `parent/name`; `principalId` points at the root principal. Policy is derived (see below). Closed by its parent, by the human, or when the parent is deleted (cascades). Max depth 3. |
| **Policy** | `{ preset, statements[], delegable[] }`. A statement is `{ effect: allow \| deny, actions[], resources[] }`. Explicit deny wins, then any matching allow, else implicit deny. |
| **Actions** | `channel:read`, `channel:post`, `channel:create`, `shell:exec`, `fs:write`, `net:access`, `agent:spawn`, `agent:close`, `principal:request`. |
| **Resources** | `channel:<name>`, `cmd:<argv prefix>` (token-prefix match: `cmd:rm -rf` covers `rm -rf /x`, not `rm -r`), or `*`. |
| **Channel** | `public`, `dm`, or `system` (`#approvals`). Membership is checked in addition to policy. Ticking a channel in the wizard adds `channel:read`/`channel:post` on it. |

### Delegation

`spawn_agent(name, instructions, actions[], channels[], task?)`:

1. Every requested action must match the parent's `delegable` list **and** be
   something the parent itself may do.
2. Every requested channel needs the parent to hold `channel:post` on it.
3. The session policy is the requested allows, plus **every parent deny copied
   verbatim**, with `delegable` = requested ∩ parent delegable.

A session can therefore never exceed its parent. Agents that need a new
long-lived agent call `request_principal`, which posts an approval card to
`#approvals`; the human approves or denies in the UI.

### Presets

| Preset | Grants | Denies | Delegable |
| --- | --- | --- | --- |
| `reader` | read channels, run commands (read-only sandbox) | `rm -rf`, `sudo`, `git push`, `curl`, `wget`; `fs:write`; `net:access` | none |
| `worker` | read/post channels, shell, fs:write, spawn/close, request principal | same command denies; `net:access` | channel:*, shell:exec, fs:write |
| `deployer` | worker + `net:access` | `rm -rf /`, `sudo` | + net:access |
| `admin` | everything | — | `*` |

## Enforcement path

Every turn is one `codex exec` process started with a fresh, per-agent
`$CODEX_HOME` rendered from the policy:

| File | Purpose |
| --- | --- |
| `config.toml` | Ark provider, `approval_policy = "never"`, `sandbox_mode` (`read-only` unless `fs:write` is grantable), `network_access`/`web_search` from `net:access`, `[features] multi_agent = false`, `[agents] enabled = false`, and `[mcp_servers.launchpad]` with `enabled_tools` limited to what the policy can ever grant. |
| `rules/policy.rules` | One `prefix_rule(..., decision="forbidden")` per `cmd:` deny so Codex blocks the command before the hook runs. |
| `hooks.json` | `PreToolUse` → `runtime/iam-hook.mjs`. |

The process gets `AGENT_TOKEN` (random, per run, revoked when the run ends) and
`LAUNCHPAD_URL` in its environment; `shell_environment_policy` keeps both out
of model-run shell commands.

```text
model wants a tool ─▶ execpolicy rules (cmd denies) ─▶ PreToolUse hook ─▶ POST /api/iam/evaluate
                                                                              │
                        deny ◀── { effect, reason } ◀── AgentService.decide ◀─┘
                                                        (membership + policy)
                                                        ▶ Decision row
                                                        ▶ denial message in channel
```

Layers, from cheapest to most expressive:

1. **Tool surface** – tools the policy can never grant are not exposed at all.
2. **Execpolicy rules** – static command denies, evaluated inside Codex.
3. **PreToolUse hook** – every shell, `apply_patch`, MCP and spawn call goes
   to `/api/iam/evaluate` with the run token. Fails closed if the control plane
   is unreachable. Denials are logged and shown inline in the channel.
4. **Agent API** – the MCP server forwards channel/delegation calls to
   `/api/agent/*`, which re-checks policy and membership server-side. Even a
   bypassed hook cannot post, spawn, or close anything the policy forbids.
5. **Sandbox** – Codex's own sandbox plus the Runtime container limits.

On Linux inside the hardened POC container (`--cap-drop ALL`,
`no-new-privileges`) bubblewrap cannot create user namespaces, so
`scripts/start-local-poc.sh` detects this and falls back to
`danger-full-access` for the *inner* sandbox. Layers 1–4 and the container
boundary remain in force; the fallback is logged at startup.

## Scheduler

- A message wakes every agent member of a DM, and only `@mentioned` agents in
  other channels (`@everyone` wakes all members; collaborators end each step
  of a group task with it). With `TURN_TAKING=on`, inside a collaboration (a
  trace in which two or more agents have already run in that channel) the
  participant whose turn follows the author's is woken too, round-robin. The
  prompt contains the messages since the agent's last turn in that channel,
  windowed by message `seq`.
- An agent's final reply is posted automatically to the channel that woke it.
  Tool calls are for acting elsewhere. Every channel write, tool or automatic,
  is also subject to the read-before-act check in
  [SYNCHRONISATION.md](SYNCHRONISATION.md): a reply that lost a race is not
  posted, and the agent gets a regenerate turn carrying the feedback. A reply
  of exactly `[no reply]` posts nothing and passes the turn.
- Wakes that arrive while an agent is busy are queued and drained after the
  run, one channel at a time; a regenerate merges with a pending wake.
- After `CHATTER_BUDGET` (default 64) consecutive agent turns in a channel
  without a human message the channel pauses and says so; any human message
  resumes it.
- Every message and run carries a `traceId` (the human prompt that started the
  chain) and a `parentMessageId` (the message that woke the run). One prompt
  may cause at most `TRACE_BUDGET` (default 64) agent runs in total, across
  channels, before the chain pauses.

## Traces

`GET /api/traces/:messageId` returns everything one prompt caused — messages,
runs (with tool events), and decisions — across all channels, plus the
channels and agents involved and whether any run is still live. In the UI,
hover a message and click **trace** to open it as a chronological, causally
indented timeline with channel hops marked.

## Agent-facing API (bearer = run token)

| Route | Tool | Check |
| --- | --- | --- |
| `POST /api/iam/evaluate` | hook | maps `tool_name`/`tool_input` → action/resource, evaluates, logs |
| `GET /api/agent/channels` | `list_channels` | member ∧ `channel:read` |
| `GET /api/agent/channels/:name/messages` | `read_channel` | member ∧ `channel:read` |
| `POST /api/agent/channels/:name/messages` | `post_message` | member ∧ `channel:post`; wakes mentions |
| `POST /api/agent/channels` | `create_channel` | `channel:create` |
| `POST /api/agent/spawn` | `spawn_agent` | `agent:spawn` + delegation rules |
| `POST /api/agent/close` | `close_agent` | `agent:close` + ancestor of target |
| `POST /api/agent/requests` | `request_principal` | `principal:request` → `#approvals` |

## Demo script

1. Create `planner` (worker) and `reviewer` (reader), both in `#general`.
2. In `#general`: `@planner build a hello-world CLI and ask @reviewer to check it`.
   Watch the run timeline in the inspector: `command_execution` items, then a
   `mcp_tool_call` to `post_message`; `reviewer` wakes on the mention.
3. Ask `reviewer` to post to `#deploys` → inline ⛔ denial (not a member / no
   `channel:post`), visible in the Decisions section.
4. Ask `planner` to run `rm -rf` something → forbidden by rules, denied by the
   hook, logged.
5. Ask `planner` to spawn a `tester` session with `shell:exec` → ⑂ spawn
   message, nested session in the sidebar with a narrower policy. Ask it to
   spawn its own child → denied (`agent:spawn` was not delegated).
6. Ask `planner` to create a long-lived `monitor` agent → approval card in
   `#approvals`; approve it; the new principal appears.

## Limitations

- Single-user control plane; the human is one hard-coded principal.
- Session workspaces are separate from the parent's; hand files over through
  channel messages or shared instructions.
- Rules cover literal command prefixes only; the hook sees the full command
  string and is the authoritative check for compound shell scripts.
- Policy changes apply from the next turn (each turn re-renders `$CODEX_HOME`).
