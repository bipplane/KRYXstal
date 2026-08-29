import { describe, expect, it } from "vitest";
import {
  channelHead,
  InMemoryLockBackend,
  InMemoryReadState,
  isNoReply,
  LockTimeoutError,
  unseenMessages,
} from "./sync.js";
import type { ChannelMessage, Database } from "./types.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("InMemoryLockBackend", () => {
  it("grants free locks immediately and hands them to waiters in FIFO order", async () => {
    const locks = new InMemoryLockBackend();
    const first = await locks.acquire("channel:x", "a");
    expect(locks.holderOf("channel:x")).toBe("a");
    const order: string[] = [];
    const second = locks.acquire("channel:x", "b").then((lease) => {
      order.push("b");
      return lease;
    });
    const third = locks.acquire("channel:x", "c").then((lease) => {
      order.push("c");
      return lease;
    });
    await tick();
    expect(order).toEqual([]);
    first.release();
    const leaseB = await second;
    expect(order).toEqual(["b"]);
    expect(locks.holderOf("channel:x")).toBe("b");
    leaseB.release();
    const leaseC = await third;
    expect(order).toEqual(["b", "c"]);
    leaseC.release();
    expect(locks.holderOf("channel:x")).toBeNull();
    // Different keys never wait on each other.
    const other = await locks.acquire("channel:y", "d", { waitMs: 10 });
    other.release();
  });

  it("times out a bounded wait and names the holder", async () => {
    const locks = new InMemoryLockBackend();
    const lease = await locks.acquire("k", "holder");
    await expect(locks.acquire("k", "waiter", { waitMs: 20 })).rejects.toBeInstanceOf(LockTimeoutError);
    await expect(locks.acquire("k", "waiter", { waitMs: 20 })).rejects.toMatchObject({ holder: "holder" });
    lease.release();
  });

  it("expires a lease the holder never released so a dead run cannot leak the lock", async () => {
    const locks = new InMemoryLockBackend({ leaseMs: 30 });
    await locks.acquire("k", "crashed"); // never released
    const next = await locks.acquire("k", "next", { waitMs: 500 });
    expect(locks.holderOf("k")).toBe("next");
    expect(locks.expired).toEqual([{ key: "k", holder: "crashed" }]);
    next.release();
  });

  it("makes release idempotent and ignores a stale release after expiry", async () => {
    const locks = new InMemoryLockBackend({ leaseMs: 20 });
    const stale = await locks.acquire("k", "old");
    await sleep(40);
    const fresh = await locks.acquire("k", "new");
    stale.release(); // expired long ago; must not evict "new"
    stale.release();
    expect(locks.holderOf("k")).toBe("new");
    fresh.release();
    fresh.release();
    expect(locks.holderOf("k")).toBeNull();
  });
});

describe("InMemoryReadState", () => {
  it("only ever moves cursors forward", () => {
    const reads = new InMemoryReadState();
    expect(reads.get("a", "channel:1")).toBe(0);
    reads.advance("a", "channel:1", 5);
    reads.advance("a", "channel:1", 3);
    expect(reads.get("a", "channel:1")).toBe(5);
    expect(reads.get("a", "channel:2")).toBe(0);
    reads.clear("a");
    expect(reads.get("a", "channel:1")).toBe(0);
  });
});

describe("channel state helpers", () => {
  const message = (
    seq: number,
    kind: ChannelMessage["kind"],
    authorId: string,
    channelId = "c",
  ): ChannelMessage => ({
    id: "m" + String(seq),
    channelId,
    authorId,
    authorName: authorId,
    authorKind: authorId === "user" ? "user" : "principal",
    kind,
    content: "msg " + String(seq),
    runId: null,
    approvalId: null,
    seq,
    traceId: "m" + String(seq),
    parentMessageId: null,
    createdAt: "2026-01-01T00:00:0" + String(seq) + ".000Z",
  });
  const database = {
    version: 2,
    agents: [],
    channels: [],
    messages: [
      message(1, "message", "user"),
      message(2, "message", "a"),
      message(3, "system", "system"),
      message(4, "denial", "b"),
      message(5, "conflict", "b"),
      message(6, "message", "x", "other"),
    ],
    runs: [],
    decisions: [],
    approvals: [],
  } as unknown as Database;

  it("ignores server notices when deciding what counts as channel state", () => {
    expect(channelHead(database, "c")?.seq).toBe(2);
    expect(unseenMessages(database, "c", "b", 0).map((m) => m.seq)).toEqual([1, 2]);
    expect(unseenMessages(database, "c", "a", 1).map((m) => m.seq)).toEqual([]);
    expect(channelHead(database, "nope")).toBeNull();
  });

  it("recognises the no-reply sentinel loosely but not ordinary text", () => {
    for (const text of ["[no reply]", "[No Reply]", "no reply", " `[no reply]` ", '"[no-reply]".']) {
      expect(isNoReply(text)).toBe(true);
    }
    for (const text of ["no reply needed", "I have no reply to that", "10", ""]) {
      expect(isNoReply(text)).toBe(false);
    }
  });
});
