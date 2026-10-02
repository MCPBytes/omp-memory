import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { z } from "zod";
import { resolveSettings } from "../src/core.ts";
import { ActivityHistory, evidenceSlice } from "../src/history-runtime.ts";
import { HistoryStore } from "../src/history-store.ts";
import { HISTORY_RETENTION_MS } from "../src/history-types.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mcpbytes-runtime-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const manager = SessionManager.inMemory(cwd);
  const settings = { ...resolveSettings({}, {}), history: true, historyPath: join(root, "history.sqlite") };
  let now = Date.now();
  const warnings: string[] = [];
  const pi = { logger: { warn: (_message: string, data: { error: string }) => warnings.push(data.error) } } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    sessionManager: manager,
    agent: { id: "Main", kind: "main", depth: 0, name: "main" },
    hasUI: false,
    getAsyncJobSnapshot: () => null,
  } as unknown as ExtensionContext;
  const create = () =>
    new ActivityHistory(
      pi,
      async () => ({ settings, space: "test-history" }),
      () => now,
    );
  return {
    root,
    cwd,
    manager,
    settings,
    ctx,
    create,
    warnings,
    advance: (by: number) => {
      now += by;
    },
    now: () => now,
  };
}

const responseSchema = z.object({
  event_id: z.string().optional(),
  events: z
    .array(
      z.object({
        event_id: z.string(),
        kind: z.string(),
        outcome: z.string().optional(),
        entry_id: z.string().optional(),
        redacted: z.boolean().optional(),
      }),
    )
    .default([]),
});

function payload(text: string) {
  return responseSchema.parse(JSON.parse(text.slice(text.indexOf("\n") + 1)));
}

function assistant(timestamp: number, name: string, id: string, args: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp,
  };
}

test("native deletion stays one event through live completion, session recovery and restart, then expires after reads", async () => {
  const f = await fixture();
  let history = f.create();
  try {
    await history.start(f.ctx);
    const path = join(f.cwd, "legacy.ts");
    const args = { path, edits: [{ op: "delete" }] };
    f.manager.appendMessage(assistant(f.now(), "edit", "delete-1", args));
    await history.toolStart(f.ctx, { toolCallId: "delete-1", toolName: "edit", args });
    const result = { content: [{ type: "text" as const, text: "Deleted legacy.ts" }], details: { path, op: "delete" } };
    await history.toolEnd(f.ctx, { toolCallId: "delete-1", toolName: "edit", result, isError: false });
    f.manager.appendMessage({
      role: "toolResult",
      toolCallId: "delete-1",
      toolName: "edit",
      ...result,
      isError: false,
      timestamp: f.now(),
    });
    await history.settle(f.ctx);
    const first = payload(await history.inspect(f.ctx, { mode: "timeline", path: "legacy.ts" }));
    const deleted = first.events.filter((event) => event.kind === "file.deleted");
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].outcome, "completed");
    assert.ok(deleted[0].entry_id, "the recovered persisted entry links the original live event");
    await history.stop(f.ctx);
    history = f.create();
    await history.start(f.ctx);
    const resumed = payload(await history.inspect(f.ctx, { mode: "timeline", path: "legacy.ts" }));
    assert.deepEqual(
      resumed.events.filter((event) => event.kind === "file.deleted").map((event) => event.event_id),
      [deleted[0].event_id],
    );
    f.advance(HISTORY_RETENTION_MS - 1);
    assert.equal(payload(await history.inspect(f.ctx, { mode: "evidence", event_id: deleted[0].event_id })).event_id, deleted[0].event_id);
    f.advance(1);
    await assert.rejects(history.inspect(f.ctx, { mode: "evidence", event_id: deleted[0].event_id }), /unavailable|expired/);
    await history.settle(f.ctx);
    assert.equal(payload(await history.inspect(f.ctx, { mode: "timeline", path: "legacy.ts" })).events.length, 0);
    await history.message(f.ctx, { role: "user", content: "Work resumed after an idle month", timestamp: f.now() });
    const fresh = payload(await history.inspect(f.ctx, { mode: "search", query: "resumed idle month" }));
    assert.equal(fresh.events.filter((event) => event.kind === "message.user").length, 1);
    await assert.rejects(history.inspect(f.ctx, { mode: "evidence", event_id: deleted[0].event_id }), /unavailable|expired/);
    assert.deepEqual(f.warnings, []);
  } finally {
    await history.stop(f.ctx);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("recovery uses original read arguments to suppress a sensitive file's unformatted secret", async () => {
  const f = await fixture();
  const history = f.create();
  try {
    f.manager.appendMessage(assistant(f.now(), "read", "read-env", { path: join(f.cwd, ".env") }));
    f.manager.appendMessage({
      role: "toolResult",
      toolCallId: "read-env",
      toolName: "read",
      content: [{ type: "text", text: "an-unformatted-secret-that-has-no-provider-prefix" }],
      isError: false,
      timestamp: f.now(),
    });
    await history.start(f.ctx);
    const found = payload(await history.inspect(f.ctx, { mode: "timeline" }));
    for (const event of found.events) {
      const evidence = await history.inspect(f.ctx, { mode: "evidence", event_id: event.event_id });
      assert.ok(!evidence.includes("an-unformatted-secret"));
    }
    assert.equal(found.events.find((event) => event.kind === "tool.completed")?.redacted, true);
  } finally {
    await history.stop(f.ctx);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("reconfiguring to off does not flush old cloud consent and leaves retained local evidence intact", async () => {
  const f = await fixture();
  let writes = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      writes++;
      return Response.json({ status: "accepted", memory_id: "m_fixture" });
    },
  });
  f.settings.apiKey = "local-smoke-key";
  f.settings.apiUrl = `http://127.0.0.1:${server.port}`;
  f.settings.historyCloudIndex = true;
  const history = f.create();
  try {
    await history.start(f.ctx);
    await history.message(f.ctx, { role: "user", content: "Keep this local when disabling indexing", timestamp: f.now() });
    f.settings.history = false;
    f.settings.historyCloudIndex = false;
    await history.restart(f.ctx);
    await assert.rejects(history.inspect(f.ctx, { mode: "status" }), /off/);
    assert.equal(writes, 0);
    const retained = new HistoryStore(f.settings.historyPath, f.now);
    try {
      const session = retained.session(f.manager.getSessionId())!;
      assert.equal(retained.query({ workspaceId: session.workspaceId, query: "disabling indexing" }).events.length, 1);
    } finally {
      retained.close();
    }
  } finally {
    await history.stop(f.ctx);
    await server.stop(true);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an explicitly disabled history leaves no archive and local capture needs no cloud key", async () => {
  const f = await fixture();
  f.settings.history = false;
  const history = f.create();
  try {
    await history.start(f.ctx);
    await history.message(f.ctx, { role: "user", content: "do not archive this", timestamp: f.now() });
    await assert.rejects(history.inspect(f.ctx, { mode: "status" }), /off/);
    assert.equal(await Bun.file(f.settings.historyPath).exists(), false);
    assert.deepEqual(f.warnings, []);
  } finally {
    await history.stop(f.ctx);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("evidence pagination preserves multibyte text without revisiting or dropping characters", () => {
  const original = "aé😀終".repeat(7);
  let offset = 0;
  let complete = "";
  do {
    const page = evidenceSlice(original, offset, 7);
    complete += page.text;
    if (page.nextOffset === undefined) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  } while (true);
  assert.equal(complete, original);
  assert.throws(() => evidenceSlice(original, -1), /offset/);
});
