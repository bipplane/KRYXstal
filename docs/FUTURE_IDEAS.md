# Future middleware ideas and implementation guardrails

> Roadmap and design reference reviewed against repository commit `96b345d`, 1 September 2026. Current implemented features live in the main [README](../README.md); this file contains only submission constraints, known gaps, future ideas, implementation plans, and anti-overfitting guardrails.

Do not treat product examples as core requirements. Every idea inherits mandatory generality contract: domain-neutral core, explicit extension interfaces, backend invariants, and unrelated second fixture requiring zero core changes.

## 1. Hackathon contract

`PROBLEM_STATEMENT.md` asks team to preserve baseline, add real middleware in trusted backend/runtime/data/infrastructure path, show normal plus failure/denial/recovery case, test core behaviour, avoid secrets, and deliver:

1. three-minute live demo;
2. one-page architecture diagram showing data flow, trust boundary, enforcement/instrumentation/recovery point;
3. repository with setup, rationale, design, tests, demo, limitations.

Scoring: end-to-end behaviour 40%, design/integration 25%, verification/robustness 20%, demo/reproducibility 15%. Depth and coherent boundary beat feature count. Local runtime is default; ECS optional.

Current repository already covers large parts of recommended identity, authorisation, trace/audit, layered architecture, safety, and multi-Agent coordination directions. Submission should present one sharp new thesis, not claim raw feature breadth as story.

## 2. Current gaps and extension opportunities

These are not hidden implementation claims; they are future work or demo risks.

- Single hard-coded human. Shared bearer token is gate, not identity, ownership, RBAC, CSRF protection, or tenant isolation.
- JSON persistence is single-process; no database constraints, indexes, event replay, horizontal scale, retention jobs, or tamper evidence.
- Runtime events are completion events, not full span protocol. Timestamps are receipt time; no stable span/parent IDs, latency phases, model attempt records, or cost conversion.
- Trace/event/message content can contain sensitive data. Header log redaction exists, but general payload redaction/classification does not.
- Policy resources are mostly coarse. Filesystem writes use `workspace`; web uses `web`; external MCP uses `*`. No path, record, field, tenant, argument, destination, row, or data-label policy.
- Shell parsing is whitespace based, not shell AST. Compound commands, aliases, interpreters, encoded payloads, and indirect execution need stronger canonicalisation/proxy enforcement.
- Passive tool allowlist assumes reads/planning are harmless. Read access can expose secrets or enable exfiltration.
- `mayEver` tool exposure is coarse and can differ from exact resource evaluation. Good defence-in-depth optimisation, not proof of authorisation.
- Shared OAuth credentials copied into Agent home. If Agent has any own login it receives no shared credential file, limiting mixed shared/own identities.
- No OAuth token encryption-at-rest, refresh lifecycle UI, provider-side scope inventory, or per-call delegated token exchange.
- External stdio integration executes configured command on control-plane host during discovery/login paths; human registration is highly trusted.
- Container network is broad bridge access. No destination allowlist, DNS policy, proxy, metadata endpoint protection, or byte limits.
- ECS mode shares application container and offers weaker Agent isolation.
- Agent session `expiresAt` exists but no expiry scheduler enforces it.
- Session workspaces remain separate. Immutable review artefacts provide
  explicit snapshot handoff, but no mutable shared workspace, patch merge,
  retention policy, or automatic artefact cleanup exists.
- Pending wakes are in memory and coalesced to latest per channel; restart loses them and intermediate triggers may collapse.
- Synchronisation locks/read cursors, conflict counters for ad-hoc runs, chatter counters, and trace notices are in memory. Cursors reconstruct approximately; other coordination state resets on restart.
- Read correctness has pagination edge: wake prompt slices to 20 messages and `read_channel` honours caller limit, but both advance cursor to channel `lastSeq`. More than returned window can therefore be marked seen without reaching model.
- Synchronisation checks freshness, not semantic uniqueness. Agent may re-read then repeat winner or make logically incompatible change.
- Only channel posts, channel-name registry, and approval resolution use synchronisation. Session lifecycle, files, external tool effects, grants, budgets, and integrations can still race.
- In-memory lease lacks fencing token. Safe enough with current serial JSON mutation queue, but distributed replacement must reject commits from expired holders.
- Broadcast `@everyone` protocol can cost roughly N−1 losing Runs per step; default 64 budgets may still truncate larger groups/tasks.
- `TURN_TAKING` is one global round-robin switch added for countdown-shaped collaboration. Though round-robin itself is generic, global selection and participant inference from first-Run history overfit demo. Replace with per-task versioned `CoordinationPolicy` plugin; no prompt-text strategy inference.
- Conflict notices remain in raw store/API but UI filters them; operators need clear raw-versus-projected trace semantics.
- Conflict regeneration exists, but no general transient retry policy, provider idempotency, dead-letter queue, resumable tool transaction, or reconciliation beyond restart cancellation.
- No channel archive/edit/member-management lifecycle in current UI/API beyond membership via Agent edit.
- Delete removes Agent Runs from database, weakening long-term audit; decisions/messages may retain orphaned Agent IDs.
- Approvals have no expiry, risk score, approver identity, quorum, comment, revocation history, or policy version binding.
- Permanent grant mutates policy directly; no version history or rollback.
- One-time grant means next Run, not exact retried tool call; unrelated wake could consume it.
- UI uses polling, not push/SSE/WebSocket; scale and immediacy limited.
- No web component tests/end-to-end browser tests.
- Validation suite is not Windows-portable today: local-Codex symlink test needs privilege, fake executable/OAuth tests assume POSIX executable semantics, and container mount expectation normalises POSIX paths. Official challenge baseline targets macOS/Linux.
- No production secret manager, key rotation, encrypted storage, backup/restore, migrations beyond v1→v2, metrics, alerting, or SLOs.

## 3. Product principles for extensions

1. **Control at action boundary.** UI explains; backend/runtime decides.
2. **Authority is a lease, not possession.** Narrow target, arguments, time, count, and causal task.
3. **Data carries policy.** Track source/classification through model and tools, not only caller identity.
4. **Effects become transactions.** Preview, approve, commit, verify, compensate.
5. **Evidence is product.** Every demo should answer who, why, what changed, what was blocked, and how state recovered.
6. **Agents fail predictably.** Bounded retries, budgets, deadlines, circuit breakers, and safe degraded mode.
7. **Version everything.** Agent prompt, model, policy, tool schemas, memory, and artefacts need reproducible revision IDs.
8. **Keep three-minute proof.** One clean success, one adversarial failure, protected asset unchanged, trace explains result.

### 3.1 Mandatory generality contract for every implementation plan

Ideas 1–56 are product examples, not permission to hard-code demo behaviour. Every plan in this document is incomplete until it satisfies this contract.

#### Core-versus-adapter rule

Core middleware may know only generic concepts:

- actor/principal, capability, resource, intent, effect, policy, label, version, lease, receipt;
- task, state, command, transition, dependency, participant, role, strategy, quorum;
- event, trace, span, cursor, sequence, lock, fence, budget, deadline, retry.

Domain concepts belong in adapters, schemas, fixtures, and presentation only. Words such as `countdown`, `video`, `caption`, `creator`, `campaign`, `LIVE`, `rights`, `moderation`, `advert`, `TikTok`, specific provider names, and demo-specific numbers must not appear in core scheduling, policy, transaction, persistence, or synchronisation logic.

