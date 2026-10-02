import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore, historyReference } from "../src/history-store.ts";
import { HISTORY_RETENTION_MS, type HistoryEventInput, type HistorySession } from "../src/history-types.ts";

const T0 = Date.UTC(2026, 8, 1);
const dirs: string[] = [];
const stores: HistoryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omp-history-"));
  dirs.push(dir);
  const clock = { now: T0 };
  const path = join(dir, "nested", "history.db");
  const open = () => {
    const store = new HistoryStore(path, () => clock.now);
    stores.push(store);
    return store;
  };
  return { clock, open, store: open() };
}

const session = (id: string, workspaceId = "ws-a"): HistorySession => ({
  id,
  workspaceId,
  cwd: `/work/${workspaceId}`,
  agentId: `agent-${id}`,
  agentKind: "main",
  startedAt: T0,
  cloudSpace: "repo",
});

const event = (sessionId: string, key: string, at: number, extra: Partial<HistoryEventInput> = {}): HistoryEventInput => ({
  key,
  sessionId,
  kind: "tool.result",
  occurredAt: at,
  observedAt: at,
  summary: `event ${key}`,
  source: "tool",
  ...extra,
});

test("queries are workspace-scoped and filter by session, path, time, outcome and text; evidence only on request", () => {
  const { store } = setup();
  store.registerSession(session("s1"));
  store.registerSession(session("s2"));
  store.registerSession(session("other", "ws-b"));
  store.append(
    event("s1", "a", T0, { kind: "file.deleted", path: "/work/ws-a/src/legacy.ts", outcome: "completed", evidence: "deleted legacy file" }),
  );
  store.append(
    event("s1", "b", T0 + 1000, { kind: "file.deleted", path: "/work/ws-a/src/other.ts", outcome: "failed", summary: "delete denied" }),
  );
  store.append(
    event("s2", "c", T0 + 2000, {
      kind: "file.moved",
      fromPath: "/work/ws-a/src/legacy.ts",
      path: "/work/ws-a/src/new.ts",
      outcome: "completed",
    }),
  );
  store.append(event("other", "d", T0, { path: "/work/ws-b/src/legacy.ts", summary: "legacy in another workspace" }));

  const byPath = store.query({ workspaceId: "ws-a", path: "/work/ws-a/src/legacy.ts" }).events;
  expect(byPath.map((e) => e.key)).toEqual(["c", "a"]);
  expect(byPath[1]!.evidence).toBeUndefined();
  expect(store.query({ workspaceId: "ws-a", path: "/work/ws-a/src", outcome: "completed" }).events.map((e) => e.key)).toEqual(["c", "a"]);
  expect(store.query({ workspaceId: "ws-a", path: "/work/ws-a/sr" }).events).toEqual([]);
  expect(store.query({ workspaceId: "ws-a", sessionId: "s1", outcome: "failed" }).events.map((e) => e.key)).toEqual(["b"]);
  expect(store.query({ workspaceId: "ws-a", from: T0 + 500, to: T0 + 1500 }).events.map((e) => e.key)).toEqual(["b"]);
  expect(store.query({ workspaceId: "ws-a", query: "legacy file", evidence: true }).events.map((e) => [e.key, e.evidence])).toEqual([
    ["a", "deleted legacy file"],
  ]);
  expect(store.query({ workspaceId: "ws-a", query: "another" }).events).toEqual([]);
  expect(store.query({ workspaceId: "ws-a", query: '") OR *' }).events).toEqual([]);

  const id = byPath[1]!.id;
  expect(store.get(id, "ws-a")?.evidence).toBe("deleted legacy file");
  expect(store.get(id, "ws-b")).toBeUndefined();
});

test("cursor pagination walks the timeline newest-first exactly once", () => {
  const { store } = setup();
  store.registerSession(session("s1"));
  for (let i = 0; i < 7; i++) store.append(event("s1", `k${i}`, T0 + (i % 3) * 10));
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = store.query({ workspaceId: "ws-a", limit: 3, cursor });
    seen.push(...page.events.map((e) => e.key));
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toEqual(["k5", "k2", "k4", "k1", "k6", "k3", "k0"]);
  expect(() => store.query({ workspaceId: "ws-a", cursor: "garbage" })).toThrow(/invalid_cursor/);
});

