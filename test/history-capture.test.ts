import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeJobs, normalizeMessage, normalizeToolEnd, normalizeToolStart, readHistoryArtifacts } from "../src/history-capture.ts";
import { type HistoryEventInput, type HistorySession, historyPath } from "../src/history-types.ts";

const cwd = join(tmpdir(), "history-capture-ws");
const session: HistorySession = {
  id: "s1",
  workspaceId: "w1",
  cwd,
  agentId: "main",
  agentKind: "main",
  startedAt: 1,
  cloudSpace: "default",
};
const p = (name: string) => historyPath(join(cwd, name));
const ofKind = (events: HistoryEventInput[], kind: string) => events.filter((event) => event.kind === kind);
const keys = (events: HistoryEventInput[]) => events.map((event) => event.key);

test("virtual writes are tool activity, not claims of local file creation", () => {
  for (const path of ["xd://memory_remember", "cfg://memory/backend", "store.sqlite:items:1"]) {
    const events = normalizeToolEnd(
      session,
      {
        toolName: "write",
        toolCallId: path,
        args: { path, content: "" },
        result: { content: [{ type: "text", text: "Accepted" }] },
        isError: false,
      },
      100,
    );
    assert.equal(
      events.some((event) => event.kind.startsWith("file.")),
      false,
    );
    assert.equal(events[0]?.outcome, "completed");
  }
});

test("successful native delete is a completed file.deleted event with no snapshot", () => {
  const result = {
    content: [{ type: "text", text: "Deleted legacy.ts" }],
    details: { diff: "", op: "delete", path: join(cwd, "src/legacy.ts"), oldText: "SECRET OLD BODY" },
  };
  const events = normalizeToolEnd(session, { toolCallId: "c1", toolName: "edit", result, isError: false }, 100);
  const [deleted] = ofKind(events, "file.deleted");
  assert.ok(deleted);
  assert.equal(deleted.outcome, "completed");
  assert.equal(deleted.path, p("src/legacy.ts"));
  assert.equal(deleted.occurredAt, 100);
  assert.ok(events.every((event) => !`${event.evidence}${event.summary}`.includes("SECRET OLD BODY")));
  assert.equal(ofKind(events, "tool.completed").length, 1);
});

test("a failed edit call claims no file effect", () => {
  const events = normalizeToolEnd(
    session,
    {
      toolCallId: "c2",
      toolName: "edit",
      args: { path: "a.ts" },
      result: { content: [{ type: "text", text: "Permission denied" }], isError: true },
      isError: true,
    },
    100,
  );
  assert.deepEqual(
    events.map((event) => [event.kind, event.outcome]),
    [["tool.failed", "failed"]],
  );
  const single = normalizeToolEnd(
    session,
    {
      toolCallId: "c2b",
      toolName: "edit",
      result: { content: [{ type: "text", text: "EACCES" }], details: { diff: "", op: "delete", path: join(cwd, "a.ts") } },
      isError: true,
    },
    100,
  );
  assert.equal(ofKind(single, "file.deleted").length, 0);
  assert.equal(ofKind(single, "file.delete_failed")[0]!.outcome, "failed");
});