Allowed exception: generic core receives those values as opaque IDs, configured attributes, typed schema fields, or plugin metadata. It must not branch on them.

#### No prompt-shaped control flow

- Never detect phrases such as “count down”, “take turns”, “publish”, or `@everyone` to select business semantics.
- Model prose cannot be authoritative task state, lock ownership, approval, completion, or invariant proof.
- Caller selects versioned `TaskSpec`, `CoordinationPolicy`, `EffectAdapter`, `PolicyPack`, or workflow schema explicitly.
- Prompt instructions improve Agent behaviour but never replace backend validation.
- New use case must not require another `if task contains ...`, enum member, scheduler branch, or special sentinel. `[no reply]` is existing transport convention; future workflow completion should use typed result where possible.

#### Extension-interface rule

Implement capability behind small stable interfaces before product fixture:

```ts
interface CoordinationStrategy {
  select(input: CoordinationContext): CoordinationDecision;
}

interface StateMachine<S, C, E> {
  initial(spec: unknown): S;
  decide(state: S, command: C): { events: E[] } | { conflict: GenericConflict };
  evolve(state: S, event: E): S;
}

interface EffectAdapter<Intent, Preview, Receipt> {
  canonicalise(intent: Intent): CanonicalIntent;
  preview(intent: CanonicalIntent): Promise<Preview>;
  commit(intent: CanonicalIntent, fence: FencingToken): Promise<Receipt>;
  reconcile(intentId: string): Promise<Receipt | null>;
  compensate?(receipt: Receipt): Promise<Receipt>;
}

interface SignalClassifier<Input> {
  classify(input: Input): Promise<Array<{ label: string; confidence: number; evidence: string[] }>>;
}
```

Interfaces may evolve, but dependency direction stays: domain adapter depends on core contract; core never imports domain adapter.

#### Two-domain proof rule

Every feature requires two unrelated acceptance fixtures using identical core code:

1. primary polished demo, possibly TikTok-shaped;
2. small non-social-media proof, such as package deployment, inventory reservation, document approval, support ticket, or filesystem patch.

Second proof may be automated only; no second polished UI required. Adding it must require only new adapter/schema/configuration. Any core edit means abstraction failed review.

Examples:

| Generic capability | Primary fixture | Unrelated proof |
| --- | --- | --- |
| State transition | creator draft lifecycle | deployment promotion |
| Effect fencing | publish post | reserve inventory item |
| Quorum barrier | rights+safety review | two-person production approval |
| Data-flow policy | private draft → public sink | secret config → webhook |
| Artefact merge | localised caption | concurrent source-code patch |
| Budget governor | advert spend | model-token budget |
| Memory governance | creator preference | support-case retention |

#### Configuration and versioning rule

- Strategy, schema, thresholds, labels, roles, quorum, deadlines, resource mapping, and risk rules are data with version IDs.
- Avoid product-specific enum growth in shared types. Use validated namespaced strings or registered schema/plugin IDs.
- Persist exact contract/plugin/policy version on every Run, Decision, intent, and receipt.
- Unknown version fails closed or uses explicitly declared fallback; never silently guesses.
- UI reads metadata/schema to render generic forms and evidence where practical.

#### Invariant-first testing rule

Tests target properties, not rehearsed transcript:

- at most one valid commit per idempotency key/fencing generation;
- child authority never exceeds parent;
- stale actor never mutates protected state;
- denied intent never reaches adapter;
- cursor never advances past delivered state;
- replay/retry does not duplicate effect;
- barrier releases only under declared rule;
- budget never settles beyond hard cap;
- redacted data never enters disallowed sink;
- adding second domain requires zero core changes.

Use generated/property/concurrency tests where possible. Countdown `10..1` may remain one example, but test must also run arbitrary reducer/state-machine commands and random contention schedules.

#### Generality review gate

Before merging any idea, reviewer answers:

- What is domain-neutral primitive?
- Which stable interface owns variation?
- Which details are configuration/schema versus code?
- What second unrelated fixture passes without core change?
- Which invariant does backend enforce independently of model?
- Can feature be removed/replaced as plugin without editing scheduler/service?
- Does implementation introduce demo words or values into core?
- Does new use case require new branching? If yes, refactor before merge.

CI should include dependency-boundary/lint check that rejects forbidden domain imports/terms in core modules, plus generic contract test suite executed against every registered adapter/strategy.

#### Mandatory delivery sequence for each idea

1. Write domain-neutral invariant and contract before demo code.
2. Implement core host/engine against interface with in-memory generic test adapter.
3. Prove properties using generated inputs, retries, concurrency, and failure injection.
4. Add primary product adapter/schema without changing core.
5. Add unrelated second adapter/schema; any needed core branch triggers abstraction refactor.
6. Render UI from generic metadata where feasible; keep domain-specific UI inside adapter feature package.
7. Persist contract/version IDs and expose them in trace/evidence.
8. Run conformance, dependency-boundary, security, and existing regression suites.

Pull request must list files changed for step 5. Expected core-file count is zero.

### 3.2 Generality audit by idea family

Mandatory specialisation seams and second proofs for all plans:

| Ideas | Generic core | Variation belongs in | Required unrelated proof |
| --- | --- | --- | --- |
| 1–10 | capability/risk/data-flow/effect policy | policy packs, canonicalisers, classifiers, threat scenarios | filesystem/deployment action beside creator/provider action |
| 11–16 | evidence envelope, event ledger, replay, provenance, explanation | exporters, renderers, domain event schemas | CLI/package Run beside UI/content Run |
| 17–24 | version routing, durable work queue, budget, provider adapter, checkpoint, trigger | routing policies, provider drivers, trigger plugins, fault scenarios | two model/tool providers or scheduled job beside social event |
| 25–28 | typed memory record, context selector, lineage deletion, private aggregate | memory schemas, retention policies, analytics extractors | support-case data beside creator preferences |
| 29–34 | task graph, artefact handle, quorum, capability registry, lock/fence, handoff capsule | task schemas, role metadata, storage adapters, coordination strategies | deployment/review workflow beside collaborative content task |
| 35–44 | same generic primitives above | TikTok-shaped adapters and UI copy only | named non-social fixture per feature; no TikTok term in core |
| 45–56 | cursor acknowledgement, state machine, strategy plugin, candidate selection, fairness, barrier, merge, effect fence | reducer schemas, strategy configuration, scoring plugins, adapters | random counter/inventory/deployment fixture beside creator-ops demo |

No idea gains “implemented” status from one domain fixture alone.

## 4. Recommended flagship: Agent Trust Fabric

### Product pitch

“Launch any internal or creator-facing Agent with TikTok-grade controls: least-privilege authority, current-state coordination, data-aware safety, reversible actions, and replayable proof.” Existing Launchpad now proves identity, policy, and exactly-one current channel contribution. Trust Fabric extends same synchronised validate/commit pattern to real external effects and closes four enterprise blockers:

- permissions too broad;
- prompt injection/data leakage;
- irreversible tool side effects;
- opaque incident reconstruction.

### Hackathon slice

Build one protected mock `publish_video` or `launch_campaign` integration:

1. Agent reads untrusted brief containing injection asking it to leak a private draft and publish globally.
2. Taint middleware labels input untrusted/private.
3. Tool call becomes proposed transaction. Policy narrows requested capability to exact draft, audience, region, and one call.
4. Preview shows diff/effects/risk. Human approves safe corrected version once.
5. Commit uses one-shot token and records receipt. Malicious variant is denied before provider mutation.
6. Trace exports evidence showing source, policy version, approval, request digest, provider receipt, and unchanged protected fixture.

