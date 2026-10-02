import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HistoryObserver } from "../src/history-observer.ts";
import type { FileObservation, HistoryEventInput, HistorySession, HistoryStorage, ObservedRoot } from "../src/history-types.ts";

type ObserverTestStore = HistoryStorage & {
  events: HistoryEventInput[];
  inventories: Map<string, FileObservation[]>;
  roots: Map<string, ObservedRoot>;
};

/** In-memory storage with the same key-dedupe contract the SQLite store provides. */
function memoryStore(): ObserverTestStore {
  const events: HistoryEventInput[] = [];
  const inventories = new Map<string, FileObservation[]>();
  const roots = new Map<string, ObservedRoot>();
  const unused = (): never => {
    throw new Error("not used by observer");
  };
  return {
    deviceId: "test-device",
    events,
    inventories,
    roots,
    append(input) {
      if (events.some((event) => event.key === input.key)) return null;
      events.push(input);
      return {
        ...input,
        id: input.key,
        seq: events.length,
        workspaceId: "ws",
        observedAt: input.observedAt ?? input.occurredAt,
        expiresAt: 0,
      };
    },
    inventory: (_ws, root) => [...(inventories.get(root) ?? [])],
    rememberFile: (_ws, root, entry) =>
      void inventories.set(root, [...(inventories.get(root) ?? []).filter((previous) => previous.path !== entry.path), entry]),
    replaceInventory: (_ws, root, entries) => void inventories.set(root, [...entries]),
    recordRoot: (_ws, root, at, error) => void roots.set(root, { root, lastScanAt: at, error }),
    status: () => ({
      events: events.length,
      sessions: 1,
      pendingUploads: 0,
      proposedUploads: 0,
      acceptedUploads: 0,
      roots: [...roots.values()],
      gaps: [],
    }),
    registerSession: unused,
    session: unused,
    linkEntry: unused,
    bindDestination: unused,
    query: unused,
    get: unused,
    unindexedEvents: unused,
    enqueue: unused,
    claimUpload: unused,
    finishUpload: unused,
    failUpload: unused,
    resolveReference: unused,
    purge: unused,
    close: unused,
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omp-observer-"));
  const root = join(dir, "root");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "secret contents");
  writeFileSync(join(root, ".env"), "x");
  let now = 1_000;
  const session: HistorySession = {
    id: "s1",
    workspaceId: "ws",
    cwd: dir,
    agentId: "main",
    agentKind: "main",
    startedAt: 0,
    cloudSpace: "space",
  };
  const store = memoryStore();
  const errors: unknown[] = [];
  const make = (sessionId = "s1") =>
    new HistoryObserver(store, { ...session, id: sessionId }, [root], {
      clock: () => now,
      onError: (error) => errors.push(error),
      scanIntervalMs: 0,
      debounceMs: 10,
    });
  return {
    dir,
    root,
    store,
    errors,
    make,
    tick: (ms = 1_000) => (now += ms),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const kinds = (store: ObserverTestStore, kind: string) => store.events.filter((event) => event.kind === kind);

test("a native write observed before the debounce remains evidence for immediate shell removal", async () => {
  const f = fixture();
  const observer = f.make();
  try {
    await observer.start();
    const file = join(f.root, "transient.txt");
    writeFileSync(file, "contents are never copied");
    await observer.rememberPresentFile(file);
    unlinkSync(file);
    f.tick();
    await observer.scan();
    const disappearance = kinds(f.store, "file.disappeared").find((event) => event.path?.endsWith("/transient.txt"));
    assert.equal(disappearance?.outcome, "observed");
    assert.equal(disappearance?.toolCallId, undefined);
    assert.ok(!disappearance?.evidence?.includes("contents are never copied"));
  } finally {
    await observer.stop();
    f.cleanup();
  }
});

test("baseline records metadata only, includes dotfiles, and emits no events", async () => {
  const f = fixture();
  try {
    const observer = f.make();
    await observer.start();
    await observer.stop();
    const [inventory] = [...f.store.inventories.values()];
    const names = inventory!.map((entry) => entry.path.split("/").slice(-2).join("/")).sort();
    assert.deepEqual(names, ["root/.env", "root/src", "src/a.ts"]);
    assert.equal(JSON.stringify(inventory).includes("secret contents"), false);
    assert.equal(f.store.events.length, 0);
  } finally {
    f.cleanup();
  }
});

test("unlink then recreation are observations with unknown actor, deduped across observers", async () => {
  const f = fixture();
  try {
    const first = f.make("s1");
    await first.start();
    const seenAt = f.store.inventory("ws", first.observedRoots[0]!).find((entry) => entry.path.endsWith("a.ts"))!.lastSeenAt;
    f.tick();
    unlinkSync(join(f.root, "src", "a.ts"));
    const second = f.make("s1");
    await second.start();
    await first.scan();
    const gone = kinds(f.store, "file.disappeared");
    assert.equal(gone.length, 1);
    assert.equal(gone[0]!.source, "filesystem");
    assert.equal(gone[0]!.outcome, "observed");
    assert.equal(gone[0]!.toolCallId, undefined);
    assert.match(gone[0]!.evidence!, new RegExp(`present at ${new Date(seenAt).toISOString()}`));
    assert.match(gone[0]!.evidence!, /actor and exact time unknown/);
    assert.doesNotMatch(gone[0]!.summary, /agent|deleted by/i);

    f.tick();
    writeFileSync(join(f.root, "src", "a.ts"), "again");
    await first.scan();
    const back = kinds(f.store, "file.appeared");
    assert.equal(back.length, 1);
    assert.match(back[0]!.path!, /src\/a\.ts$/);
    await first.stop();
    await second.stop();
  } finally {
    f.cleanup();
  }
});

test("rename is reported as possible move, not a proven delete", async () => {
  const f = fixture();
  try {
    const observer = f.make();
    await observer.start();
    f.tick();
    mkdirSync(join(f.root, "lib"));
    renameSync(join(f.root, "src", "a.ts"), join(f.root, "lib", "a.ts"));
    await observer.scan();
    await observer.stop();
    const [gone] = kinds(f.store, "file.disappeared");
    assert.match(gone!.evidence!, /may be a move or rename/);
    assert.match(gone!.evidence!, /lib\/a\.ts/);
    assert.ok(kinds(f.store, "file.appeared").some((event) => event.path!.endsWith("lib/a.ts")));
  } finally {
    f.cleanup();
  }
});

test("restarted observer reconciles absence using previous timestamps", async () => {
  const f = fixture();
  try {
    const before = f.make();
    await before.start();
    await before.stop();
    f.tick(60_000);
    rmSync(join(f.root, "src"), { recursive: true });
    const after = f.make();
    await after.start();
    await after.stop();
    const gone = kinds(f.store, "file.disappeared");
    assert.equal(gone.length, 2);
    for (const event of gone) {
      assert.match(event.evidence!, /present at 1970-01-01T00:00:01\.000Z and missing when observed at 1970-01-01T00:01:01\.000Z/);
    }
  } finally {
    f.cleanup();
  }
});

test("removed root records known paths as disappeared and recreation as appeared", async () => {
  const f = fixture();
  try {
    const observer = f.make();
    await observer.start();
    const root = observer.observedRoots[0]!;
    rmSync(f.root, { recursive: true });
    f.tick();
    await observer.scan();
    assert.equal(kinds(f.store, "file.disappeared").length, 3);
    assert.match(f.store.roots.get(root)!.error!, /root directory missing/);
    await observer.stop();

    const restarted = f.make();
    await restarted.start();
    assert.deepEqual(restarted.observedRoots, [root]);
    mkdirSync(join(f.root, "src"), { recursive: true });
    writeFileSync(join(f.root, "src", "a.ts"), "new");
    f.tick();
    await restarted.scan();
    await restarted.stop();
    assert.equal(kinds(f.store, "file.appeared").length, 2);
    // The recreated root is scanned again; only the watch coverage gap from the missing-root start remains.
    assert.doesNotMatch(f.store.roots.get(root)!.error ?? "", /root directory missing/);
  } finally {
    f.cleanup();
  }
});

test(
  "unreadable root preserves inventory and records a coverage gap",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const f = fixture();
    try {
      const observer = f.make();
      await observer.start();
      const root = observer.observedRoots[0]!;
      const count = f.store.inventory("ws", root).length;
      chmodSync(f.root, 0o000);
      f.tick();
      await observer.scan();
      chmodSync(f.root, 0o755);
      await observer.stop();
      assert.equal(f.store.inventory("ws", root).length, count);
      assert.equal(kinds(f.store, "file.disappeared").length, 0);
      assert.match(f.store.roots.get(root)!.error!, /inventory preserved/);
    } finally {
      f.cleanup();
    }
  },
);

test("unreadable subtree is a gap, not deletes", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const f = fixture();
  try {
    const observer = f.make();
    await observer.start();
    chmodSync(join(f.root, "src"), 0o000);
    f.tick();
    await observer.scan();
    await observer.stop();
    chmodSync(join(f.root, "src"), 0o755);
    assert.equal(kinds(f.store, "file.disappeared").length, 0);
    assert.ok(f.store.inventory("ws", observer.observedRoots[0]!).some((entry) => entry.path.endsWith("src/a.ts")));
    assert.match(f.store.roots.get(observer.observedRoots[0]!)!.error!, /partial scan/);
  } finally {
    f.cleanup();
  }
});