test("expiry is fixed by event age: denied immediately at the deadline despite reads, and never renewed", () => {
  const { store, clock } = setup();
  store.registerSession(session("s1"));
  const recorded = store.append(event("s1", "a", T0, { evidence: "proof" }))!;
  // A future occurrence timestamp cannot extend the observed age.
  const future = store.append(event("s1", "b", T0 + 86_400_000 * 5, { observedAt: T0 }))!;
  expect(recorded.expiresAt).toBe(T0 + HISTORY_RETENTION_MS);
  expect(future.expiresAt).toBe(T0 + HISTORY_RETENTION_MS);

  clock.now = T0 + HISTORY_RETENTION_MS - 1;
  expect(store.get(recorded.id, "ws-a")?.evidence).toBe("proof");
  expect(store.query({ workspaceId: "ws-a", query: "proof", evidence: true }).events).toHaveLength(1);

  clock.now = T0 + HISTORY_RETENTION_MS;
  expect(store.get(recorded.id, "ws-a")).toBeUndefined();
  expect(store.query({ workspaceId: "ws-a" }).events).toEqual([]);
  expect(store.status("ws-a").events).toBe(0);
  // Recovering the same old event later does not bring it back.
  expect(store.append(event("s1", "a", T0))).toBeNull();
  const newer = store.append(event("s1", "late", T0 + 10))!;
  expect(newer.expiresAt).toBe(T0 + HISTORY_RETENTION_MS + 10);
  clock.now += 10;
  expect(store.get(newer.id, "ws-a")).toBeUndefined();
  expect(store.append(event("s1", "late", T0 + 10))).toBeNull();
});

test("restart keeps the device id and deduplicates recovered events; entry links attach to the event", () => {
  const { store, open } = setup();
  store.registerSession(session("s1"));
  const first = store.append(event("s1", "a", T0))!;
  expect(store.append(event("s1", "a", T0, { summary: "again" }))).toBeNull();
  expect(store.append(event("unknown", "a", T0))).toBeNull();
  const device = store.deviceId;
  store.close();

  const reopened = open();
  expect(reopened.deviceId).toBe(device);
  expect(reopened.append(event("s1", "a", T0))).toBeNull();
  reopened.linkEntry("s1", "a", "entry-1", "entry-0");
  const linked = reopened.get(first.id, "ws-a")!;
  expect([linked.summary, linked.entryId, linked.parentEntryId]).toEqual(["event a", "entry-1", "entry-0"]);
  expect(reopened.query({ workspaceId: "ws-a" }).events).toHaveLength(1);
  reopened.close();
});

test("inventory replaces per root, reports roots and errors, and stale metadata is purged", () => {
  const fs = setup();
  fs.store.registerSession(session("m1"));
  fs.store.registerSession(session("m2"));
  const disappeared = { kind: "file.disappeared", source: "filesystem" as const, outcome: "observed" as const, path: "/r/gone.txt" };
  expect(fs.store.append(event("m1", "gone", T0, disappeared))?.sessionId).toBe("m1");
  expect(fs.store.append(event("m2", "gone", T0, disappeared))).toBeNull();
  expect(fs.store.append(event("m2", "tool", T0))).not.toBeNull();
  expect(fs.store.append(event("m1", "tool", T0))).not.toBeNull();
  expect(fs.store.query({ workspaceId: "ws-a", path: "/r/gone.txt" }).events.map((e) => e.sessionId)).toEqual(["m1"]);
  fs.store.close();

  const { store, clock } = setup();
  store.replaceInventory(
    "ws-a",
    "/r",
    [
      { path: "/r/a.txt", kind: "file", lastSeenAt: T0 },
      { path: "/r/d", kind: "directory", lastSeenAt: T0 },
    ],
    T0,
  );
  store.replaceInventory("ws-a", "/r", [{ path: "/r/a.txt", kind: "file", lastSeenAt: T0 + 5 }], T0 + 5);
  expect(store.inventory("ws-a", "/r")).toEqual([{ path: "/r/a.txt", kind: "file", lastSeenAt: T0 + 5 }]);
  expect(store.inventory("ws-b", "/r")).toEqual([]);
  store.recordRoot("ws-a", "/r", T0 + 9, "EACCES: permission denied");
  expect(store.status("ws-a").roots).toEqual([{ root: "/r", lastScanAt: T0 + 9, error: "EACCES: permission denied" }]);

  clock.now = T0 + HISTORY_RETENTION_MS + 10;
  store.purge();
  expect(store.inventory("ws-a", "/r")).toEqual([]);
  expect(store.status("ws-a").roots).toEqual([]);
});