### Minimal new contracts

```ts
interface ActionIntent {
  id: string;
  runId: string;
  tool: string;
  canonicalArgs: unknown;
  resource: string;
  labels: string[];
  risk: number;
  digest: string;
  status: "proposed" | "approved" | "committed" | "denied" | "compensated";
}

interface CapabilityLease {
  id: string;
  agentId: string;
  traceId: string;
  action: string;
  resource: string;
  argsDigest: string;
  maxUses: 1;
  expiresAt: string;
}

interface EffectReceipt {
  intentId: string;
  provider: string;
  beforeDigest: string | null;
  afterDigest: string | null;
  externalId: string | null;
  compensation: unknown | null;
}
```

### Three-day build plan

| Day | Build | Exit proof |
| --- | --- | --- |
| 1 | Canonical tool-intent gateway, mock provider, scoped lease evaluation, schema/store/tests | Exact approved args pass; changed audience/asset fails |
| 2 | Data labels, simple injection/egress rules, preview/approve/commit UI, receipts | Untrusted prompt blocked; protected fixture unchanged |
| 3 | Evidence export, counterfactual replay, failure cleanup, end-to-end test, diagram/demo | Full success + abuse case under three minutes |

### Generality guardrail for flagship

- Core names remain `ActionIntent`, `CapabilityLease`, `EffectAdapter`, `EffectReceipt`, `DataLabel`; no publish/video/campaign branch.
- TikTok-shaped publish is one adapter. Second automated adapter reserves/releases inventory or promotes/rolls back deployment using same intent/lease/receipt services.
- Approval UI renders adapter-provided JSON Schema/metadata; it does not contain publish-specific fields in shared component.
- Exact-argument scoping uses canonicaliser registered by schema version, never handwritten condition in `AgentService`.
- CI runs same lifecycle contract suite against both adapters and fails if either bypasses preview, lease, fence, receipt, or reconciliation.

### Why this should score

- End-to-end: browser → scheduler → model → hook/gateway → approval → provider fixture → trace.
- Design: natural extension of current policy/grant/decision contracts.
- Robustness: exact argument digest, expiry, max use, fail closed, immutable receipts, negative tests.
- Reproducibility: mock provider and scripted malicious input; no external account needed.

## 5. Idea portfolio with implementation plans

Priority legend: **H1** = strongest three-day differentiator; **H2** = strong extension; **M** = post-hackathon; **Moonshot** = strategic vision.

Every plan below inherits mandatory generality contract in §3.1 and family audit in §3.2. Product examples describe adapters/fixtures, never core branches. “Implement” means primary scenario plus unrelated contract proof pass with zero core change between them.

### 5.1 Trust, safety, and authorisation

#### Idea 1 — Capability leases, not “allow once” (**H1**)

Current once-grant attaches to next Run and resource/action only. Replace with signed lease bound to trace, tool, canonical argument digest, target, use count, expiry, and optional spend cap.

- Backend: add `CapabilityLease`; canonicalise tool args; evaluate lease before static policy; atomically consume use.
- Runtime: include intent/lease ID in hook and MCP request; reject replay or changed args.
- UI: approval card displays exact effect (“publish draft 42 to SG, once, before 14:05”).
- Test/demo: approve draft 42; replay, draft 43, audience change, expiry all denied.
- Risk: canonicalisation mismatch. One shared canonicaliser and digest golden tests.

#### Idea 2 — Tool transaction escrow: propose → preview → commit → compensate (**H1**)

Wrap side-effecting MCP tools so Agent cannot mutate provider directly.

- Generalise new `performSynced` primitive from channel writes to effect resources; add adapter interface: `plan(args)`, `commit(plan, lease)`, `verify(receipt)`, `compensate(receipt)`.
- Store immutable intent, redacted preview, state machine, provider idempotency key, receipt.
- Policy routes read-only calls directly; risky writes enter escrow.
- UI shows diff, blast radius, rollback availability, approve/deny/edit.
- Test/demo: safe publish commits; malicious publish denied; simulated partial failure compensates.
- Limitation: not every provider supports rollback. Surface “irreversible” and require stronger approval.

#### Idea 3 — Prompt-injection firewall with data taint (**H1**)

Policy follows data from untrusted tool output to sensitive sinks.

- Introduce labels: `trusted`, `untrusted`, `private`, `minor`, `commercial`, `secret`, `external`.
- Mark sources at message/tool boundary; maintain per-Run taint set and evidence edges.
- Add flow rules such as `untrusted -> external-write requires approval`, `secret -> network deny`.
- Hook/gateway evaluates caller policy plus active data labels and intended sink.
- UI trace shows label propagation and exact blocked flow.
- Test with injected web/MCP content asking for credential or private draft exfiltration.
- Start deterministic; optional model classifier can enrich but never be sole control.

#### Idea 4 — Egress proxy and semantic DLP (**H1/H2**)

Replace boolean network access with controlled outbound gateway.

- Force Runtime HTTP/DNS through proxy; block cloud metadata/private CIDRs and unapproved domains.
- Policy resources become `net:domain`, method, path class, byte budget.
- Scan payload for secrets, PII, unpublished assets, minors’ data, and high-entropy tokens.
- Redact or deny before bytes leave; log hash and classification, never raw secret.
- Demo allowed ModelArk call versus blocked webhook exfiltration.
- Tests cover DNS rebinding, redirects, encoded payloads, chunking, and proxy failure closed.

#### Idea 5 — Secret broker and per-call token exchange (**H2**)

Agents should never receive long-lived provider credentials.

- Store secret references in control plane; integrate mock Vault/KMS adapter.
- Exchange approved intent for short-lived provider token scoped to tool/resource/audience.
- MCP gateway holds credential and performs call; Runtime receives opaque receipt only.
- Add rotation/revocation state and credential-use audit.
- Demo revoke token during session; later call fails without restarting Agent.
- Keep Ark credential as acknowledged exception or proxy model access too.

#### Idea 6 — Risk-adaptive approval engine (**H2**)

Not every call deserves same friction. Compute risk from action, target, data labels, novelty, volume, user age/region, and Agent history.

- Add deterministic risk rules producing score, reasons, required approver tier, expiry.
- Low risk auto-commits; medium requires one approval; high requires two-person quorum; critical denied.
- Cache approval only for matching intent template and bounded window.
- UI risk card shows factors and policy, never mysterious score alone.
- Test boundary values and attempts to split one high-risk action into many low-risk actions.

#### Idea 7 — Circuit-breaker kill switch (**H1/H2**)

Threat-specific containment beyond existing resource limits.

- Streaming detector consumes denials, tool rate, write volume, destinations, repeated failures, and label violations.
- State machine: normal → throttled → quarantined → terminated.
- Quarantine revokes token, kills runner, blocks queued wakes, snapshots evidence, and starts clean-up adapter.
- Protected canary file/resource proves malicious Run did not modify asset.
- UI global/Agent kill control plus reason, cleanup status, safe restart action.
- Test race between dangerous call and cancellation; fail closed if detector unavailable.

#### Idea 8 — Policy compiler, linter, and counterexample generator (**H2**)

Make policy understandable before deployment.

