import type { ChannelMessage, Conflict, Database, MessageKind } from "./types.js";

/**
 * Per-resource synchronisation for multi-agent collaboration.
 *
 * Two pieces, both server-side and both behind interfaces so a distributed
 * backend can replace the in-memory one later:
 *
 * - `LockBackend`: a FIFO mutex per resource key with a bounded wait and a
 *   lease. The lock scopes one action (validate + commit inside a single store
 *   mutation); it is released in `finally` and, if a holder ever fails to
 *   release, the lease expires it so a crashed run cannot leak it.
 * - `ReadStateStore`: what each actor has *seen* of a resource, as the channel
 *   `seq` the server last served it. Only the server advances it (wake prompts,
 *   `read_channel`, successful posts); the model cannot fake it.
 *
 * A write is accepted only when the actor's read cursor covers every message
 * that counts as channel state (`STATE_KINDS`). Anything else is a `Conflict`:
 * not a policy denial, but "someone acted first, here is what you missed".
 */

export const LOCK_WAIT_MS = 5_000;
export const LOCK_LEASE_MS = 10_000;

/** Message kinds that constitute channel state an agent must have seen before it acts. */
export const STATE_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>([
  "message",
  "spawn",
  "approval",
]);

export class LockTimeoutError extends Error {
  constructor(
    public readonly key: string,
    public readonly holder: string | null,
  ) {
    super("Timed out waiting for lock on " + key + (holder ? " held by " + holder : ""));
    this.name = "LockTimeoutError";
  }
}

export interface Lease {
  key: string;
  holder: string;
  /** Idempotent. */
  release(): void;
}

export interface LockOptions {
  waitMs?: number | undefined;
  leaseMs?: number | undefined;
}

export interface LockBackend {
  acquire(key: string, holder: string, options?: LockOptions): Promise<Lease>;
  /** Current holder, for diagnostics and tests. */
  holderOf(key: string): string | null;
}

interface Waiter {
  holder: string;
  leaseMs: number;
  resolve: (lease: Lease) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface LockState {
  holder: string;
  leaseTimer: NodeJS.Timeout;
  released: boolean;
}

export class InMemoryLockBackend implements LockBackend {
  private readonly locks = new Map<string, LockState>();
  private readonly waiters = new Map<string, Waiter[]>();
  /** Lease expiries, for tests and logs. */
  readonly expired: Array<{ key: string; holder: string }> = [];

  constructor(private readonly defaults: LockOptions = {}) {}

  acquire(key: string, holder: string, options: LockOptions = {}): Promise<Lease> {
    const waitMs = options.waitMs ?? this.defaults.waitMs ?? LOCK_WAIT_MS;
    const leaseMs = options.leaseMs ?? this.defaults.leaseMs ?? LOCK_LEASE_MS;
    if (!this.locks.has(key)) {
      return Promise.resolve(this.grant(key, holder, leaseMs));
    }
    return new Promise<Lease>((resolve, reject) => {
      const queue = this.waiters.get(key) ?? [];
      const waiter: Waiter = {
        holder,
        leaseMs,
        resolve,
        reject,
        timer: setTimeout(() => {
          const pending = this.waiters.get(key) ?? [];
          const index = pending.indexOf(waiter);
          if (index !== -1) pending.splice(index, 1);
          reject(new LockTimeoutError(key, this.holderOf(key)));
        }, waitMs),
      };
      waiter.timer.unref();
      queue.push(waiter);
      this.waiters.set(key, queue);
    });
  }

  holderOf(key: string): string | null {
    return this.locks.get(key)?.holder ?? null;
  }

  private grant(key: string, holder: string, leaseMs: number): Lease {
    const state: LockState = {
      holder,
      released: false,
      leaseTimer: setTimeout(() => {
        if (state.released) return;
        this.expired.push({ key, holder });
        this.release(key, state);
      }, leaseMs),
    };
    state.leaseTimer.unref();
    this.locks.set(key, state);
    return { key, holder, release: () => this.release(key, state) };
  }