test("purge removes expired events, their search entries and outbox, and resolves references only while valid", () => {
  const { store, clock, open } = setup();
  store.registerSession(session("s1"));
  store.registerSession(session("s2", "ws-b"));
  const a = store.append(event("s1", "a", T0, { summary: "removed secretless widget", evidence: "widget evidence" }))!;
  const b = store.append(event("s1", "b", T0 + 86_400_000, { summary: "kept widget" }))!;
  store.append(event("s1", "gap", T0, { kind: "coverage.gap", source: "recovery", unavailable: true, indexable: false }));
  expect(store.unindexedEvents("s1", "dest").map((e) => e.key)).toEqual(["a", "b"]);

  const ref = historyReference(store.deviceId, "s1", "seg1");
  store.enqueue({
    id: "seg1",
    sessionId: "s1",
    destination: "dest",
    eventIds: [a.id, b.id],
    expiresAt: a.expiresAt,
    status: "pending",
    payload: { space: "repo", kind: "episode", text: "x", source: ref, request_key: "rk", expires_at: new Date(a.expiresAt).toISOString() },
  });
  expect(store.unindexedEvents("s1", "dest")).toEqual([]);
  expect(store.unindexedEvents("s1", "other-dest")).toHaveLength(2);
  expect(store.status("ws-a").gaps.map((e) => e.kind)).toEqual(["coverage.gap"]);
  expect(store.status("ws-a").pendingUploads).toBe(1);

  expect(store.resolveReference(ref, "ws-a")?.map((e) => [e.key, e.evidence])).toEqual([
    ["a", "widget evidence"],
    ["b", undefined],
  ]);
  expect(store.resolveReference(ref, "ws-b")).toBeUndefined();
  expect(store.resolveReference(historyReference("other-device", "s1", "seg1"), "ws-a")).toBeUndefined();
  expect(store.resolveReference(historyReference(store.deviceId, "s2", "seg1"), "ws-a")).toBeUndefined();
  expect(store.resolveReference("file:///work/ws-a/src/legacy.ts", "ws-a")).toBeUndefined();

  clock.now = a.expiresAt;
  // Expired before physical purge: already denied.
  expect(store.resolveReference(ref, "ws-a")).toBeUndefined();
  store.purge();
  expect(store.query({ workspaceId: "ws-a", query: "widget" }).events.map((e) => e.key)).toEqual(["b"]);
  expect(store.status("ws-a").pendingUploads).toBe(0);
  store.close();

  // Purged data stays gone after restart, and the surviving event is not re-dated.
  const reopened = open();
  expect(reopened.get(a.id, "ws-a")).toBeUndefined();
  expect(reopened.get(b.id, "ws-a")?.expiresAt).toBe(b.expiresAt);
  // The surviving event lost its expired segment and is indexable again on its own.
  expect(reopened.unindexedEvents("s1", "dest").map((e) => e.key)).toEqual(["b"]);
  reopened.close();
});

test("overlapping concurrent segment snapshots cannot upload duplicate evidence", () => {
  const { store } = setup();
  store.registerSession(session("s1"));
  const a = store.append(event("s1", "a", T0))!;
  const b = store.append(event("s1", "b", T0 + 1))!;
  const payload = { space: "repo", kind: "episode", text: "observed activity", request_key: "first" };
  store.enqueue({
    id: "first",
    sessionId: "s1",
    destination: "dest",
    eventIds: [a.id],
    expiresAt: a.expiresAt,
    status: "pending",
    payload,
  });
  store.enqueue({
    id: "overlap",
    sessionId: "s1",
    destination: "dest",
    eventIds: [a.id, b.id],
    expiresAt: a.expiresAt,
    status: "pending",
    payload: { ...payload, request_key: "overlap" },
  });
  const accepted = store.claimUpload("dest")!;
  expect(accepted.eventIds).toEqual([a.id]);
  store.finishUpload(accepted.id, "accepted", "memory-first");
  expect(store.claimUpload("dest")).toBeUndefined();
  expect(store.unindexedEvents("s1", "dest").map((item) => item.id)).toEqual([b.id]);
});

test("claimUpload leases one item at a time across store instances", () => {
  const { store, clock, open } = setup();
  store.registerSession(session("s1"));
  const a = store.append(event("s1", "a", T0))!;
  store.enqueue({
    id: "seg",
    sessionId: "s1",
    destination: "dest",
    eventIds: [a.id],
    expiresAt: a.expiresAt,
    status: "pending",
    payload: { space: "repo", kind: "episode", text: "x", source: "s", request_key: "rk" },
  });
  const other = open();
  expect(store.claimUpload("dest")?.eventIds).toEqual([a.id]);
  expect(other.claimUpload("dest")).toBeUndefined();
  expect(other.claimUpload("elsewhere")).toBeUndefined();
  clock.now += 31_000;
  expect(other.claimUpload("dest")?.id).toBe("seg");
  other.failUpload("seg", "network_error: down", clock.now + 60_000);
  expect(store.claimUpload("dest")).toBeUndefined();
  expect(store.status("ws-a").uploadError).toBe("network_error: down");
  clock.now += 60_000;
  expect(store.claimUpload("dest")?.id).toBe("seg");
  store.finishUpload("seg", "proposed", "mem-1");
  expect(other.claimUpload("dest")).toBeUndefined();
  expect(store.status("ws-a").proposedUploads).toBe(1);
  other.close();
  store.close();
});