- Compile statements into normalised decision graph; flag shadowed allows, unreachable denies, wildcards, delegation escalation, missing resources.
- `POST /policy/simulate` accepts Agent/version and action corpus; returns decisions without effects.
- Generate concrete bypass counterexamples for overlapping globs/command prefixes.
- UI “policy diff” and “why allowed?” explorer.
- Tests use property-based generation for deny precedence and parent≥child invariant.
- Demo catches policy that accidentally grants all external tools.

#### Idea 9 — Regional and age-aware policy packs (**H2/M**)

Attach jurisdiction, audience age, content category, and data residency to context.

- Versioned policy packs layered under Agent policy; platform deny cannot be overridden by Agent/human approval.
- Resource attributes include market, data class, age band, content type.
- Evaluate applicable packs at intent time; record pack IDs/versions.
- UI explains Singapore/EU/minor-specific control and required reviewer.
- Demo same action allowed for adult SG fixture, denied for minor/EU fixture.
- Keep legal claims out; present as configurable enforcement framework.

#### Idea 10 — Autonomous red-team shadow Agent (**H2/M**)

Every new Agent/policy gets adversarial tests before activation.

- Create isolated fixture Runtime with no real credentials and generated attack suite.
- Attacks: prompt injection, data exfiltration, command indirection, approval laundering, agent delegation escalation, loop amplification.
- Produce risk report with replayable trace and pass/fail gates.
- Block promotion when protected invariants fail.
- Demo wizard “Safety check” discovers a real over-broad statement then validates fix.

### 5.2 Evidence, observability, and governance

#### Idea 11 — Tamper-evident audit ledger and evidence bundle (**H1**)

Current JSON audit is editable and Agent deletion removes Runs.

- Append-only event log with sequence, previous hash, event hash, signer/key ID.
- Retain tombstones rather than deleting Run history; seal trace on completion.
- Export signed JSON/HTML evidence: Agent/policy/model/tool versions, approvals, redacted events, receipts, final state.
- Offline verifier checks chain/digests and reports gaps.
- Demo modify one stored event; verifier detects tamper.
- Production path: object-lock/WORM store; hackathon path: local signed ledger.

#### Idea 12 — Deterministic replay and counterfactual policy lab (**H1/H2**)

Replay saved model/tool exchanges without executing side effects.

- Record versioned tool schemas, canonical requests, redacted responses, nondeterministic inputs, policy version.
- Replay runner returns captured tool results; write tools remain virtual.
- “What if?” evaluates same trace under proposed policy/model/router.
- UI compares decision and output deltas, highlights first divergence.
- Demo answer: “Would new policy have stopped yesterday’s incident?”
- Limit claim: model replay only deterministic with captured outputs; label simulated versus live.

#### Idea 13 — OpenTelemetry-native span pipeline (**H2**)

Upgrade flat completion events to portable traces.

- Define spans for message routing, queue wait, model attempt, tool authorisation, approval wait, tool execution, filesystem effect, compensation.
- Propagate W3C trace context through runner, hook, MCP, mock provider.
- Redact before span storage/export; configurable capture levels.
- Expose OTLP exporter plus current JSON/UI adapter.
- UI critical path, latency waterfall, failure root cause, token/cost/resource overlays.
- Test parent/child integrity and secret removal before exporter.

#### Idea 14 — Causal incident explainer (**H2/M**)

Generate operator-grade incident summary from evidence graph, not raw chat.

- Rule engine finds first deny/failure, upstream inputs, responsible version, changed resources, recovery steps.
- Optional model writes narrative from already-redacted structured facts.
- Output separates facts, inference, uncertainty, and recommended action.
- One-click issue bundle for engineering/on-call systems through transaction gateway.
- Demo failed chain across three Agents condensed into root cause in seconds.

#### Idea 15 — Content/action provenance graph (**H2/M**)

Track which message, file, tool result, memory record, Agent, and approval contributed to external output.

- Persist typed provenance edges and content digests.
- Add artefact IDs to file changes/tool payloads and parent links to generated outputs.
- Query “where did this claim/image/campaign setting come from?” and “where was this source used?”.
- Export C2PA-compatible metadata for media where applicable.
- Demo trace an unsafe caption back to untrusted source and revoke all derived drafts.

#### Idea 16 — Explainability receipts for every denial/approval (**H2**)

Turn policy decisions into developer-friendly proof.

- Decision includes evaluated context, matched rule IDs, precedence, missing grant, membership, lease and platform overlays.
- Redact context fields by schema.
- UI expandable decision path and suggested least-privilege request.
- Generate ready-to-apply policy patch, but require human review.
- Test stable explanation snapshots and absence of secret values.

### 5.3 Reliability, scale, cost, and lifecycle

#### Idea 17 — Agent versions, canary, and instant rollback (**H1/H2**)

Current edit mutates Agent in place.

- Immutable `AgentVersion`: instructions, policy, model/router, integrations, memory schema, creator, checksum.
- Runs pin version ID. Draft → shadow → canary → active → retired lifecycle.
- Route chosen percentage/test channel to new version; compare safety, quality, cost, latency.
- Rollback changes routing pointer, never rewrites history.
- UI version diff and promotion gates.
- Demo broken policy version denied/canary-failed while stable version stays active.

#### Idea 18 — Durable event log and crash-safe scheduler (**H1/H2**)

Move in-memory wakes/chatter/tokens state into durable commands/events.

- Persist current pending wakes, read cursors, lock/fencing leases, chatter/trace/conflict budgets alongside inbox, Runs, effects, and outbox in SQLite/Postgres.
- Transactionally persist message + wake; worker claims with lease and idempotency key.
- Heartbeat/expiry requeues abandoned work; dead-letter after bounded attempts.
- Outbox ensures channel/provider notification follows committed state.
- Demo kill server mid-Run/message; restart reconciles once without duplicate external effect.
- Preserve JSON migration/import for hackathon reproducibility.

#### Idea 19 — Budget and cost governor (**H1/H2**)

Control token, model, tool, network, storage, and Agent fan-out spend.

- Budgets at user/principal/trace/channel/tool/day levels; reserve before call, settle from usage receipt.
- Scheduler rejects or downgrades before exceeding hard cap.
- Soft thresholds switch model, shrink context, ask human, or pause low-priority work.
- Trace shows budget ancestry and marginal cost by step.
- Demo runaway collaboration stopped at exact budget; urgent safe task still runs in reserved pool.

#### Idea 20 — SLO-aware model/tool router (**H2/M**)

Choose model/provider/tool using task class, sensitivity, latency, quality, availability, cost, and region.

- Adapter registry with capability metadata and health metrics.
- Policy forbids sensitive tasks from providers/regions lacking required controls.
- Router emits explainable decision and fallback chain.
- Shadow evaluation compares candidates without duplicate write effects.
- Circuit breaker opens on provider failure; safe retry honours idempotency.
- Demo fast cheap route for summary, stronger route for policy analysis, local fallback during outage.

#### Idea 21 — Run checkpointing and resumable sagas (**H2/M**)

Long tasks resume from verified checkpoint, not whole conversation.

- Persist task state, completed intent receipts, workspace digest, next safe step.
- On failure/restart, reconcile each effect: committed, unknown, absent.
- Resume only idempotent step; compensate inconsistent state.
- UI checkpoint timeline and operator choose resume/compensate/abandon.
- Test crash after provider success but before local acknowledgement.

#### Idea 22 — Fleet mission control (**M**)

Operate thousands of Agents as fleet, not chat list.