test("directory symlinks are recorded but not followed; symlink and URL roots are rejected", async () => {
  const f = fixture();
  try {
    const outside = join(f.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "escaped.txt"), "x");
    symlinkSync(outside, join(f.root, "link"), "junction");
    const observer = f.make();
    await observer.start();
    await observer.stop();
    const inventory = f.store.inventory("ws", observer.observedRoots[0]!);
    assert.equal(inventory.find((entry) => entry.path.endsWith("/link"))?.kind, "symlink");
    assert.equal(
      inventory.some((entry) => entry.path.includes("escaped")),
      false,
    );

    const rejected = new HistoryObserver(
      f.store,
      { id: "s", workspaceId: "ws", cwd: f.dir, agentId: "a", agentKind: "main", startedAt: 0, cloudSpace: "x" },
      [join(f.root, "link"), "file:///etc", join(f.root, ".env")],
      {
        onError: () => {},
        scanIntervalMs: 0,
      },
    );
    await rejected.start();
    await rejected.stop();
    assert.deepEqual(rejected.observedRoots, []);
  } finally {
    f.cleanup();
  }
});

test("explicit exclusions are reported and their subtree is never inventoried", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, ".omp-history"));
    writeFileSync(join(f.root, ".omp-history", "history.db"), "x");
    const observer = new HistoryObserver(
      f.store,
      { id: "s", workspaceId: "ws", cwd: f.dir, agentId: "a", agentKind: "main", startedAt: 0, cloudSpace: "x" },
      [f.root],
      {
        exclude: [join(f.root, ".omp-history")],
        scanIntervalMs: 0,
      },
    );
    await observer.start();
    await observer.stop();
    assert.equal(observer.exclusions.length, 1);
    assert.equal(
      f.store.inventory("ws", observer.observedRoots[0]!).some((entry) => entry.path.includes(".omp-history")),
      false,
    );
    assert.ok(f.store.inventory("ws", observer.observedRoots[0]!).some((entry) => entry.path.endsWith("/.env")));
  } finally {
    f.cleanup();
  }
});

test("stop closes watchers and timers and drains queued scans; restart does not duplicate", async () => {
  const f = fixture();
  try {
    const observer = new HistoryObserver(
      f.store,
      { id: "s", workspaceId: "ws", cwd: f.dir, agentId: "a", agentKind: "main", startedAt: 0, cloudSpace: "x" },
      [f.root],
      {
        debounceMs: 5,
        scanIntervalMs: 5,
      },
    );
    await observer.start();
    await observer.start();
    unlinkSync(join(f.root, "src", "a.ts"));
    const queued = observer.scan();
    await observer.stop();
    await queued;
    assert.equal(kinds(f.store, "file.disappeared").length, 1);
    const events = f.store.events.length;
    writeFileSync(join(f.root, "late.txt"), "x");
    await observer.scan();
    assert.equal(f.store.events.length, events);
  } finally {
    f.cleanup();
  }
});
