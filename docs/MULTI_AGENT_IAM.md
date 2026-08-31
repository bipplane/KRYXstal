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
| **Actions** | `channel:read`, `channel:post`, `channel:create`, `shell:exec`, `fs:write`, `net:access`, `agent:spawn`, `agent:close`, `principal:request`, `capability:request`, `artifact:publish`, `artifact:read`. |
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
| `reader` | read channels, run commands (read-only sandbox), request capabilities | `rm -rf`, `sudo`, `git push`, `curl`, `wget`; `fs:write`; `net:access`; artefact read is implicit-deny until approved | none |
| `worker` | read/post channels, shell, fs:write, publish review artefacts, spawn/close, request principal | same command denies; `net:access` | channel:*, shell:exec, fs:write |
| `deployer` | worker + `net:access` + read review artefacts | `rm -rf /`, `sudo` | + net:access |
| `admin` | everything | — | `*` |

### Escalation: asking for a capability

An agent that hits a policy limit mid-task calls `request_capability(action,
resource?, reason)`. The request is posted as a card **in the channel the
agent is working in** (the group channel or the DM) and mirrored into
`#approvals`; the agent ends its turn, and the human picks one of:

| Decision | Effect |
| --- | --- |
| **Allow once** | A grant bound to the agent's *next run*: the tool/command is exposed in that run's generated config and allowed by the hook, then the grant is discarded when the run ends. |
| **Allow forever** | The agent's policy is updated: any deny covering the request is lifted and an allow statement is added (preset becomes `custom`). |
| **Deny** | Recorded; nothing changes. |

Every decision is a `Decision` row (`tool: request_capability`), the outcome
is posted in the channel, and the agent is woken with it so it can continue
where it was asked. Human grants override policy denies — the human is the
root of every agent's authority.

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

## Integrations (external MCP servers)

The human registers external MCP servers — streamable HTTP with OAuth (Linear,
GitHub, Notion, …) or local stdio servers — under **Integrations**. Connecting
runs `codex mcp login <name>` in a control-plane-owned `$CODEX_HOME`
(`codex-home/oauth/`): Codex prints the authorize URL, the UI opens it, the
provider redirects to Codex's loopback listener (`MCP_OAUTH_CALLBACK_PORT`),
and the tokens land in `codex-home/oauth/.credentials.json`. Tools are then
discovered with `tools/list`.

Every tool becomes an IAM action **`mcp:<server>:<tool>`** (globs allowed).
Nothing is granted by default: an agent only sees a server in its generated
`config.toml` when its policy could ever allow something on it, `enabled_tools`
is trimmed to what the policy allows, the credentials file is copied into the
agent's home for that run, and the `PreToolUse` hook still checks each call.
Delegation works unchanged (`mcp:linear:*` can be delegated only by a parent
that holds it and lists it as delegable).

Shared login is the default: agents borrow the human's grant, scoped by
policy, and the provider sees one identity — per-agent attribution lives in
the decision log. "Use own login" on an agent runs the same flow inside that
agent's `$CODEX_HOME`, giving it a distinct token at the provider; an agent
with any own login keeps its own credentials file and does not receive the
shared one.

## Scheduler

- A message wakes every agent member of a DM, and only `@mentioned` agents in
  other channels (`@everyone` wakes all members; collaborators end each step
  of a group task with it). With `TURN_TAKING=on`, inside a collaboration (a
  trace in which two or more agents have already run in that channel) the
  participant whose turn follows the author's is woken too, round-robin. The
  prompt contains the messages since the agent's last turn in that channel,
  windowed by message `seq`.
- `@name` means "I need a reply or an action from you". An answer needs no
  mention: when a run was woken by a message that mentioned the author *and*
  expected a reply (`post_message(expects_reply: true)`, or a `?` in the
  text), the run's reply wakes the asker automatically and is posted back
  where the agent was originally asked. Agents are told to end their turn
  after asking rather than polling with `read_channel`.
- An agent's final reply is posted automatically to the channel that woke it
  (or where it was asked). Tool calls are for acting elsewhere. Every channel
  write, tool or automatic, is also subject to the read-before-act check in
  [SYNCHRONISATION.md](SYNCHRONISATION.md): a reply that lost a race is not
  posted, and the agent gets a regenerate turn carrying the feedback. A reply
  of exactly `[no reply]` posts nothing and passes the turn.
- Wakes that arrive while an agent is busy are queued and drained after the
  run, one channel at a time; a regenerate merges with a pending wake.
- After `CHATTER_BUDGET` (default 64) consecutive agent turns in a channel
  without a human message the channel pauses and says so; any human message
  resumes it.
- Every message and run carries a `traceId` (the human prompt that started the
  chain). A message's `parentMessageId` is, for an agent's channel post, the
  newest message it had been shown in that channel when it replied; otherwise
  the message that woke the run (which every run keeps as
  `triggerMessageId`). See [Lineage](SYNCHRONISATION.md#lineage). One prompt
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
| `POST /api/agent/review-artifacts` | `publish_for_review` | `artifact:publish`; source validation and limits |
| `GET /api/agent/review-artifacts/:artifactId` | `read_review_artifact` | `artifact:read`; allowlist and hash verification |

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
- Session workspaces are separate from the parent's; use immutable review artefacts for file handoff.
- Rules cover literal command prefixes only; the hook sees the full command
  string and is the authoritative check for compound shell scripts.
- Policy changes apply from the next turn (each turn re-renders `$CODEX_HOME`).
# Secure review-artifact handoff

Agent workspaces remain isolated. Review files cross that boundary only through immutable, explicitly published artefacts:

1. Developer calls `publish_for_review` with claimed source and test paths relative to Developer workspace, plus optional note.
2. Tool returns generated artifact ID and SHA-256 manifest metadata. Developer posts exact artifact ID to Reviewer.
3. Reviewer calls `read_review_artifact` without `path` to list manifest, then calls it with exact listed paths. Every read rechecks stored size and SHA-256. Reviewer independently inspects code and runs or assesses published tests.

Storage lives at `APP_DATA_DIR/review-artifacts/<artifact-id>/`, outside every `AGENT_WORKSPACE_ROOT/<agent-id>` workspace. Each directory contains read-only `manifest.json` and published files under `files/`, preserving safe relative paths. Publication uses private staging directory plus atomic rename; IDs are generated UUIDs and existing artefacts are never overwritten. Metadata also persists through atomic existing JSON-store convention.

Default limits: 50 files, 10 MiB total publication size, 1 MiB per read response. Configure with `REVIEW_ARTIFACT_MAX_FILES`, `REVIEW_ARTIFACT_MAX_TOTAL_BYTES`, and `REVIEW_ARTIFACT_MAX_RESPONSE_BYTES`.

IAM actions: `artifact:publish` and `artifact:read`, scoped as `artifact:*` or `artifact:<id>`. Worker preset receives publish only. Reader preset (Reviewer role) requests `artifact:read` for the exact supplied ID; human approval exposes the tool for the next run, and an Allow once grant then expires. Deployer receives both; admin wildcard remains unchanged. Tools appear only where policy may grant corresponding action. All allow/deny decisions enter normal decision audit with run/trace lineage.

Security boundary: only listed regular files may cross. Absolute paths, traversal, empty/dot segments, symlinks (including parent components), directories, missing files, unlisted files, environment/credential/auth/log/key/database/Codex-home material are rejected. Read side validates IDs and paths, blocks links, compares disk manifest with stored metadata, verifies SHA-256 before response, and never writes publisher workspace or artefact. This mechanism adds no peer workspace mount, host-path API, sandbox exception, hook bypass, or approval bypass.