- Inventory query by version, policy risk, owner, region, status, spend, incident state.
- Bulk pause/revoke/policy rollout with staged batches and automatic halt thresholds.
- Health aggregation, stuck-run detection, expiring credentials, stale versions.
- Event-driven UI/SSE and paginated APIs.
- Demo revoke vulnerable integration across fleet and prove no new calls.

#### Idea 23 — Temporal/event trigger engine (**H2/M**)

Agents respond to schedules, queues, webhooks, creator events, and moderation spikes.

- Typed trigger registry with authenticated ingress, replay protection, deduplication, rate limit.
- Trigger maps to principal/version/channel and creates root trace.
- Calendar windows and blackout rules become policy context.
- Dead-letter/replay UI; manual replay generates linked trace.
- Demo duplicate webhook causes one Run; invalid signature rejected; failed event replayed.

#### Idea 24 — Chaos and fault-injection lab (**H2/M**)

Make recovery evidence routine.

- Inject provider timeout, malformed tool response, dropped IAM, disk failure, container kill, duplicate callback, slow approval.
- Scenario DSL declares protected invariants and expected containment.
- Run in fixture environment; produce reliability scorecard and trace links.
- CI gate executes core scenarios deterministically.
- Demo “IAM unavailable” fails closed while safe next Run recovers.

### 5.4 Memory and data governance

#### Idea 25 — Governed Agent memory (**H1/H2**)

Persistent Codex thread currently acts as opaque memory. Add explicit memory plane.

- Typed records: preference, fact, task state, secret reference, ephemeral context; source, confidence, owner, labels, TTL, consent, version.
- Policy actions: memory read/write/share/delete with resource attributes.
- Retrieval records which memories entered prompt; sensitive memory never enters unauthorised Run.
- User can inspect, correct, forget, and set retention.
- Demo one Agent remembers permitted preference but cannot read another principal’s private memory; deletion removes future retrieval.

#### Idea 26 — Context firewall and least-context compiler (**H2**)

Build minimum prompt required for current task rather than last 20 messages plus broad instructions.

- Select context via task/mention lineage, channel policy, data labels, freshness, token budget.
- Summarise only after provenance-preserving redaction; retain source references.
- Measure context utilisation and leakage risk.
- UI shows “why this context was included”.
- Test unrelated secret in channel history never reaches model prompt.

#### Idea 27 — Right-to-forget propagation (**H2/M**)

Deletion must reach messages, memory, traces, model caches, derived artefacts, and exports.

- Data lineage graph supplies affected nodes.
- Tombstone workflow queues deletion/anonymisation per store/provider.
- Legal hold and audit proof separate content deletion from event existence.
- Status dashboard shows complete/pending/unsupported destinations.
- Demo delete fixture user; derived draft invalidated; audit retains non-sensitive proof.

#### Idea 28 — Privacy-preserving fleet analytics (**M/Moonshot**)

Learn common failure patterns without centralising sensitive prompts.

- Extract schema-constrained metrics locally; k-anonymity/differential privacy before aggregation.
- Never upload raw text by default.
- Detect policy hotspots, tool failure clusters, cost regressions.
- Privacy budget is explicit and auditable.
- Demo useful aggregate while single creator/message cannot be reconstructed.

### 5.5 Multi-Agent coordination

#### Idea 29 — Contract-based task graph (**H1/H2**)

Replace conversational ping-pong with typed work contracts.

- Task node declares inputs, output schema, permissions, deadline, budget, acceptance test, parent task.
- Coordinator leases node to capable Agent; result validated before downstream wake.
- Failed validation retries different Agent or escalates; no duplicate claim.
- Channels remain human-readable projection, not coordination database.
- Demo planner→researcher→reviewer pipeline with rejected malformed output and successful reassignment.

#### Idea 30 — Shared artefact exchange with capability handles (**H2**)

Sessions currently cannot safely share files.

- Content-addressed artefact store; Agent publishes immutable blob + metadata + labels.
- Recipient receives scoped read/write handle, not filesystem mount.
- Derived artefacts maintain provenance and expiry.
- Policy controls artefact class and recipient; malware/content scan on ingress.
- Demo reviewer reads build package but cannot access sibling workspace or overwrite original.

#### Idea 31 — Quorum and adversarial review (**H2/M**)

High-impact output requires independent reviewers, not one self-confident Agent.

- Workflow requests N-of-M signed verdicts from Agents with disjoint roles/policies/models.
- Evidence diversity check prevents identical-source “independence”.
- Disagreement routes to human with concise conflict map.
- Commit gateway requires quorum receipt.
- Demo two reviewers disagree on publish safety; action remains blocked until human resolves.

#### Idea 32 — Capability directory and safe Agent marketplace (**M/Moonshot**)

Agents discover best collaborator without arbitrary spawn authority.

- Publish signed capability cards: input/output schema, policy needs, quality, latency, cost, owner, version.
- Match task contract to eligible Agent while respecting delegation ceiling/data locality.
- Reputation based on verified task receipts, not self-description.
- Sandbox untrusted third-party Agents and expose only artefact handles.
- Demo automatic selection of reviewer with correct language and safety clearance.

#### Idea 33 — Distributed synchronisation and fencing service (**H2/M**)

Current FIFO locks/read cursors prove single-process design. Extend it across workers and guarantee exactly one valid committer handles each shared item, even under expiry/retry.

- Implement `LockBackend`/`ReadStateStore` with Postgres advisory/row locks or Redis plus persisted cursors.
- Add monotonically increasing fencing token to every lease; commit rejects expired/older token.
- Atomic claim with lease expiry, heartbeat, completion token, and idempotency key.
- Fairness/priority queue, bounded steal after failure, and metrics for wait/starvation.
- Trace claim conflicts and reassignments.
- Demo two server workers plus forced holder crash: countdown/queue has no duplicate or skipped item.

#### Idea 34 — Context capsule handoff (**H2**)

Transfer task without dumping whole conversation.

- Capsule contains goal, constraints, verified facts with provenance, artefact handles, open risks, budget, authority requested.
- Schema validator and policy filter remove data recipient cannot access.
- Sender/receiver sign digest; trace records acceptance/rejection.
- Demo cross-team handoff with private source excluded but usable summary preserved.

### 5.6 TikTok-shaped product extensions

These use mock services during hackathon. They are adapter packs over earlier generic primitives—not separate core systems. Core modules must compile and pass tests with TikTok adapter removed. Each plan requires unrelated fixture named in §3.1 or chosen during design review.

#### Idea 35 — Creator publishing approval studio (**H1**)

Agent drafts caption, hashtags, cover, schedule, audience, and localisation; publishing is transactional.

- Read/draft tools are low risk; publish/delete/audience change enter escrow.
- Preview exact public effect and policy checks for music rights, disclosure, minors, region, schedule.
- Creator may edit proposed intent then grant one-shot commit.
- Receipt links published post to sources, Agent version, approval, and rollback window.
- Demo injected brief tries public publish; system limits to private draft until creator approval.

#### Idea 36 — LIVE Safety Sentinel (**H1/H2**)

Multi-Agent, low-latency moderator for LIVE streams with human escalation.

- Event ingestion labels transcript/chat/gifts/user reports; rolling risk windows.
- Separate observer, policy, and action Agents; action Agent has only typed moderation tools.
- Graduated controls: flag, slow mode, mute, pause, terminate; stronger actions require quorum/human.
- Deadline-aware fallback: if classifier/approver unavailable, safest configured action.
- Replay timeline proves why action occurred and whether appeal restored state.
- Demo synthetic harassment spike versus benign slang; false-positive appeal path.

