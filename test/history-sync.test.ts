import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RememberRequest, memoryApi } from "../src/api.ts";
import { HistoryStore } from "../src/history-store.ts";
import { HistoryIndexer } from "../src/history-sync.ts";
import { HISTORY_RETENTION_MS, HISTORY_TOOL, type HistoryEventInput } from "../src/history-types.ts";

const T0 = Date.UTC(2026, 8, 1);

/** A stand-in for the memory service: per-key accounts, idempotent request keys, and scripted failures. */
interface Account {
  memories: Map<string, { id: string; body: RememberRequest }>;
  writes: number;
  policy: "open" | "review";
  script: ("drop" | "quota" | "invalid" | "outage")[];
}
const accounts = new Map<string, Account>();
let port = 0;
let stop: () => void = () => {};

beforeAll(() => {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const account = accounts.get(request.headers.get("authorization")?.replace("Bearer ", "") ?? "");
      if (!account) return Response.json({ error: "invalid_token", error_description: "Invalid access token" }, { status: 401 });
      const body = (await request.json()) as RememberRequest;
      const step = account.script.shift();
      if (step === "quota")
        return Response.json(
          { error: { code: "write_limit", message: "daily writes used" } },
          { status: 429, headers: { "Retry-After": "120" } },
        );
      if (step === "invalid") return Response.json({ error: { code: "invalid_request", message: "expires_at too soon" } }, { status: 400 });
      if (step === "outage") return Response.json({ error: { code: "unavailable", message: "try later" } }, { status: 503 });
      const existing = account.memories.get(body.request_key);
      const memory = existing ?? { id: `mem-${account.memories.size + 1}`, body };
      if (!existing) {
        account.memories.set(body.request_key, memory);
        account.writes++;
      }
      // The write lands, but the answer never arrives.
      if (step === "drop") return new Response("", { status: 502 });
      return Response.json(
        account.policy === "review" ? { status: "proposed" } : { status: "accepted", memory_id: memory.id, replayed: Boolean(existing) },
      );
    },
  });
  port = server.port ?? 0;
  stop = () => void server.stop(true);
});
afterAll(() => stop());

