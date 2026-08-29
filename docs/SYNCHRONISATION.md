# Per-channel synchronisation

Several agents woken by the same message run concurrently. Without
coordination each one acts on the view it had at wake time, so two agents can
both "succeed" on the same stale state: duplicate answers, skipped steps,
replies to questions that were already answered. This document describes the
server-side mechanism that prevents it. It complements
[MULTI_AGENT_IAM.md](MULTI_AGENT_IAM.md): IAM decides whether an agent *may*
act; synchronisation decides whether it acted on *current* state.

## Invariants (enforced by the server, never by trusting the model)

1. **Mutual exclusion per resource.** At most one actor holds a resource's
   lock at a time. The lock scopes one action — validate and commit inside a
   single store mutation — and is released in `finally`. A lease expires a
   holder that never returns, so a crashed run cannot leak it.
2. **Read-before-act.** An agent's write to a channel is accepted only if the
   server has shown it every state-bearing message in that channel. "Seen" is
   a server-side cursor the model cannot fake.
3. **Conflict → feedback → regenerate.** A rejected action returns who won,
   what they did, every message the agent has not seen, and an instruction to
   reconsider. An identical retry without re-reading fails again; a retry
   after re-reading, on a channel that has not moved, succeeds.

Both invariants apply to every path that writes to a channel on an agent's
behalf: the `post_message` tool and the server's automatic post of a run's
final reply.

## Mechanism

### Sequence numbers

Every message carries `seq`, a 1-based, strictly increasing position in its
channel; each channel records `lastSeq`. Feedback refers to messages as
`#general/12`. Existing databases are numbered on startup.

### What counts as state

`STATE_KINDS = message | spawn | approval` — things collaborators did.
`system`, `denial` and `conflict` messages bump `seq` but are excluded from
the *head* used for validation, so a server notice can never make anyone's
view stale (no feedback storms).

### The read cursor

In memory, `agentId → channelId → seq`, behind `ReadStateStore`. Advanced only
when the server serves the channel to the agent:

| When | Cursor becomes |
| --- | --- |
| A wake prompt is built (inside the run-start mutation, from the same snapshot) | channel `lastSeq` |
| `read_channel` returns | channel `lastSeq` |
| A post is accepted | the new message's `seq` |

A conflict response does **not** advance it: the feedback lists the unseen
messages, but they only count as read once the agent calls `read_channel`
(tool path) or receives its regenerate prompt (auto-post path). Human posts
never touch cursors; they bump `lastSeq`, so every agent's view goes stale
until it re-reads. After a restart cursors are seeded from each run's
`seenSeq` and each agent's own posts.

### The lock

`LockBackend` (in-memory default): FIFO waiters per key, a bounded wait
(5 s) and a lease (10 s). The store's mutation queue already serialises
writes in one process; the lock is the seam for a distributed backend and
supplies the waiting and lease semantics. Keys: `channel:<id>`, `channels`
(the registry), `approval:<id>`.

### The primitive

```ts
performSynced({
  resource,                 // lock key
  holder,                   // "run:<id>" | "agent:<id>" | "user"
  validate: (db) => Conflict | null,   // stale? → who won, what they did, what's unseen
  commit:   (db) => T,                 // same mutation, only if validate passed
  onConflict?: (db, conflict) => void, // same mutation, e.g. post a notice
  busy:     (holder) => Conflict,      // lock wait timed out
})
```

Consumers: channel posts (`agentChannelPost` for the tool, `finishRun` for the
automatic reply, which also folds the run's completion bookkeeping into the
same mutation), `createChannel` (name uniqueness), `resolveApproval`
(status still pending). **Wiring a new action** is a resource key, a
`validate` and a `commit`; see `createChannel` for a ten-line example.

### Conflict feedback contract

A `Conflict` carries `cause` (`stale` | `busy`), the winner (`winnerName`,
`winnerContent`, `winnerSeq`, `winnerMessageId`), `rejectedContent`, the
`unseen` messages, `seenSeq`/`headSeq`, `attempt`/`limit`, and `feedback`, the
model-facing text. For the tool it is the 409 body (`error` = feedback,
`conflict` = the structure), which the MCP server surfaces as the tool error:

```
Your post to #general was not accepted: the channel changed since you last read it.
AgentA posted "10" (#general/12) before you.
Unseen since your last read (1 message):
  #12 AgentA: "10"
Your rejected post was: "10"
Re-read #general with read_channel, reconsider your plan in light of what AgentA did,
and post a new message only if it still adds something. Do not repeat your previous message.
This is conflict 1 of 3 allowed in this turn.
```

### The automatic reply

When a run ends, its reply goes through the same check under the channel
lock. If the channel moved on during the run, the reply is **not posted**:
the run completes with `conflict` set (and a `conflict` run event), a notice
lands in the channel, and a **regenerate turn** is queued — a new run with
`trigger: "conflict"` hung off the winning message, whose prompt carries the
feedback (what beat it, what it tried, the messages since it last read, "do
not repeat; if fully handled reply `[no reply]`"). It merges with any pending
wake for that channel so the agent gets one turn, not two. Dropping the reply
would lose work; re-waking without the feedback would repeat the race.

### Bounds and fairness

- `MAX_CONFLICTS_PER_TURN = 3`, counted across a regenerate chain and across
  tool posts in one run. Past it the notice says the agent stopped and no
  further turn is queued; the tool returns a "stop calling post_message"
  error.
- Waiters are FIFO; the human's post takes the lock too (so it never
  interleaves with an agent's validate+commit) but is never stale.
- Locks are held for one mutation, never across a turn.

### `[no reply]`

A run whose final reply is exactly `[no reply]` posts nothing and wakes
nobody (`run.silent = true`). It lets a collaboration end without a budget
kill.

## Observability

Every check leaves a `Decision` with `source: "sync"` and `effect: "allow"`
or **`"conflict"`** — a third effect value, never confusable with a policy
`deny` (HTTP 409 vs 403). Lost races are also stored as `conflict` messages
in the channel — hidden in the channel and trace views so both show only
outcomes — and surface as a `conflict` run event and on the run card ("lost
race", "regenerate", "no reply"). The trace view shows the regenerate run
under the message that won.

## Keeping a group task moving

Agents wake only when addressed: everyone in a DM, `@mentioned` agents in a
public channel, and `@everyone` wakes every member. A group task therefore
moves because collaborators **end each contribution with `@everyone`** (the
instructions and the wake prompt tell them to). Every step is then a race
among all N agents; the lock and read-before-act check accept one, the others
regenerate from what won. It costs about N−1 runs per step but keeps the
scheduler dumb, the contention visible, and nothing hidden in server logic.
When the task is done each agent answers `[no reply]` and the chain ends.

`TURN_TAKING=on` is an alternative: an agent's message inside a collaboration
(a trace with two or more agents that have run in that channel) also wakes the
**next participant** after the author, round-robin, and a `[no reply]` passes
the turn until a full circle has passed. One run per step, no mentions
needed, but the server decides who speaks next. Off by default.

`CHATTER_BUDGET` (agent turns in a channel without a human message) and
`TRACE_BUDGET` (runs one prompt may cause) default to 64 and are configurable.
A ten-step countdown with N agents costs roughly 10(N−1) + 2N runs with
`@everyone` and 3N + 10 with turn-taking (18 observed with three agents,
24 with five).

## Demo

Three agents in `#general`, then:

```text
@everyone count down from 10 to 1, one number per message, take turns.
```

All three answer "10 @everyone" at once. One is accepted; the other two lose
the race and regenerate with 9. Each accepted number wakes everyone again, so
every step is a race, and the losers keep regenerating from what won: 8, 7, …
1, then `[no reply]` all round. The channel and the trace show just the
countdown; the Decisions section shows the `sync` rows (*"Lost the race:
AgentA posted #5 after this agent's last read (#4)"*), and the run cards show
"lost race" and "regenerate".

## Limitations

- Cursors are in memory (seeded on restart); a distributed backend would
  persist them alongside the lock.
- The server checks state, not meaning: an agent that re-reads and then
  repeats the winner verbatim is accepted. The feedback and AGENTS.md are what
  stop that.
- Only channels, the channel registry and approvals are wired; spawning and
  closing sessions are natural next consumers.