test("mixed per-file results keep distinct outcomes, and a move is a rename not a deletion", () => {
  const result = {
    content: [{ type: "text", text: "partial" }],
    details: {
      diff: "",
      perFileResults: [
        { path: join(cwd, "gone.ts"), diff: "", op: "delete" },
        { path: join(cwd, "locked.ts"), diff: "", op: "delete", isError: true, errorText: "EPERM: operation not permitted" },
        { path: join(cwd, "new/name.ts"), diff: "", op: "update", move: join(cwd, "new/name.ts"), sourcePath: join(cwd, "old/name.ts") },
        { path: join(cwd, "gone.ts"), diff: "", op: "create", newText: "recreated body" },
      ],
    },
  };
  const events = normalizeToolEnd(session, { toolCallId: "c3", toolName: "edit", result, isError: false }, 100);
  assert.ok(
    events.every((event) => event.source === "tool"),
    "native results are tool evidence, not filesystem observations",
  );
  const deleted = ofKind(events, "file.deleted");
  assert.deepEqual(
    deleted.map((event) => event.path),
    [p("gone.ts")],
  );
  const failed = ofKind(events, "file.delete_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.outcome, "failed");
  assert.equal(failed[0]!.path, p("locked.ts"));
  assert.match(failed[0]!.evidence ?? "", /EPERM/);
  const [moved] = ofKind(events, "file.moved");
  assert.equal(moved!.path, p("new/name.ts"));
  assert.equal(moved!.fromPath, p("old/name.ts"));
  assert.ok(!events.some((event) => event.kind === "file.deleted" && event.path === p("old/name.ts")));
  const [recreated] = ofKind(events, "file.created");
  assert.equal(recreated!.path, p("gone.ts"));
  assert.equal(new Set(keys(events)).size, events.length, "delete and recreate of one path stay distinct");
  assert.ok(!events.some((event) => event.evidence?.includes("recreated body")));
});

test("recovered toolResult messages reproduce live keys, including per-file events", () => {
  const details = {
    diff: "",
    perFileResults: [
      { path: join(cwd, "x.ts"), diff: "", op: "delete" },
      { path: join(cwd, "y.ts"), diff: "", op: "delete", isError: true, errorText: "ENOENT" },
    ],
  };
  const live = normalizeToolEnd(
    session,
    {
      toolCallId: "c4",
      toolName: "edit",
      args: { input: "..." },
      result: { content: [{ type: "text", text: "ok" }], details },
      isError: false,
    },
    100,
  );
  const recovered = normalizeMessage(
    session,
    {
      role: "toolResult",
      toolCallId: "c4",
      toolName: "edit",
      content: [{ type: "text", text: "ok" }],
      details,
      isError: false,
      timestamp: 99,
    },
    500,
  );
  assert.deepEqual(keys(recovered), keys(live));
  assert.deepEqual(
    recovered.map((event) => [event.kind, event.outcome]),
    live.map((event) => [event.kind, event.outcome]),
  );
  assert.equal(recovered[0]!.source, "recovery");
  assert.equal(recovered[0]!.occurredAt, 99);
  assert.equal(recovered[0]!.observedAt, 500);
});

test("a call id reused under another tool name produces different keys", () => {
  const a = normalizeToolEnd(session, { toolCallId: "dup", toolName: "bash", result: { content: [] }, isError: false }, 1);
  const b = normalizeToolEnd(session, { toolCallId: "dup", toolName: "eval", result: { content: [] }, isError: false }, 1);
  assert.notEqual(a[0]!.key, b[0]!.key);
  const startA = normalizeToolStart(session, { toolCallId: "dup", toolName: "bash", args: {} }, 1);
  const startB = normalizeToolStart(session, { toolCallId: "dup", toolName: "eval", args: {} }, 1);
  assert.notEqual(startA[0]!.key, startB[0]!.key);
  assert.equal(startA[0]!.outcome, "started");
});

test("shell outcomes: nonzero exit, timeout, cancel, missing exit status, success", () => {
  const end = (result: unknown, isError: boolean) =>
    normalizeToolEnd(session, { toolCallId: "b", toolName: "bash", args: { command: "rm -rf build" }, result, isError }, 1)[0]!;
  const nonzero = end(
    { content: [{ type: "text", text: "rm: cannot remove\n\nCommand exited with code 1" }], details: { exitCode: 1 }, isError: true },
    true,
  );
  assert.deepEqual([nonzero.kind, nonzero.outcome], ["tool.failed", "failed"]);
  assert.match(nonzero.summary, /code 1/);
  const timeout = end(
    { content: [{ type: "text", text: "[Command timed out after 5 seconds]" }], details: { timedOut: true }, isError: true },
    true,
  );
  assert.equal(timeout.outcome, "failed");
  assert.match(timeout.summary, /timed out/);
  assert.equal(end({ content: [{ type: "text", text: "[Command cancelled]\npartial" }] }, true).outcome, "canceled");
  assert.equal(end({ content: [{ type: "text", text: "out\n\nCommand failed: missing exit status" }] }, true).outcome, "unknown");
  const ok = end({ content: [{ type: "text", text: "" }], details: {} }, false);
  assert.equal(ok.outcome, "completed");
  const asyncFailed = end(
    { content: [{ type: "text", text: "boom" }], details: { async: { state: "failed", jobId: "j", type: "bash" } } },
    false,
  );
  assert.equal(asyncFailed.outcome, "failed");
  assert.equal(end({ content: [{ type: "text", text: "partial\n\n[Command aborted]" }] }, false).outcome, "canceled");
});

test("shell text is never read as a deletion", () => {
  const events = normalizeToolEnd(
    session,
    {
      toolCallId: "b2",
      toolName: "bash",
      args: { command: "rm src/a.ts" },
      result: { content: [{ type: "text", text: "removed 'src/a.ts'" }], details: {} },
      isError: false,
    },
    1,
  );
  assert.ok(!events.some((event) => event.kind.startsWith("file.")));
});

test("a background launch is started, not completed; job snapshots record transitions", () => {
  const [launch] = normalizeToolEnd(
    session,
    {
      toolCallId: "bg",
      toolName: "bash",
      args: { command: "npm test", async: true },
      result: {
        content: [{ type: "text", text: "Started job bg_1" }],
        details: { async: { state: "running", jobId: "bg_1", type: "bash" } },
      },
      isError: false,
    },
    10,
  );
  assert.deepEqual([launch!.kind, launch!.outcome], ["job.launched", "started"]);
  const snapshot = {
    running: [{ id: "bg_2", type: "bash", status: "running", label: "sleep", startTime: 11 }],
    recent: [
      { id: "bg_1", type: "bash", status: "failed", label: "npm test", startTime: 10, endTime: 20 },
      { id: "bg_3", type: "task", status: "cancelled", startTime: 12, endTime: 13 },
    ],
    delivery: {},
  };
  const jobs = normalizeJobs(session, snapshot, 30);
  assert.deepEqual(
    jobs.map((job) => [job.key, job.kind, job.outcome, job.occurredAt]),
    [
      ["job:bg_2:running", "job.running", "started", 11],
      ["job:bg_1:failed", "job.failed", "failed", 20],
      ["job:bg_3:cancelled", "job.canceled", "canceled", 13],
    ],
  );
  const delivered = normalizeMessage(
    session,
    {
      role: "custom",
      customType: "async-result",
      display: true,
      content: "job bg_1 output",
      details: { jobs: [{ jobId: "bg_1", type: "bash" }] },
      timestamp: 21,
    },
    22,
  );
  assert.deepEqual(
    delivered.map((event) => [event.key, event.outcome]),
    [["job:bg_1:delivered", "unknown"]],
  );
});

test("a user's request is distinct from the agent's request and the executed action", () => {
  const user = normalizeMessage(session, { role: "user", content: "please delete src/legacy.ts", timestamp: 1 }, 2);
  assert.deepEqual(
    user.map((event) => [event.kind, event.outcome]),
    [["message.user", "requested"]],
  );
  assert.ok(!user.some((event) => event.kind.startsWith("file.")));
  const assistant = normalizeMessage(
    session,
    {
      role: "assistant",
      timestamp: 3,
      content: [
        { type: "thinking", thinking: "the user secretly wants X" },
        { type: "text", text: "Deleting it." },
        { type: "toolCall", id: "c9", name: "edit", arguments: { path: "src/legacy.ts", op: "delete" } },
      ],
    },
    4,
  );
  assert.deepEqual(
    assistant.map((event) => [event.kind, event.outcome]),
    [
      ["message.assistant", "observed"],
      ["tool.requested", "requested"],
    ],
  );
  assert.ok(assistant.every((event) => !`${event.summary}${event.evidence}`.includes("secretly")));
  assert.equal(assistant[1]!.key, "tool:edit:c9:request");
  assert.deepEqual(
    normalizeMessage(session, { role: "user", content: "x", timestamp: 1 }, 2).map((e) => e.key),
    normalizeMessage(session, { role: "user", content: "x", timestamp: 1 }, 9).map((e) => e.key),
  );
  const full = normalizeMessage(session, { role: "user", content: "long request ".repeat(50), timestamp: 7 }, 8);
  const persistedTruncated = normalizeMessage(session, { role: "user", content: "long request", timestamp: 7 }, 9);
  assert.deepEqual(keys(persistedTruncated), keys(full), "a truncated persisted copy dedupes against live capture");
});

test("hidden and system content are excluded; compaction is an event", () => {
  assert.deepEqual(normalizeMessage(session, { role: "developer", content: "system rules" }, 1), []);
  assert.deepEqual(normalizeMessage(session, { role: "user", content: "auto continue", synthetic: true }, 1), []);
  assert.deepEqual(
    normalizeMessage(session, { role: "custom", customType: "plan-mode-context", content: "hidden", display: false }, 1),
    [],
  );
  const [compacted] = normalizeMessage(
    session,
    { role: "compactionSummary", summary: "did stuff", tokensBefore: 5, timestamp: "2026-09-01T00:00:00.000Z" },
    1,
  );
  assert.equal(compacted!.kind, "session.compacted");
  assert.equal(compacted!.occurredAt, Date.parse("2026-09-01T00:00:00.000Z"));
  assert.equal(compacted!.indexable, false);
});

test("history and recall results are not indexable; sensitive file reads are not retained", () => {
  const [recall] = normalizeToolEnd(
    session,
    { toolCallId: "r", toolName: "memory_history", result: { content: [{ type: "text", text: "old events" }] }, isError: false },
    1,
  );
  assert.equal(recall!.indexable, false);
  assert.equal(
    normalizeToolEnd(session, { toolCallId: "r2", toolName: "mcp__mcpbytes_memory_search", result: { content: [] }, isError: false }, 1)[0]!
      .indexable,
    false,
  );
  const [read] = normalizeToolEnd(
    session,
    {
      toolCallId: "r3",
      toolName: "read",
      args: { path: ".env" },
      result: { content: [{ type: "text", text: "OPAQUE=abc123xyz" }] },
      isError: false,
    },
    1,
  );
  assert.ok(!`${read!.summary}${read!.evidence}`.includes("abc123xyz"));
  assert.equal(read!.redacted, true);
  assert.equal(read!.indexable, false);
  const [status] = normalizeMessage(
    session,
    { role: "custom", customType: "mcpbytes-history-status", display: true, content: "3 events", timestamp: 1 },
    2,
  );
  assert.equal(status!.indexable, false);
  const [irc] = normalizeMessage(session, { role: "custom", customType: "irc:incoming", display: true, content: "hello", timestamp: 1 }, 2);
  assert.notEqual(irc!.indexable, false);
});

test("tool arguments and outputs are sanitized before they become events", () => {
  const token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const [start] = normalizeToolStart(
    session,
    {
      toolCallId: "t",
      toolName: "bash",
      args: { command: `curl -H "Authorization: token ${token}" https://u:pw12345@x.dev`, env: { GITHUB_TOKEN: "plain" } },
    },
    1,
  );
  const [end] = normalizeToolEnd(
    session,
    {
      toolCallId: "t",
      toolName: "bash",
      args: { password: "hunter22" },
      result: { content: [{ type: "text", text: `echo ${token}` }] },
      isError: false,
    },
    2,
  );
  for (const event of [start!, end!]) {
    const all = `${event.summary}${event.evidence}`;
    for (const leaked of [token, "pw12345", "plain", "hunter22"]) assert.ok(!all.includes(leaked), leaked);
    assert.equal(event.redacted, true);
  }
});

test("artifact evidence: only metadata IDs read, gaps marked, text references ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-artifacts-"));
  try {
    await writeFile(join(dir, "3.bash.log"), "line1\nfull output with sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345\n");
    await writeFile(join(dir, "4.bash.log"), Buffer.from([0x50, 0x00, 0x51]));
    await mkdir(join(dir, "5.bash.log"));
    await writeFile(join(dir, "6.read.log"), "UNRELATED SECRET ARTIFACT");
    const meta = (truncationId: string, columnId?: string) => ({
      content: [{ type: "text", text: "tail...\nsee artifact://6" }],
      details: {
        meta: {
          truncation: { artifactId: truncationId },
          ...(columnId ? { limits: { columnTruncated: { maxColumn: 1, artifactId: columnId } } } : {}),
        },
      },
    });
    const out = await readHistoryArtifacts(meta("3"), dir);
    assert.match(out.text, /\[artifact:\/\/3 full output\]\nline1\nfull output with \[REDACTED\]/);
    assert.ok(!out.text.includes("UNRELATED"), "untrusted text references are not followed");
    assert.equal(out.redacted, true);
    assert.equal(out.unavailable, false);
    assert.equal(out.truncated, false);
    const binary = await readHistoryArtifacts(meta("4", "5"), dir);
    assert.match(binary.text, /artifact:\/\/4 omitted: binary/);
    assert.match(binary.text, /artifact:\/\/5 unavailable: not a regular file/);
    assert.ok(!binary.text.includes("\u0000"));
    assert.equal(binary.unavailable, true);
    const missing = await readHistoryArtifacts(meta("9"), dir);
    assert.match(missing.text, /artifact:\/\/9 unavailable: not found/);
    assert.equal(missing.unavailable, true);

    const missingDir = await readHistoryArtifacts(meta("3"), null);
    assert.equal(missingDir.unavailable, true);
    assert.equal((await readHistoryArtifacts({ content: [{ type: "text", text: "no refs" }] }, dir)).text, "");
    const failed = await readHistoryArtifacts({ content: [], details: { meta: { artifactError: { reason: "disk full" } } } }, dir);
    assert.equal(failed.unavailable, true);
    assert.match(failed.text, /capture failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