#### Idea 37 — Trend incident room (**H2**)

During viral trend, Agents correlate policy, regional, creator, and operational signals.

- Streaming trigger opens trace-rooted incident channel and typed task graph.
- Specialised Agents investigate content cluster, policy, region, creator impact, communications.
- Evidence graph deduplicates sources; claims require citations/receipts.
- Incident commander alone receives mitigation lease.
- Demo conflicting signals resolved into bounded action, not uncontrolled multi-Agent chatter.

#### Idea 38 — Ad campaign guardrails and spend escrow (**H1/H2**)

Agent can optimise campaign but cannot silently overspend or alter protected targeting.

- Campaign/budget/audience resources get field-level policy.
- Proposed changes show projected spend, audience delta, fairness/safety constraints.
- Daily and per-intent budget reservation; provider commit uses idempotency key.
- Circuit breaker stops anomalous spend velocity.
- Demo 5% bid optimisation commits; 10× budget or protected-age targeting denied and unchanged.

#### Idea 39 — Localisation swarm with cultural safety review (**H2**)

Generate market-specific captions while preventing meaning drift and cultural harm.

- Task graph fans out translators, local-policy reviewers, and consistency judge.
- Source claims/protected brand terms travel as immutable constraints.
- Semantic diff flags changed promises, disclosures, age suitability, or calls-to-action.
- Per-market publish lease only after local quorum.
- Demo one locale introduces prohibited claim; only that market branch blocked.

#### Idea 40 — Community care triage (**H2/M**)

Route comments/messages to response, moderation, wellbeing resources, or human support.

- Classification outputs confidence and data labels; no autonomous diagnosis.
- Low-risk FAQs get draft response; harassment routes moderation; crisis indicators escalate to trained human workflow.
- Strict purpose limitation and retention for sensitive signals.
- Audit measures false positives, delays, and overrides by cohort without exposing text.
- Demo uncertain case safely escalates instead of confident automated action.

#### Idea 41 — Recommendation experiment guardian (**H2/M**)

Agents may propose ranking experiments but middleware enforces safety and scientific validity.

- Experiment intent includes hypothesis, metrics, cohorts, duration, guardrails, rollback triggers.
- Policy protects minors/regions and caps traffic exposure.
- Preflight checks sample size, conflicting experiments, metric gaming, and required reviews.
- Live circuit breaker watches harm/SLO metrics; rollback receipt linked to original approval.
- Demo safe 1% canary starts; broad underage cohort blocked.

#### Idea 42 — Rights and authenticity broker (**H2/M**)

Before content generation/publishing, verify rights, consent, disclosure, and origin.

- Assets receive provenance, licence, territory, expiry, consent, synthetic-media labels.
- Policy gateway denies transformations/publication outside scope.
- Output manifest records source digests and disclosure requirements; media may carry C2PA metadata.
- Rights revocation finds and freezes derived unpublished outputs; published remediation becomes workflow.
- Demo expired audio licence blocks one region while licensed region succeeds.

#### Idea 43 — Creator “autonomy dial” with earned trust (**M**)

Creator selects observe, draft, approve-each, bounded autopilot, or emergency-stop mode per action family.

- Mode compiles into explicit policy/lease templates, not UI-only preference.
- Promotion requires version stability, low override rate, successful safety tests, bounded spend.
- Any incident automatically steps autonomy down and revokes cached leases.
- UI shows what Agent can do now in plain language.
- Demo Agent earns scheduling autonomy but publishing remains approve-each.

#### Idea 44 — Real-time brand/creator digital twin (**Moonshot**)

Simulate likely operational and audience effects before committing action.

- Twin is sandboxed state model fed by historical aggregate/fixture data.
- Action intent runs against twin; outputs uncertainty bands and constraint violations.
- Policy never treats simulation as truth; high uncertainty raises approval tier.
- Compare predicted versus actual receipt to calibrate model and detect drift.
- Demo campaign change predicted to breach budget and blocked before provider call.

### 5.7 Synchronisation-driven extensions

#### Idea 45 — Lossless cursor windows and acknowledgement protocol (**H1**)

Fix gap where server can mark unreturned messages as seen when unread count exceeds prompt/read limit.

- Replace one `seenSeq` with delivered ranges or `deliveredThrough` plus explicit page continuation.
- Wake prompt either includes every unseen state message or advances only through final included sequence.
- `read_channel` response returns `fromSeq`, `throughSeq`, `headSeq`, `hasMore`, continuation token; cursor advances to `throughSeq` only.
- Posting while `hasMore` remains produces “read next page” conflict, not false freshness.
- Compact old state into signed snapshot/checkpoint so large channels do not require unbounded replay.
- Tests: 25+ unseen messages with limit 20/5; omitted message can never be silently acknowledged.

#### Idea 46 — Semantic compare-and-set task state (**H1**)

Sequence freshness stops stale writes but cannot stop fresh duplicate or logically invalid contributions. Add typed state reducer per coordinated task.

- Channel task declares schema and reducer: countdown value, checklist items, moderation case state, campaign version.
- Agent submits `expectedVersion`, typed command, and invariant proof instead of only prose.
- Server validates transition (`10→9`, item unclaimed→claimed), commits event, then renders human message.
- Invalid fresh action returns semantic conflict with current state and allowed transitions.
- Keep free-form channels unchanged; opt in per task/thread.
- Demo malicious/redundant Agent tries `10→8` or repeats `9`; reducer rejects without relying on model prompt.

#### Idea 47 — Adaptive collaboration router (**H1/H2**)

Choose broadcast race, round-robin, specialist routing, or quorum dynamically per task phase.

- Replace global `TURN_TAKING` branch with registered `CoordinationStrategy` selected explicitly by versioned per-task `CoordinationPolicy`; never infer strategy from prompt words or demo shape.
- Coordinator uses task schema, Agent capabilities, expected contention, latency, cost budget, and required independence.
- Parallel discovery uses broadcast; ordered mutation uses single lease holder; review uses quorum; idle follow-up uses round-robin.
- Emit explainable scheduling Decision: strategy, candidates, predicted Runs/cost, fallback.
- Change strategy at checkpoints when conflict rate or latency breaches threshold.
- UI shows active coordination mode and lets human pin one.
- Demo same group task uses parallel ideation then cheap single-writer synthesis automatically.
- Unrelated proof uses deployment investigation→approval; registering it changes only TaskSpec/role metadata.

#### Idea 48 — Speculative Agent tournament with winner commit (**H2**)

Current broadcast wastes losing Runs because complete replies are discarded. Treat parallel outputs as candidates and select best before one commit.

- Wake several Agents against immutable snapshot; outputs land in private candidate set, not channel.
- Deterministic validator plus independent judge ranks schema validity, evidence, safety, novelty, latency, and cost.
- Winner alone receives commit lease; useful loser fragments attach as provenance.
- Prevent judge collusion with model/source diversity and blind candidate IDs.
- Demo three caption/planning candidates; unsafe one disqualified, best committed, all cost/evidence visible.

#### Idea 49 — Collaboration cost and contention governor (**H1/H2**)

Latest `@everyone` flow can spend N Runs per step. Turn contention into controllable budget.

- Track useful accepted contribution ratio, conflicts per accepted step, silent turns, tokens, latency, and queue time per trace.
- Preflight estimates group-task Run cost for broadcast versus turn-taking.
- Auto-switch strategy, shrink roster, or pause when marginal value falls below threshold.
- Reserve safety/recovery budget separately from creative fan-out.
- UI heatmap highlights expensive channels/Agents and projected completion budget.
- Demo five-Agent countdown automatically switches from broadcast after conflict spike and completes under cap.

