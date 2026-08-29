## Problem Statements

- Join our technical workshop webinars to learn more about the tracks that interest you!

Look forward to key takeaways about the problems, our technologies, and the impact your projects can bring. You are highly encouraged to attend all the workshops that align with your interests, so as to make a more informed decision in selecting the track that works best for you.

- Date: 28 August 2026, Friday (SGT/GMT+8)

- Time: 1-6pm (see below for the actual 45min time slot of each track)

- Webinar Link: https://vc-my.larkoffice.com/j/484622806 [URL 🔗](https://vc-my.larkoffice.com/j/484622806)

- Webinar Recordings will be uploaded by 29 Aug, 12pm

## 1. Agent Launchpad: Design and Build Lightweight Agent Middleware

- Technical Workshop Webinar with Q&A was held on 28 Aug, 1:00 to 1:45pm.

Webinar recording: https://bytedance.my.larkoffice.com/minutes/obmyo2nvz5ht46844444284t [URL 🔗](https://bytedance.my.larkoffice.com/minutes/obmyo2nvz5ht46844444284t)

- Build the missing middleware, not the platform.

The Starter Kit already provides the browser UI, Agent CRUD, Playground, backend control plane, persistent workspaces, Codex CLI Runtime, BytePlus ModelArk integration, local containers, and optional ECS deployment. Identity and authorization, trace and audit, layered Agent architecture, and threat modeling and safety are recommended middleware examples—not a prescribed checklist. Teams may choose, combine, simplify, replace, or invent capabilities that make the Agent platform more usable, manageable, observable, secure, reliable, or extensible. [URL 🔗](https://github.com/RrankPyramid/CodeJam)

https://github.com/RrankPyramid/CodeJam

Starter Kit — RrankPyramid/CodeJam

## 1.1 Challenge Overview

AI Agents are software actors that can reason, call tools, execute code, read and write files, and continue work across multiple turns. A useful Agent platform therefore needs more than a chat box: operators must be able to understand what happened, control what an Agent may access, and contain unsafe execution.

Building the full web application, control plane, cloud deployment, model connection, and Agent Runtime from scratch would consume the entire hackathon. This challenge removes that bottleneck. Every team starts from the same working platform and spends the three days on one meaningful infrastructure problem.

Your goal: design and demonstrate a coherent middleware story that improves the Agent platform in a functional, testable way without breaking the provided lifecycle or Playground. Evaluation focuses on the relevance, quality, and integration of the capabilities your team chooses or invents.

| Area | Provided by the Starter Kit |   | Student responsibility |
| --- | --- | --- | --- |
| Product experience Control plane | React UI, Agent list, Create/Edit forms, lifecycle controls, Playground, Run status. Fastify API, validation, asynchronous Runs, AgentService, JSON persistence. |   | Keep the baseline working; add only the UI needed to expose your middleware. Integrate real middleware behavior into the backend path. |
| Agent Runtime | Codex CLI, persistent sessions, per-Agent workspaces, disposable local containers. |   | Integrate team-designed middleware at the most appropriate execution boundary. |


| Infrastructure | Docker, Colima, Podman, Docker Compose, | Use the smallest runtime path that proves |
| --- | --- | --- |
|   | ECS scripts, and Terraform. | your design. Cloud deployment is optional. |
| Middleware | Intentionally absent: no user identity, trace | Select, adapt, combine, or invent a coherent |
|   | timeline, audit model, or hardened sandbox | set of middleware capabilities and |
|   | policy. | demonstrate why they improve the platform. |

## 1.2 Starter Kit

## What already works

- Create, inspect, edit, start, stop, and delete Agents from the browser.

- Send multi-turn tasks through the Playground and poll asynchronous Run status.


- Let Codex CLI write files and run commands inside the selected Agent workspace.

- Resume the same Codex session in later messages.

- Persist Agent, message, and Run metadata in a local JSON store.

- Run each local turn in a disposable Docker, Colima, or Podman container.

- Connect Codex to a BytePlus ModelArk Responses-compatible endpoint.

- Deploy the same POC to an existing BytePlus ECS instance or provision an ECS environment with Terraform.

## Current architecture and extension points

The Fastify request boundary, AgentService , the AgentRunner interface, and the execution data model are all valid extension seams. The diagram deliberately uses one generic Team-Designed Middleware node: teams may add new events, principals, policies, lifecycle behavior, provider adapters, memory controls, reliability mechanisms, or other capabilities wherever their design has the strongest boundary.

| Profile | Agent execution Use during the hackathon |
| --- | --- |
| Local POC BytePlus ECS Local development | One disposable local Recommended development and judging path. Supports container per turn. Docker, Colima, and rootless Podman. Codex runs inside the Optional deployment path for teams that want a cloud demo. application container. Codex runs as a host process. Useful for hot reload when the host Codex CLI is installed and configured. |

## Intentional limitations

The repository is a single-user POC. Its optional bearer token protects a remote demo but is not a user identity or authorization system. The JSON store supports one process. Ordinary containers are not a hardened multi-tenant isolation boundary. These limitations are deliberate extension points, not hidden requirements to fix all at once.

## 1.3 Run the Baseline Locally

## Requirements

- macOS or Linux.

- Node.js 22 or newer and npm 10 or newer.

- One container engine: Docker, Colima, or Podman.

- A BytePlus ModelArk API key and a Responses-compatible endpoint ID.

## Clone and start

Clone the Starter Kit

- 1 git clone https://github.com/RrankPyramid/CodeJam.git

- 2 cd CodeJam

One-command local POC

- 1 ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc

The first run installs Node.js dependencies and builds the Runtime image. The startup script automatically selects Docker, Colima, or Podman. Open http://localhost:3000 when the server is ready. [URL 🔗](http://localhost:3000/)

Ark credential requirement: ARK_API_KEY must be an Ark model API key, not a BytePlus account AK/SK. ARK_MODEL is normally an endpoint ID beginning with ep- . A wrong credential produces a 401 Unauthorized response from the Ark Responses API.

## Force rootless Podman

- 1 CONTAINER_ENGINE=podman ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-

Colima exposes the Docker CLI, so use the normal command after running colima start . Press Ctrl+C to stop the POC. Agent workspaces and conversations remain available for the next run.


## Baseline acceptance test

- 1. Open the browser and select Create Agent.

- 2. Enter a name, description, and workspace instructions.

- 3. Create the Agent and send the following task in the Playground.

Example Playground task

1 Create a TypeScript hello-world CLI, add a test, run it, and summarize the files

- 1. Wait for the Run to complete and confirm that an assistant response appears.

- 2. Send a follow-up message and confirm that the same Codex session continues.

- 3. Stop and restart the Agent, then confirm that the workspace still exists.

Do not start middleware work until this flow succeeds. If the baseline fails, check docker info or podman info , inspect http://localhost:3000/api/system , and verify the Ark key and endpoint. [URL 🔗](http://localhost:3000/api/system,)

## Development and validation

The simplest workflow is to edit the code, stop the POC, and rerun npm run poc . Before submitting, run the repository validation suite:

Required repository check

1 npm run check

This command runs TypeScript checks, server tests, and production builds. Additional setup paths are documented in the repository:

- README and browser SOP [URL 🔗](https://github.com/RrankPyramid/CodeJam/blob/main/README.md)

- Docker, Colima, and rootless Podman guide [URL 🔗](https://github.com/RrankPyramid/CodeJam/blob/main/docs/LOCAL_POC.md)

- Architecture and extension seams [URL 🔗](https://github.com/RrankPyramid/CodeJam/blob/main/docs/ARCHITECTURE.md)

- Optional ECS deployment guide [URL 🔗](https://github.com/RrankPyramid/CodeJam/blob/main/docs/DEPLOYMENT.md)

## 1.4 Platform and Middleware Design Requirements

The Starter Kit defines the basic platform experience. Beyond that baseline, middleware design is the core of the challenge. Teams should identify an Agent-specific problem, decide which responsibilities belong in the frontend, control plane, Runtime, data layer, or infrastructure boundary, and implement the smallest coherent solution that proves the idea.

The directions in Section 7 are examples rather than mandatory requirements. Teams may choose one, combine related ideas, simplify an example, replace it, or invent a different capability. Breadth is not the goal: reviewers will reward a clear problem, thoughtful architecture, real integration, and convincing evidence.

- Preserve the baseline: Agent CRUD, lifecycle actions, Playground chat, persistence, and model execution must continue to work.

- Implement real behavior: the middleware must execute in a backend, Runtime, data, or infrastructure path. Static screens and hard-coded success messages do not qualify.

- Define the boundary: explain which component owns the decision or event, what data crosses the boundary, and what happens when it fails.

- Demonstrate meaningful evidence: show the normal behavior and an appropriate failure, denial, recovery, degraded, or abuse case for the team's design.

- Add automated verification: test the core middleware behavior rather than only rendering the UI.

- Keep secrets out: never commit or display API keys, AK/SK, passwords, bearer tokens, or unredacted sensitive payloads.

- Prefer the smallest useful infrastructure: local execution is the default judging path; ECS is optional and does not affect the score.

| In scope | Out of scope |
| --- | --- |
| A coherent middleware story with one or more related | Rebuilding the React app, CRUD API, Playground, Codex |
| capabilities, a real integration path, minimal UI, tests, and | integration, container launcher, or a commercial cloud |
| demo evidence. | platform. |
| Mock users, protected fixtures, controlled failures, provider | Production OAuth, a general-purpose policy engine, a |
| adapters, lifecycle controls, trace data, policy decisions, or | microVM runtime, a container scheduler, or multi-region |
| reliability mechanisms. | infrastructure unless central to the team's idea. |
| Focused schema changes and refactors needed to make | Unrelated redesigns or cosmetic work that does not prove |
| the middleware understandable and extensible. | Agent infrastructure behavior. |

## 1.5 Agent Lifecycle and Post-Creation Experience

The Starter Kit already provides a post-creation experience rather than ending at an unexplained success message. A user can find an Agent, inspect its status and configuration, start or stop it, use the Playground, review messages and Runs, continue a Codex session, and delete the Agent while following an explicit workspace archival policy.

Teams may extend this lifecycle when it supports their middleware design. The following actions are examples rather than mandatory checkpoints:

- Test or invoke the Agent with a sample input.

- Open the middleware evidence for a specific Run, such as a trace, audit decision, policy result, recovery record, or budget event.

- Distinguish human operations from Agent operations and introduce human approval where useful.

- Update configuration through a new version and show what changed.


- Rotate or revoke credentials, permissions, tools, or network access.

- Pause, resume, stop, retry, reconcile, or recover an Agent or Run.

- Delete the Agent and clean up or retain its state according to an explicit policy.

Teams should implement only the lifecycle behavior needed to make their chosen or invented middleware capability convincing. Rebuilding every lifecycle feature is not expected.

## 1.6 Possible Three-Day Implementation Plan

| Day | Engineering goal | Exit evidence |
| --- | --- | --- |
| 1 | Start and understand the baseline. | The baseline passes; the team can trigger one real middleware |
|   | Define the Agent-specific problem, | behavior, event, decision, or control from an API or test. |
|   | choose or invent a coherent middleware |   |
|   | story, specify the contract, and |   |
|   | complete the first backend path. |   |
| 2 | Finish the core middleware path, persist | The complete scenario works end to end from the browser to the |
|   | its evidence, add the minimum UI, and | backend, Runtime, data, or infrastructure boundary. |
|   | implement the most important success |   |
|   | and failure cases. |   |
| 3 | Add automated tests, handle errors and | npm run check passes and the complete demonstration fits |
|   | cleanup, finish the architecture diagram | within three minutes. |
|   | and README, then rehearse the demo. |   |

## 1.7 Recommended Middleware Directions and Examples

Middleware design is a core part of this challenge. The examples below follow the same language and architecture boundaries as the original challenge brief. They are recommended examples—not a prescribed checklist. Teams may choose, combine, simplify, replace, or invent capabilities that better support their platform. Evaluation focuses on the relevance, quality, and integration of the capabilities the team designs.

## Recommended Middleware Example: Identity and Authorization

Identity and authorization are one recommended middleware direction. Teams choosing this area may explore a distinction between a human principal and an Agent principal. For example, an Agent could use a separate identity instead of reusing a human session, personal access token, or shared platform credential.

Possible identity and authorization ideas include:

- Human authentication: identify the user who owns, creates, approves, updates, or stops an Agent.

- Per-Agent identity: create a distinct principal for an Agent or Agent version that can be rotated or revoked independently.

- Delegated authority: represent scoped, time-bound, and revocable permissions that describe what the Agent may access.

- Policy enforcement: perform authorization checks at a trusted backend, tool, data, or Runtime boundary rather than relying on UI restrictions.

- Approval boundaries: require optional human approval for selected external writes, high-cost actions, production operations, or sensitive data access.

- Action attribution: record the initiating human, executing Agent, requested scope, decision, target resource, and result.

- Secret handling and revocation: keep provider credentials on trusted backends, redact sensitive values, and demonstrate how later execution changes after revocation.

A small mock identity model is acceptable. For example, a team could show ownership isolation between User A and User B and prove that an Agent owned by User A cannot read User B's mock resource. A login screen without server-side authorization would not demonstrate the middleware itself.

## Recommended Middleware Example: Trace, Audit, and Observability

Trace, audit, and observability are another recommended middleware direction. A team choosing this area could represent an Agent Run as a connected sequence of reasoning and actions rather than unrelated logs. Trace context may propagate across the frontend, control plane, Agent Runtime, model calls, tool calls, workspace operations, sandbox jobs, or cloud APIs that are relevant to the team's design.

Possible trace and audit ideas include:

- Stable identifiers such as Agent ID, Agent version, Run ID, session ID, trace ID, span ID, and actor type.

- Start time, duration, status, error details, and retry or cancellation relationships.

- Span categories such as orchestration, model call, tool call, memory access, sandbox execution, policy decision, human approval, or cloud operation.

- Inputs and outputs stored in a safely summarized or redacted form.

- Model, tool, Runtime, and infrastructure metadata needed to diagnose a Run.

- Token usage, cost, resource consumption, or other budget signals when available.

A trace-focused frontend could provide a Run list and a trace detail view with a tree or timeline, expandable spans, status filters, and a way to locate the failing step. A machine- readable query or export interface is an optional extension. Secrets and sensitive payloads should be redacted before storage or display.

## Recommended Middleware Design Example: Layered Agent Architecture

Layered architecture is another recommended middleware design direction. Teams are encouraged to explain how responsibilities are organized, but no single layering model is required. The table below illustrates one possible architecture that can be simplified, adapted, or replaced.

| Layer | Primary responsibility | Illustrative Starter Kit boundary |   |
| --- | --- | --- | --- |
| Experience Layer | Agent creation, catalog, Playground, middleware evidence, and lifecycle actions. | React Web UI calling stable platform APIs without holding the Ark key. |   |


| Control Plane | Agent specification, validation, status, Run | Fastify routes and | AgentService . |
| --- | --- | --- | --- |
|   | orchestration, and reconciliation. |   |   |
| Identity and Policy | Human and Agent identity, delegation, | A team-designed boundary around API, |   |
| Plane | approval, revocation, and audit. | service, tool, or Runtime operations. |   |
| Agent Runtime Layer | Codex execution, model access, tool routing, | AgentRunner , local Runtime containers, |   |
|   | retries, cancellation, and limits. | or the ECS process. |   |
| Execution and Data | Workspace files, persistent state, protected | Per-Agent workspaces, JSON metadata, |   |
| Layer | resources, connectors, and isolated execution. | mock services, or provider adapters. |   |
| Observability Layer | Trace ingestion, correlation, redaction, | New Run events, stores, APIs, and UI views |   |
|   | storage, query, visualization, and export. | added by the team. |   |
| Cloud Resource Layer | Compute, networking, storage, scheduling, | Docker, Colima, Podman, or optional |   |
|   | and sandbox infrastructure. | BytePlus ECS. |   |

Teams may document the API or event contracts between selected layers and explain how their design could evolve to support another Runtime, identity provider, trace backend, tool, model, or infrastructure provider.

## Recommended Middleware Example: Threat Modeling and Safety

Threat modeling and safety controls are another recommended middleware direction. Teams choosing this area could identify protected assets, actors, trust boundaries, abuse cases, implemented controls, and known residual risks. The table below provides examples; teams may focus on whichever threats are relevant to their design.

| Threat Controls to consider and demonstrate Credential theft or exposure Privilege escalation or confused delegation revocation, and complete actor attribution. | of secrets from source, browser state, logs, and traces. | Managed secret references, short-lived credentials, rotation, redaction, and exclusion Least-privilege scopes, explicit delegation, backend policy checks, approvals, |
| --- | --- | --- |
| Prompt injection or tool misuse limits, and approval for high-risk actions. Sandbox escape or untrusted code | controlled mounts, and patched Runtime images. | Tool allowlists, typed schemas, target-resource scoping, output validation, execution Non-privileged execution, restricted filesystems and networks, resource limits, |
| Cross-user access or data exfiltration Runaway execution or cost | protected metadata endpoints, and negative tests. | Ownership-aware authorization, storage isolation, scoped queries, outbound allowlists, Timeouts, quotas, concurrency limits, maximum steps, token or cost budgets, and an |
| administrative stop control. Sensitive trace capture |   | Configurable capture levels, redaction before export, trace access control, and |
| retention limits. |   |   |

The Starter Kit's existing CPU, memory, PID, dropped-capability, and no-new-privileges defaults may be reused as baseline safeguards, but they do not by themselves constitute a new safety capability.

## Recommended Middleware Example: Multi-Agent Coordination

Multi-Agent coordination is another recommended middleware direction. A team choosing this area may connect several Agent instances through a shared session, topic, queue, or lightweight coordinator. The purpose is not to build a complex distributed system; it is to demonstrate that the platform can route messages, preserve shared state, and coordinate turns across more than one Agent Runtime.

Example demo: create several Agents and ask them to count down from 10 to 1 in a shared conversation. On each turn, one Agent publishes the next unused number, then another Agent continues until the sequence reaches 1.

The minimum coordination layer may provide:

- A shared session or topic that all participating Agents can read and write.

- A simple turn-selection or message-routing rule.

- Shared state that records the latest number and prevents duplicate or skipped turns.

- A visible event history showing which Agent produced each number.

- A timeout, retry, or stop rule for an Agent that does not respond.

Successful demonstration: the team starts multiple Agents from the platform, launches one shared task, and shows a complete 10-to-1 sequence with no duplicate or missing number. The interface should make the participating Agent and ordering of each message clear. A platform-local webpage is sufficient; integration with an external chat product is optional.

Illustrative reference: multiple Agents take turns counting down in one shared topic.


## Other Team-Designed Middleware

Teams are encouraged to propose capabilities outside the examples when they improve the Agent platform in a clear way. Possible directions include lifecycle reconciliation and failure recovery, state and memory governance, human-in-the-loop workflows, cost and budget control, provider abstraction, versioning and rollback, multi-Agent coordination, tool or model routing, credential exchange, or automated diagnosis and remediation.

A team-defined capability should still explain the Agent-specific problem, architecture boundary, functional evidence, failure or recovery case, and known limitations.

## 1.8 Required Live Demo

The live demo should show one complete scenario. The essential journey is a user creating or selecting a runnable Agent from the frontend and then using or testing it. Beyond that baseline, each team should demonstrate the middleware capabilities it chose or designed. Identity, trace, audit, policy, recovery, and revocation are examples rather than mandatory checkpoints.

- 1. Create or select an Agent from the frontend and show its current lifecycle state.

- 2. Invoke the Agent through the Playground with a real task.

- 3. Show at least one real model, file, tool, sandbox, data, or infrastructure action.

- 4. Demonstrate the middleware behavior and the evidence it produces.

- 5. Demonstrate an appropriate failure, denial, degraded, abuse, or recovery case.

- 6. Show that the platform remains understandable and controllable afterward.

The scenario may use a mock third-party service or controlled fixture. The frontend-to-Agent path and any middleware presented by the team must be functional rather than represented only by static screens.

## 1.9 Deliverables

- 1. Three-minute live demo: show one real Agent Run and the team-designed middleware working in its normal case and an appropriate failure, denial, recovery, degraded, or abuse case.

- 2. One-page architecture diagram: show the middleware, data flow, trust boundary, and enforcement, instrumentation, or recovery point.

- 3. Code repository: include setup instructions, the middleware problem and rationale, design summary, automated tests, demo steps, limitations, and no secrets.

## 1.10 Core Acceptance Checklist and Optional Evidence

- A reviewer can clone the repository, start the platform, and create or test an Agent from the frontend.

- The submission identifies and demonstrates one or more meaningful middleware capabilities selected, adapted, combined, or designed by the team.


- The middleware executes in a backend, Runtime, data, or infrastructure path rather than only in the UI.

The repository and documentation are sufficient for reviewers to understand and reproduce the POC.

- npm run check passes.

- No secret appears in source, Git history, logs, traces, screenshots, browser storage, or demo output.

Optional evidence: a delegated permission is scoped or revocable, enforced outside the UI, and demonstrated.

- Optional evidence: an end-to-end Agent Run produces a correlated trace with relevant model, tool, sandbox, policy, or infrastructure events.

Optional evidence: a defined threat is blocked or contained, the protected asset remains unchanged, and cleanup or recovery is demonstrated.

- Optional evidence: a team-defined lifecycle, reliability, memory, budget, provider, or coordination capability works as described.

## 1.11 Evaluation Criteria

This track will follow the evaluation criteria below:

| Category | Weight | What reviewers will look for |
| --- | --- | --- |
| End-to-end middleware behavior 40% |   | A real frontend-to-backend, Runtime, data, or infrastructure path |
|   |   | with convincing functional evidence. |
| Technical design and integration | 25% | A clear rationale, coherent architecture, appropriate boundary, |
|   |   | focused changes, and extensible contracts. |
| Verification and robustness | 20% | Automated tests, error handling, cleanup or recovery, redaction, |
|   |   | and protection against obvious bypasses. |
| Demo and reproducibility | 15% | A concise live demo, useful README, one-command startup, |
|   |   | documented limitations, and no hidden manual setup. |

## 1.12 Scope Guidance and Frequently Asked Questions

This is a hackathon-scale Agent infrastructure challenge, not a requirement to build a complete commercial cloud product. A strong submission may support one local Runtime path, a small mock resource set, and a focused middleware story. Depth, coherence, and relevance matter more than the number of example features implemented.

Teams are not required to train a foundation model, build a workflow editor, implement production OAuth, create a general-purpose sandbox, support multiple cloud regions, or deploy to ECS. Mock external services are acceptable, but static UI mockups cannot replace functional middleware behavior.

Do we need BytePlus ECS? No. Local Docker, Colima, or Podman is the default judging path. Cloud deployment is optional.

Do we have to select one recommended example? No. The examples are starting points. Teams may adapt, combine, simplify, replace, or invent capabilities that fit their platform.

Can we use mock users or resources? Yes. Controlled fixtures are encouraged when they make middleware behavior reproducible.

Does a polished UI count as middleware? No. The UI may explain and visualize a capability, but the behavior must execute in a trusted backend, Runtime, data, or infrastructure path.

Why does Ark return 401 Unauthorized? The most common cause is using a BytePlus account AK/SK instead of an Ark model API key, or using the wrong endpoint ID.

Where should we start reading the code? Begin with apps/server/src/types.ts , apps/server/src/app.ts , apps/server/src/agent-service.ts , and the two AgentRunner implementations. Then inspect apps/web/src/App.tsx for the smallest UI integration point.

How to access the Starter Kit? https://github.com/RrankPyramid/CodeJam [URL 🔗](https://github.com/RrankPyramid/CodeJam)