const dirs: string[] = [];
const stores: HistoryStore[] = [];
afterEach(() => {
  accounts.clear();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(key = "key-a", policy: Account["policy"] = "open") {
  const account: Account = { memories: new Map(), writes: 0, policy, script: [] };
  accounts.set(key, account);
  const dir = mkdtempSync(join(tmpdir(), "omp-history-sync-"));
  dirs.push(dir);
  const clock = { now: T0 };
  const path = join(dir, "history.db");
  const open = () => {
    const store = new HistoryStore(path, () => clock.now);
    stores.push(store);
    return store;
  };
  const store = open();
  store.registerSession({ id: "s1", workspaceId: "ws", cwd: "/w", agentId: "a", agentKind: "main", startedAt: T0, cloudSpace: "repo" });
  const indexer = (s: HistoryStore, apiKey = key) =>
    new HistoryIndexer(
      s,
      memoryApi({ apiKey, apiUrl: `http://127.0.0.1:${port}` }),
      { destination: `dest-${apiKey}`, space: "repo" },
      () => clock.now,
    );
  return { account, clock, open, store, indexer };
}

const ev = (key: string, at: number, extra: Partial<HistoryEventInput> = {}): HistoryEventInput => ({
  key,
  sessionId: "s1",
  kind: "tool.result",
  occurredAt: at,
  summary: `did ${key}`,
  source: "tool",
  outcome: "completed",
  ...extra,
});

test("seal selects meaningful activity into compact chronological episodes with the oldest event's expiry", () => {
  const { store, indexer } = setup();
  store.append(ev("goal", T0, { kind: "message.user", source: "message", outcome: undefined, summary: "Remove the legacy module" }));
  store.append(ev("start", T0 + 1, { outcome: "started", toolName: "edit" }));
  store.append(ev("del", T0 + 2, { kind: "file.deleted", toolName: "edit", path: "/w/src/legacy.ts", summary: "deleted src/legacy.ts" }));
  store.append(ev("recall", T0 + 3, { toolName: HISTORY_TOOL, summary: "looked at history" }));
  store.append(ev("private", T0 + 4, { indexable: false }));
  for (let i = 0; i < 40; i++) store.append(ev(`bulk${i}`, T0 + 10 + i, { summary: "x".repeat(400) }));

  indexer(store).seal("s1");
  const items: RememberRequest[] = [];
  for (let item = store.claimUpload("dest-key-a"); item; item = store.claimUpload("dest-key-a")) {
    items.push(item.payload);
    store.finishUpload(item.id, "accepted");
  }
  expect(items.length).toBeGreaterThan(1);
  for (const item of items) {
    expect(Buffer.byteLength(item.text)).toBeLessThan(8192);
    expect(item.kind).toBe("episode");
    expect(item.source).toStartWith(`mcpbytes-history://${store.deviceId}/s1/`);
  }
  const first = items.find((item) => item.text.includes("Remove the legacy module"))!;
  expect(first.expires_at).toBe(new Date(T0 + HISTORY_RETENTION_MS).toISOString());
  expect(first.text).toContain("Remove the legacy module");
  expect(store.resolveReference(first.source!, "ws")?.map((event) => event.key)).toContain("del");
  const all = items.map((i) => i.text).join("\n");
  expect(all).not.toContain("looked at history");
  expect(all).not.toContain("[started]");
  const ordered = store.resolveReference(first.source!, "ws")!;
  expect(ordered.findIndex((event) => event.key === "goal")).toBeLessThan(ordered.findIndex((event) => event.key === "del"));

  // Every local event stays queryable; references expand to the selected evidence.
  expect(store.query({ workspaceId: "ws", limit: 200 }).events).toHaveLength(45);
  expect(store.resolveReference(first.source!, "ws")?.[0]?.summary).toBe("Remove the legacy module");
  // Sealing again (or after restart) does not create new segments for already-sealed events.
  indexer(store).seal("s1");
  expect(store.claimUpload("dest-key-a")).toBeUndefined();
});

test("a lost response is retried with the identical payload and creates one memory, even across a restart", async () => {
  const { account, store, open, indexer, clock } = setup();
  store.append(ev("a", T0));
  indexer(store).seal("s1");
  account.script.push("drop");
  const first = indexer(store);
  await first.flush();
  expect(first.lastError).toMatch(/http_502/);
  expect(store.status("ws").uploadError).toMatch(/http_502/);
  expect(account.writes).toBe(1);
  // Not retried before its backoff.
  await indexer(store).flush();
  expect(account.memories.size).toBe(1);
  store.close();

  clock.now += 10 * 60_000;
  const reopened = open();
  indexer(reopened).seal("s1");
  await indexer(reopened).flush();
  expect(account.writes).toBe(1);
  const status = reopened.status("ws");
  expect([status.acceptedUploads, status.pendingUploads, status.uploadError]).toEqual([1, 0, undefined]);
  const stored = [...account.memories.values()][0]!.body;
  // The original age-based expiry survives delay and restart.
  expect(stored.expires_at).toBe(new Date(T0 + HISTORY_RETENTION_MS).toISOString());
  reopened.close();
});

test("quota refusals block with Retry-After, invalid payloads stay local, review spaces report proposed", async () => {
  const { account, store, indexer, clock } = setup("key-r", "review");
  store.append(ev("a", T0));
  store.append(ev("b", T0 + 1, { kind: "message.user", source: "message" }));
  const idx = indexer(store, "key-r");
  idx.seal("s1");
  account.script.push("quota");
  await idx.flush();
  expect(idx.lastError).toMatch(/write_limit/);
  expect(store.status("ws").uploadError).toMatch(/^blocked: write_limit/);
  clock.now += 119_000;
  await idx.flush();
  expect(account.writes).toBe(0);
  clock.now += 2_000;
  await idx.flush();
  expect(store.status("ws").proposedUploads).toBe(1);
  expect(account.writes).toBe(1);

  store.append(ev("c", T0 + 2));
  idx.seal("s1");
  account.script.push("invalid");
  await idx.flush();
  clock.now += 7 * 86_400_000;
  await idx.flush();
  expect(store.status("ws").uploadError).toMatch(/^refused: invalid_request/);
  expect(account.writes).toBe(1);
  // Local evidence remains usable regardless.
  expect(store.query({ workspaceId: "ws", query: "did c" }).events).toHaveLength(1);
});

test("an outage stops the flush; segments within a minute of expiry are never sent", async () => {
  const { account, store, indexer, clock } = setup();
  store.append(ev("a", T0));
  const idx = indexer(store);
  idx.seal("s1");
  account.script.push("outage");
  await idx.flush();
  expect(idx.lastError).toMatch(/unavailable/);
  expect(account.writes).toBe(0);

  clock.now = T0 + HISTORY_RETENTION_MS - 30_000;
  await idx.flush();
  expect(account.writes).toBe(0);
  clock.now = T0 + HISTORY_RETENTION_MS;
  store.purge();
  expect(store.status("ws").pendingUploads).toBe(0);
});

test("a resumed session never uploads to a new destination; a new session does", async () => {
  const { store, indexer } = setup();
  const other: Account = { memories: new Map(), writes: 0, policy: "open", script: [] };
  accounts.set("key-b", other);
  store.append(ev("a", T0));
  indexer(store, "key-a").seal("s1");
  await indexer(store, "key-a").flush();
  expect(accounts.get("key-a")!.writes).toBe(1);

  // Key rotated; the old session keeps capturing locally but is never indexed for the new account.
  store.append(ev("b", T0 + 1, { summary: "after rotation" }));
  const rotated = indexer(store, "key-b");
  rotated.seal("s1");
  await rotated.flush();
  expect(other.writes).toBe(0);
  expect(rotated.lastError).toMatch(/^destination_changed: .*new session/);
  expect(store.query({ workspaceId: "ws", query: "rotation" }).events).toHaveLength(1);

  store.registerSession({ id: "s2", workspaceId: "ws", cwd: "/w", agentId: "a", agentKind: "main", startedAt: T0 + 2, cloudSpace: "repo" });
  store.append(ev("c", T0 + 2, { sessionId: "s2", summary: "fresh work" }));
  rotated.seal("s2");
  await rotated.flush();
  expect(other.writes).toBe(1);
  const sent = [...other.memories.values()][0]!.body;
  expect(sent.text).toContain("fresh work");
  expect(sent.text).not.toContain("did a");
  expect(sent.text).not.toContain("after rotation");
  expect(accounts.get("key-a")!.writes).toBe(1);
});