#### Idea 50 — Fairness, starvation, and priority policy (**H2**)

FIFO lock fairness does not ensure Agent/task fairness across repeated rounds.

- Scheduler tracks wait age, recent wins, priority, deadline, capability fit, and per-principal quota.
- Weighted fair queue prevents fastest Agent winning every shared action.
- Emergency/safety work may pre-empt only through explicit platform policy and audit.
- Add starvation SLO and Decision when participant skipped or boosted.
- Demo slow specialist still receives required review turn under high-volume fast Agents.

#### Idea 51 — Barrier, quorum, and phase synchronisation (**H2**)

Round-robin supports sequence; many TikTok workflows need “all required reviewers arrive before publish”.

- Add barriers keyed by trace/phase with required roles, deadline, minimum quorum, optional veto.
- Each Agent posts signed typed result; barrier releases next task only after condition.
- Timeout policy chooses fail closed, degraded quorum, replacement Agent, or human escalation.
- Late/duplicate arrivals become recorded conflicts, never reopen committed phase.
- Demo localisation waits for rights+safety+market review; one veto blocks publish and explains phase state.

#### Idea 52 — Conflict-aware workspace branch and merge (**H1/H2**)

Channel writes are safe; concurrent filesystem edits remain isolated or uncontrolled. Bring same freshness model to artefacts.

- Every task gets immutable workspace base digest and Agent branch/worktree.
- File intent includes base blob hash, patch, tests, semantic owner/lock.
- Non-overlapping patches merge automatically; overlaps create structured conflict and regeneration context.
- Accepted merge advances artefact version and provenance; stale patch never silently overwrites.
- UI diff shows candidates, winner, tests, merge receipt.
- Demo two Agents edit same file: compatible changes merge; overlapping function change routes reviewer.

#### Idea 53 — Exactly-once external effect fence (**H1**)

Channel exactly-one outcome does not stop duplicate TikTok/MCP side effects during timeout/retry.

- Derive provider idempotency key from trace, intent, canonical args, and effect version.
- Acquire resource fence before call; persist “prepared” record and fencing token.
- After ambiguous timeout, reconcile provider by idempotency/external ID before retry.
- Commit receipt atomically marks effect; stale holder/token cannot report success.
- Provider without idempotency uses gateway ledger plus read-before-write/compensation.
- Demo response drops after successful mock publish; retry observes receipt and creates no duplicate post.

#### Idea 54 — Contention observatory and coordination debugger (**H2**)

Make races understandable without polluting outcome trace.

- Preserve two projections: product timeline hides internal conflicts; operator timeline shows locks, cursors, candidates, waits, expiry, regeneration.
- Visualise channel sequence, each Agent read frontier, lock owner/waiters, accepted/rejected branch.
- Calculate conflict rate, wasted tokens, fairness, regeneration success, silent termination.
- “Why stale?” opens missing sequence range and delivery proof.
- Replay lock schedule deterministically from recorded events.
- Demo hidden clean countdown beside engineering view explaining every lost race.

#### Idea 55 — Knowledge-freshness leases (**H2/M**)

Channel freshness is local. Tool results, policies, prices, safety rules, and creator state also age.

- Read receipt includes source version, ETag/digest, observed time, and freshness TTL.
- Risky intent declares dependencies and maximum staleness.
- Commit gateway revalidates dependencies; changed policy/audience/budget causes conflict and regeneration.
- Cached source can be used only inside policy-defined freshness window.
- Demo Agent plans campaign from budget v4; human changes to v5; stale commit rejected with exact changed dependency.

#### Idea 56 — Multi-Agent creator operations room (**H1/H2**)

TikTok-shaped showcase combining synchronisation with typed real work rather than countdown toy.

- Roles: trend analyst, rights reviewer, safety reviewer, localisation Agent, publishing Agent.
- Parallel discovery produces candidate evidence; barriers collect required reviews; task-state reducer owns draft lifecycle.
- Publishing Agent alone holds scoped effect lease; external publish uses exactly-once fence.
- Adaptive router switches parallel research → quorum review → single-writer commit.
- UI product timeline stays clean while contention observatory exposes middleware proof.
- Demo trend-triggered draft reaches one safe regional publish despite simultaneous edits, one stale rule, and one duplicate callback.
- Generality proof runs same task graph/strategies/barriers/fence for package release: analyst→security reviewer→test reviewer→deployer; only schemas/adapters/labels change.

## 6. Prioritised build options

| Option | Bundle | Novelty | Three-day fit | Demo clarity | Main risk |
| --- | --- | ---: | ---: | ---: | --- |
| A — Trust Fabric | Ideas 1+2+3+11, creator publish fixture | Very high | High if tightly scoped | Excellent | Too many controls; build vertical slice only |
| B — Crash-proof Agent transactions | Ideas 2+18+21 | High | Medium | Excellent | State-machine complexity |
| C — Policy time machine | Ideas 8+11+12+16 | High | High | Excellent | Replay semantics must be honestly labelled |
| D — LIVE Safety Sentinel | Ideas 6+7+13+36 | Very high | Medium | Visually strong | Streaming/UI scope |
| E — Versioned safe rollout | Ideas 10+17+24 | High | High | Strong | Needs meaningful quality/safety fixture |
| F — Governed memory | Ideas 25+26+27 | High | Medium | Strong | Model context instrumentation |
| G — Spend-safe campaign Agent | Ideas 1+2+19+38 | Very high | High | Excellent | Mock economics must stay credible |
| H — Consensus-to-Commit | Ideas 45+46+53+56 | Very high | High | Excellent | Keep task schema and provider fixture narrow |

Recommendation after synchronisation update: **Option H — Consensus-to-Commit**. It turns impressive countdown middleware into TikTok-shaped business proof: several Agents may reason concurrently, but typed state transition and external effect commit exactly once against current data. Reuse `performSynced`, conflicts, regeneration, audit, and clean/operator trace projections. Add one mock publish/campaign tool, one typed reducer, one idempotency fence. If team wants broader security framing, present H as execution core inside **Option A — Trust Fabric**. Lowest-risk alternative remains **Option C**.

## 7. Concrete implementation map

| Concern | Existing seam | Likely files |
| --- | --- | --- |
| New persisted entities | `Database`, `JsonStore` migration | `apps/server/src/types.ts`, `store.ts` |
| Freshness/locking/conflicts | `SyncBackend`, `performSynced`, sequence migration | `sync.ts`, `agent-service.ts`, `store.ts` |
| Intent/lease evaluation | `AgentService.decide`, `evaluateToolCall`, approval resolver | `agent-service.ts`, `policy.ts` |
| Tool canonicalisation | `mapToolCall` | `policy.ts` or new `intent.ts` |
| Pre-tool protocol | Hook POST payload/result | `runtime/iam-hook.mjs`, `app.ts` |
| External write gateway | MCP configuration and integration discovery | `integration-service.ts`, new gateway/fixture service |
| Versioned Runtime config | `renderCodexHome` | `codex-home.ts` |
| Trace evidence | `Trace`, `RunEvent`, decision capture | `types.ts`, `agent-service.ts`, `codex-runner.ts` |
| Approval experience | Approval cards | `ChannelView.tsx`, `TraceView.tsx`, `types.ts`, `api.ts` |
| Intent preview/evidence UI | Inspector/trace expansion | `Inspector.tsx`, `TraceView.tsx` |
| Container network control | invocation builder | `container-codex-runner.ts`, POC script |
| Verification | Existing unit/integration pattern | adjacent `*.test.ts`; add one browser E2E if time |