  private release(key: string, state: LockState): void {
    if (state.released) return;
    state.released = true;
    clearTimeout(state.leaseTimer);
    if (this.locks.get(key) !== state) return;
    this.locks.delete(key);
    const queue = this.waiters.get(key);
    const next = queue?.shift();
    if (queue && queue.length === 0) this.waiters.delete(key);
    if (next) {
      clearTimeout(next.timer);
      next.resolve(this.grant(key, next.holder, next.leaseMs));
    }
  }
}

export interface ReadStateStore {
  /** Newest `seq` of `key` the actor has been shown; 0 when never. */
  get(actorId: string, key: string): number;
  /** Monotonic: never moves a cursor backwards. */
  advance(actorId: string, key: string, seq: number): void;
  clear(actorId: string): void;
}

export class InMemoryReadState implements ReadStateStore {
  private readonly cursors = new Map<string, Map<string, number>>();

  get(actorId: string, key: string): number {
    return this.cursors.get(actorId)?.get(key) ?? 0;
  }

  advance(actorId: string, key: string, seq: number): void {
    const own = this.cursors.get(actorId) ?? new Map<string, number>();
    if (seq > (own.get(key) ?? 0)) own.set(key, seq);
    this.cursors.set(actorId, own);
  }

  clear(actorId: string): void {
    this.cursors.delete(actorId);
  }
}

export interface SyncBackend {
  locks: LockBackend;
  reads: ReadStateStore;
}

export function createInMemorySync(options: LockOptions = {}): SyncBackend {
  return { locks: new InMemoryLockBackend(options), reads: new InMemoryReadState() };
}

export const channelKey = (channelId: string): string => "channel:" + channelId;

/** Newest state-bearing message in a channel; what an actor must have seen to write. */
export function channelHead(database: Database, channelId: string): ChannelMessage | null {
  let head: ChannelMessage | null = null;
  for (const message of database.messages) {
    if (message.channelId !== channelId || !STATE_KINDS.has(message.kind)) continue;
    if (!head || message.seq > head.seq) head = message;
  }
  return head;
}

/** State-bearing messages in a channel the actor has not been shown, oldest first. */
export function unseenMessages(
  database: Database,
  channelId: string,
  actorId: string,
  seenSeq: number,
): ChannelMessage[] {
  return database.messages
    .filter(
      (message) =>
        message.channelId === channelId &&
        message.seq > seenSeq &&
        STATE_KINDS.has(message.kind) &&
        message.authorId !== actorId,
    )
    .sort((left, right) => left.seq - right.seq);
}

/** A run whose final reply is exactly this posts nothing and wakes nobody. */
export const NO_REPLY = "[no reply]";

export function isNoReply(output: string): boolean {
  return /^[\s"'`*_]*\[?\s*no[\s_-]?reply\s*\]?[\s"'`*_.]*$/i.test(output);
}

export function quote(content: string, max = 160): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return '"' + (flat.length > max ? flat.slice(0, max - 1) + "…" : flat) + '"';
}

/** Model-facing feedback for a lost race on a channel. */
export function renderConflictFeedback(conflict: Conflict, channelName: string): string {
  const lines: string[] = [];
  if (conflict.cause === "busy") {
    lines.push(
      "Your post to #" +
        channelName +
        " was not accepted: the channel is busy with another agent's write and the wait timed out.",
    );
  } else {
    lines.push(
      "Your post to #" + channelName + " was not accepted: the channel changed since you last read it.",
    );
    if (conflict.winnerName && conflict.winnerContent !== null) {
      lines.push(
        conflict.winnerName +
          " posted " +
          quote(conflict.winnerContent) +
          " (#" +
          channelName +
          "/" +
          String(conflict.winnerSeq ?? "?") +
          ") before you.",
      );
    }
    if (conflict.unseen.length > 0) {
      lines.push(
        "Unseen since your last read (" +
          String(conflict.unseen.length) +
          (conflict.unseen.length === 1 ? " message):" : " messages):"),
      );
      for (const message of conflict.unseen) {
        lines.push("  #" + String(message.seq) + " " + message.authorName + ": " + quote(message.content, 300));
      }
    }
  }
  lines.push("Your rejected post was: " + quote(conflict.rejectedContent));
  lines.push(
    "Re-read #" +
      channelName +
      " with read_channel, reconsider your plan in light of what " +
      (conflict.winnerName ?? "the others") +
      " did, and post a new message only if it still adds something. Do not repeat your previous message.",
  );
  lines.push(
    "This is conflict " +
      String(conflict.attempt) +
      " of " +
      String(conflict.limit) +
      " allowed in this turn.",
  );
  return lines.join("\n");
}
