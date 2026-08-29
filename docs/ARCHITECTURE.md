# Architecture

Volc Agent Launchpad is a single-node control plane for hackathon use.

```mermaid
flowchart LR
    UI["React Web UI"] --> API["Fastify API"]
    API --> Service["AgentService"]
    Service --> Store["JSON store"]
    Service --> Workspace["Agent workspace"]
    Service --> Runner{"AgentRunner"}
    Runner -->|Local POC| Container["Disposable Runtime container"]
    Runner -->|ECS| Process["Codex child process"]
    Container --> Ark["Volcengine Ark"]
    Process --> Ark
    Container -. "PreToolUse hook + MCP tools\n(AGENT_TOKEN)" .-> IAM["/api/iam, /api/agent"]
    Process -. "PreToolUse hook + MCP tools" .-> IAM
    IAM --> Service
```

## Components

### Web UI

Lists Agents, manages lifecycle actions, submits prompts, and polls asynchronous
Runs. It never receives the Ark API key.

### Fastify API

Validates requests, protects remote demos with a shared bearer token, and
serves the compiled Web UI. The token is not user identity or authorization.

### AgentService

Coordinates lifecycle state, persistence, workspaces, channels, IAM decisions,
sessions, approvals, and Runs. One Agent can have only one active Run; wakes
that arrive while it is busy are queued and drained afterwards.

The IAM model (principals, sessions, policies, enforcement layers) is
described in [MULTI_AGENT_IAM.md](MULTI_AGENT_IAM.md).

```text
ready -> busy -> ready
  |       |
  v       v
stopped  error
```

Interrupted Runs become `cancelled` after a restart.

### Storage

```text
data/launchpad.json       Agents, channels, messages, Runs, decisions, approvals
workspaces/AgentID/       Agent-created files (+ generated AGENTS.md)
workspaces/.deleted/      Archived deleted workspaces
codex-home/agents/ID/     Per-agent Codex home: generated config.toml,
                          rules/policy.rules, hooks.json, and Codex sessions
runtime/                  MCP channel server and IAM hook run inside the Runtime
```

`JsonStore` serializes writes and atomically replaces one JSON file. It supports
one process only.

### Runtime providers

- `CodexRunner` runs Codex inside the application container for ECS.
- `ContainerCodexRunner` starts one disposable Docker, Colima, or Podman
  container for every local turn.

Both providers use argv-only process execution, bound output and time, resume
the stored Codex thread, and escalate termination after a grace period. Both
receive the per-run `AGENT_TOKEN` and `LAUNCHPAD_URL` in the environment (never
in argv) and stream Codex `command_execution`, `mcp_tool_call`, and
`file_change` items back as Run events.

## Deployment profiles

| Profile | Control plane | Agent execution |
| --- | --- | --- |
| Local POC | Host Node.js | Disposable local container |
| ECS | Application container | Codex process in the same container |
| Local development | Host Node.js | Host Codex process |

## Extension seams

| Track | Primary seam | Expected change |
| --- | --- | --- |
| Glass Box | `AgentRunner`, `AgentRun` | Emit and display correlated execution events. |
| Bouncer | API routes, Agent ownership | Add identity and server-side authorization. |
| Kill Switch | `AgentRunner` | Add threat-specific policy or a stronger sandbox. |

The current container or ECS instance is the POC trust boundary. Ordinary
containers are not hardened multi-tenant isolation.