Suggested modules instead of further enlarging `agent-service.ts`:

- `core/contracts/`: domain-neutral interfaces/types only; no provider/product imports;
- `core/coordination/`: strategy registry, state-machine host, barriers, fairness, cursors/fences;
- `adapters/`: domain/provider implementations loaded through registry;
- `fixtures/creator-ops/` and `fixtures/deployment/`: primary and unrelated proofs using same core;
- `intent-service.ts`: canonicalisation, risk, lifecycle, receipts;
- `lease-service.ts`: issue/evaluate/consume/revoke;
- `label-policy.ts`: data labels and flow decisions;
- `evidence-service.ts`: append-only ledger, sealing, export, verification;
- `mock-publish-provider.ts`: deterministic protected fixture and compensation.

Enforce dependency direction with TypeScript project references, ESLint/import-boundary rule, or lightweight CI scan: `core/**` cannot import `adapters/**` or contain demo-domain vocabulary. Each adapter implements shared conformance suite.

## 8. Demo script for recommended option

Target: 2:40, leaving 20 seconds contingency.

1. **0:00–0:20** — Show creator operations room: trend, rights, safety, localisation, publisher; one protected mock post and Consensus-to-Commit diagram.
2. **0:20–0:50** — Send `@everyone` campaign request. Parallel Agents race/contribute; clean channel shows useful outcome, Run/audit view proves lost races and regeneration.
3. **0:50–1:20** — Typed reducer collects rights+safety approvals and one localised draft. Attempted skip/duplicate transition is rejected as semantic conflict.
4. **1:20–1:45** — Publisher proposes exact external intent. Human grants scoped once; provider fence commits one post and records receipt.
5. **1:45–2:10** — Simulate dropped provider response and retry. Reconciliation finds receipt: no duplicate post. Then change dependency/budget and show stale intent rejected.
6. **2:10–2:30** — Toggle operator contention view: sequence/cursors, winners, conflicts, barrier, state versions, one provider effect.
7. **2:30–2:40** — Run safe follow-up after containment, proving system remains controllable.

Automated evidence:

- paginated prompt/read advances cursor only through delivered sequence;
- concurrent same-state commands accept exactly one valid transition;
- fresh but semantically invalid duplicate/skip is rejected;
- barrier cannot release without required roles/quorum;
- canonical external intent produces stable idempotency key;
- timeout-after-provider-success reconciles to one effect;
- stale/expired fencing token and changed dependency are denied;
- clean product projection and full operator projection derive from same evidence;
- same state/coordination/effect contract passes deployment or inventory fixture without core edits;
- CI boundary check finds no demo-domain imports/branches in core;
- existing `npm run check` remains green.

## 9. Submission checklist

- [ ] README names one middleware thesis and acknowledges existing baseline extensions.
- [ ] One command starts deterministic demo without external integration account.
- [ ] New behaviour runs at hook/gateway/control-plane boundary, not only UI.
- [ ] Design identifies domain-neutral primitive and stable extension interface.
- [ ] Primary fixture and unrelated second fixture use identical core without core edits.
- [ ] Core contains no prompt phrase, product name, magic demo value, or domain-specific scheduler branch.
- [ ] Strategy/schema/policy/adapter versions persist with evidence.
- [ ] Backend invariant tests use generated inputs/contention schedules, not only rehearsed transcript.
- [ ] Normal case mutates fixture only after valid scoped authority.
- [ ] Concurrent case accepts one valid state transition and one external effect.
- [ ] Stale, duplicate, expired-lease, and ambiguous-timeout paths reconcile without duplicate effect.
- [ ] Abuse/failure case leaves protected fixture unchanged or demonstrably compensated.
- [ ] Trace identifies precise rule/intent/effect and avoids secrets.
- [ ] Automated tests cover bypasses and failure path.
- [ ] Architecture diagram marks browser, control plane, Runtime, gateway, provider, credential, and trust boundaries.
- [ ] Limitations state mock provider, classifier limits, non-production container, single human/store.
- [ ] `npm run check` passes from clean install.
- [ ] No credentials in source, Git history, logs, trace, screenshots, browser storage, or demo output.

## 10. Implementation file map

| Path | Responsibility |
| --- | --- |
| `README.md` | Setup, product overview, deployment, current public story |
| `docs/PROBLEM_STATEMENT.md` | Official challenge wording and deliverables |
| `docs/ARCHITECTURE.md` | Compact system architecture |
| `docs/MULTI_AGENT_IAM.md` | Existing IAM, scheduling, integrations, trace design |
| `docs/SYNCHRONISATION.md` | Lock/read-cursor invariants, conflict/regeneration protocol, turn-taking |
| `apps/server/src/app.ts` | HTTP validation, shared auth, human and run-token routes |
| `apps/server/src/agent-service.ts` | Lifecycle, channels, scheduler, IAM decisions, delegation, approvals, Runs, traces |
| `apps/server/src/sync.ts` | FIFO expiring locks, read cursors, state heads, unseen messages, conflict feedback, silent sentinel |
| `apps/server/src/policy.ts` | Presets, glob/resource matching, delegation derivation, overrides, tool mapping, exec rules |
| `apps/server/src/codex-home.ts` | Per-Agent tool surface, sandbox/network config, integrations, hooks/rules files |
| `apps/server/src/integration-service.ts` | MCP registration, OAuth, discovery, credentials selection, Agent tool scoping |
| `apps/server/src/codex-runner.ts` | Host Codex process, protocol parsing, limits, cancellation |
| `apps/server/src/container-codex-runner.ts` | Disposable container command and lifecycle |
| `apps/server/src/store.ts` | Versioned atomic JSON persistence and migration |
| `apps/server/src/workspace.ts` | Per-Agent workspace, generated instructions, archive |
| `runtime/iam-hook.mjs` | Fail-closed pre-tool policy callback |
| `runtime/mcp-launchpad.mjs` | Agent-facing channel/delegation/capability MCP server |
| `apps/web/src/App.tsx` | UI state, polling, routing, main actions |
| `apps/web/src/components/AgentWizard.tsx` | Agent/policy/integration/membership authoring |
| `apps/web/src/components/ChannelView.tsx` | Messages, approval cards, Run/trace links |
| `apps/web/src/components/Inspector.tsx` | Agent details, policy, Runs, decisions, audit |
| `apps/web/src/components/TraceView.tsx` | Cross-channel causal trace tree/timeline |
| `apps/web/src/components/IntegrationsPanel.tsx` | MCP integration operations |
| `apps/server/src/*.test.ts` | Current behavioural contract and safest extension examples |
| `apps/server/src/channel-sync.test.ts` | End-to-end contention, regeneration, turn-taking, countdown, registry/approval race contract |
| `apps/server/src/sync.test.ts` | Lock, lease, cursor, head, unseen-state, and silence unit contract |

## 11. Maintenance rule

Update this file when any persisted type, API route, policy semantic, scheduler rule, runtime boundary, integration flow, trace schema, or UI capability changes. Mark planned feature as implemented only after source, invariant tests, primary adapter, unrelated second adapter, and zero-core-change generality proof exist. If implementation introduces product/demo-specific branch into core, mark it overfit and refactor before promotion.
