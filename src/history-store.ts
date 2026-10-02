/**
 * Local, authoritative activity history: SQLite (WAL) with a full-text index. Every event expires at its own observed
 * age + 30 days; reads, replays and reindexing never renew it. This is a record of observed activity, never a
 * snapshot store: evidence is redacted and bounded before it is written.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RememberRequest } from "./api.ts";
import { sanitizeHistory } from "./history-privacy.ts";
import {
  HISTORY_EVIDENCE_BYTES,
  HISTORY_QUERY_BYTES,
  HISTORY_RETENTION_MS,
  historyId,
  type FileObservation,
  type HistoryEvent,
  type HistoryEventInput,
  type HistoryOutbox,
  type HistoryPage,
  type HistoryQuery,
  type HistorySession,
  type HistoryStatus,
  type HistoryStorage,
  type ObservedRoot,
} from "./history-types.ts";

/** A claimed upload is someone else's for this long; a crashed instance's claim then lapses. */
const UPLOAD_LEASE_MS = 30_000;
/** The server refuses an expiry less than a minute away; such a segment stays local until it expires. */
export const UPLOAD_MIN_LIFETIME_MS = 60_000;
const SUMMARY_BYTES = 4_096;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
export const HISTORY_REFERENCE = "mcpbytes-history://";

interface EventRow {
  id: string;
  seq: number;
  session_id: string;
  workspace_id: string;
  key: string;
  kind: string;
  occurred_at: number;
  observed_at: number;
  expires_at: number;
  summary: string;
  evidence: string | null;
  source: string;
  outcome: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  path: string | null;
  from_path: string | null;
  branch_id: string | null;
  entry_id: string | null;
  parent_entry_id: string | null;
  redacted: number;
  truncated: number;
  unavailable: number;
  indexable: number;
}

interface OutboxRow {
  id: string;
  session_id: string;
  destination: string;
  payload: string;
  expires_at: number;
  status: HistoryOutbox["status"];
  memory_id: string | null;
  error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, cwd TEXT NOT NULL, agent_id TEXT NOT NULL, agent_kind TEXT NOT NULL,
  parent_agent_id TEXT, parent_session_file TEXT, session_file TEXT, started_at INTEGER NOT NULL, cloud_space TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_workspace ON sessions (workspace_id);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  key TEXT NOT NULL, kind TEXT NOT NULL, occurred_at INTEGER NOT NULL, observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, summary TEXT NOT NULL, evidence TEXT, source TEXT NOT NULL, outcome TEXT,
  tool_call_id TEXT, tool_name TEXT, path TEXT, from_path TEXT, branch_id TEXT, entry_id TEXT, parent_entry_id TEXT,
  redacted INTEGER NOT NULL, truncated INTEGER NOT NULL, unavailable INTEGER NOT NULL, indexable INTEGER NOT NULL,
  UNIQUE (session_id, key)
);
CREATE INDEX IF NOT EXISTS events_timeline ON events (workspace_id, occurred_at, seq);
CREATE INDEX IF NOT EXISTS events_expiry ON events (expires_at);
CREATE INDEX IF NOT EXISTS events_path ON events (workspace_id, path);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5 (summary, evidence, path, tokenize = 'unicode61');
CREATE TABLE IF NOT EXISTS roots (
  workspace_id TEXT NOT NULL, root TEXT NOT NULL, last_scan_at INTEGER NOT NULL, error TEXT, PRIMARY KEY (workspace_id, root)
);
CREATE TABLE IF NOT EXISTS inventory (
  workspace_id TEXT NOT NULL, root TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, root, path)
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, destination TEXT NOT NULL, payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL, status TEXT NOT NULL, memory_id TEXT, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_claim ON outbox (destination, status, retry_at);
CREATE TABLE IF NOT EXISTS outbox_events (
  outbox_id TEXT NOT NULL, event_id TEXT NOT NULL, destination TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (event_id, destination)
);
CREATE INDEX IF NOT EXISTS outbox_events_outbox ON outbox_events (outbox_id, position);
CREATE TABLE IF NOT EXISTS session_destinations (session_id TEXT PRIMARY KEY, destination TEXT NOT NULL);
`;

const EVENT_COLUMNS = `seq, id, session_id, workspace_id, key, kind, occurred_at, observed_at, expires_at, summary, source, outcome,
  tool_call_id, tool_name, path, from_path, branch_id, entry_id, parent_entry_id, redacted, truncated, unavailable, indexable`;

function columns(alias: string, evidence: boolean): string {
  const list = EVENT_COLUMNS.split(",").map((c) => `${alias}.${c.trim()}`);
  return [...list, evidence ? `${alias}.evidence` : "NULL AS evidence"].join(", ");
}

function toEvent(row: EventRow): HistoryEvent {
  const event: HistoryEvent = {
    id: row.id,
    seq: row.seq,
    key: row.key,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    occurredAt: row.occurred_at,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    summary: row.summary,
    source: row.source as HistoryEvent["source"],
    redacted: row.redacted === 1,
    truncated: row.truncated === 1,
    unavailable: row.unavailable === 1,
    indexable: row.indexable === 1,
  };
  if (row.evidence !== null) event.evidence = row.evidence;
  if (row.outcome !== null) event.outcome = row.outcome as HistoryEvent["outcome"];
  if (row.tool_call_id !== null) event.toolCallId = row.tool_call_id;
  if (row.tool_name !== null) event.toolName = row.tool_name;
  if (row.path !== null) event.path = row.path;
  if (row.from_path !== null) event.fromPath = row.from_path;
  if (row.branch_id !== null) event.branchId = row.branch_id;
  if (row.entry_id !== null) event.entryId = row.entry_id;
  if (row.parent_entry_id !== null) event.parentEntryId = row.parent_entry_id;
  return event;
}

function toOutbox(row: OutboxRow, eventIds: string[]): HistoryOutbox {
  const item: HistoryOutbox = {
    id: row.id,
    sessionId: row.session_id,
    destination: row.destination,
    eventIds,
    payload: JSON.parse(row.payload) as RememberRequest,
    expiresAt: row.expires_at,
    status: row.status,
  };
  if (row.memory_id !== null) item.memoryId = row.memory_id;
  if (row.error !== null) item.error = row.error;
  return item;
}

/** Words of a free-text query as quoted FTS5 terms (all required), so user text is never FTS syntax. */
export function ftsQuery(text: string): string {
  return (text.match(/[\p{L}\p{N}_]+/gu) ?? []).map((word) => `"${word}"`).join(" ");
}

function decodeCursor(cursor: string): [number, number] | undefined {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(value) && value.length === 2 && value.every((n) => Number.isSafeInteger(n))) return value as [number, number];
  } catch {}
  return undefined;
}

/** `mcpbytes-history://<device>/<session>/<segment>`; anything else is not a history reference. */
export function parseReference(source: string): { device: string; session: string; segment: string } | undefined {
  if (!source.startsWith(HISTORY_REFERENCE)) return undefined;
  const parts = source.slice(HISTORY_REFERENCE.length).split("/");
  if (parts.length !== 3 || parts.some((part) => !part)) return undefined;
  const [device, session, segment] = parts.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  if (!device || !session || !segment) return undefined;
  return { device, session, segment };
}

export function historyReference(device: string, session: string, segment: string): string {
  return `${HISTORY_REFERENCE}${encodeURIComponent(device)}/${encodeURIComponent(session)}/${encodeURIComponent(segment)}`;
}

export class HistoryStore implements HistoryStorage {
  readonly deviceId: string;
  private readonly db: Database;
  private readonly clock: () => number;
  private readonly registrations = new Map<string, HistorySession>();

  constructor(path: string, clock: () => number = Date.now) {
    this.clock = clock;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    if (path !== ":memory:") {
      // WAL/SHM exist only once WAL mode is on.
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        try {
          chmodSync(file, 0o600);
        } catch {}
      }
    }
    this.db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('device_id', ?)").run(randomUUID());
    const device = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'device_id'").get();
    if (!device) throw new Error("history store has no device id");
    this.deviceId = device.value;
  }

  registerSession(session: HistorySession): void {
    this.db
      .query(
        `INSERT INTO sessions (id, workspace_id, cwd, agent_id, agent_kind, parent_agent_id, parent_session_file, session_file, started_at, cloud_space)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           parent_agent_id = COALESCE(excluded.parent_agent_id, parent_agent_id),
           parent_session_file = COALESCE(excluded.parent_session_file, parent_session_file),
           session_file = COALESCE(excluded.session_file, session_file),
           started_at = MIN(started_at, excluded.started_at),
           cloud_space = excluded.cloud_space`,
      )
      .run(
        session.id,
        session.workspaceId,
        session.cwd,
        session.agentId,
        session.agentKind,
        session.parentAgentId ?? null,
        session.parentSessionFile ?? null,
        session.sessionFile ?? null,
        session.startedAt,
        session.cloudSpace,
      );
    this.registrations.set(session.id, session);
  }

  session(id: string): HistorySession | undefined {
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, string | number | null> | null;
    if (!row) return undefined;
    const session: HistorySession = {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      cwd: row.cwd as string,
      agentId: row.agent_id as string,
      agentKind: row.agent_kind as HistorySession["agentKind"],
      startedAt: row.started_at as number,
      cloudSpace: row.cloud_space as string,
    };
    if (row.parent_agent_id !== null) session.parentAgentId = row.parent_agent_id as string;
    if (row.parent_session_file !== null) session.parentSessionFile = row.parent_session_file as string;
    if (row.session_file !== null) session.sessionFile = row.session_file as string;
    return session;
  }

  /** Null when nothing new was recorded: a duplicate key, an event already past its age, or an unknown session. */
  append(input: HistoryEventInput): HistoryEvent | null {
    const now = this.clock();
    const observedAt = input.observedAt ?? now;
    // The age is fixed by the earliest time the event is known to have existed; a future timestamp cannot extend it.
    const expiresAt = Math.min(input.occurredAt, observedAt) + HISTORY_RETENTION_MS;
    if (expiresAt <= now) return null;
    const summary = sanitizeHistory(input.summary, SUMMARY_BYTES);
    const evidence = input.evidence === undefined ? undefined : sanitizeHistory(input.evidence, HISTORY_EVIDENCE_BYTES);
    const redacted = Boolean(input.redacted || summary.redacted || evidence?.redacted);
    const truncated = Boolean(input.truncated || summary.truncated || evidence?.truncated);
    const path = input.path === undefined ? undefined : sanitizeHistory(input.path, SUMMARY_BYTES).text;
    const fromPath = input.fromPath === undefined ? undefined : sanitizeHistory(input.fromPath, SUMMARY_BYTES).text;
    const toolName = input.toolName === undefined ? undefined : sanitizeHistory(input.toolName, 256).text;
    return this.db
      .transaction((): HistoryEvent | null => {
        let owner = this.db.query("SELECT workspace_id FROM sessions WHERE id = ?").get(input.sessionId) as {
          workspace_id: string;
        } | null;
        if (!owner) {
          // A still-running session can become empty after 30 idle days. Restore its identity only for new activity,
          // never the expired events. Unregistered callers still cannot invent a session.
          const registered = this.registrations.get(input.sessionId);
          if (!registered) return null;
          this.registerSession(registered);
          owner = { workspace_id: registered.workspaceId };
        }
        // Filesystem observations are facts about the workspace: concurrent sessions observing the same change share one
        // event (the first observer's session is kept as provenance). Everything else is session-scoped.
        const id =
          input.source === "filesystem"
            ? historyId("event", "workspace", owner.workspace_id, input.key)
            : historyId("event", input.sessionId, input.key);
        const inserted = this.db
          .query(
            `INSERT OR IGNORE INTO events (id, session_id, workspace_id, key, kind, occurred_at, observed_at, expires_at, summary, evidence, source,
             outcome, tool_call_id, tool_name, path, from_path, branch_id, entry_id, parent_entry_id, redacted, truncated, unavailable, indexable)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.sessionId,
            owner.workspace_id,
            input.key,
            input.kind,
            input.occurredAt,
            observedAt,
            expiresAt,
            summary.text,
            evidence?.text ?? null,
            input.source,
            input.outcome ?? null,
            input.toolCallId ?? null,
            toolName ?? null,
            path ?? null,
            fromPath ?? null,
            input.branchId ?? null,
            input.entryId ?? null,
            input.parentEntryId ?? null,
            redacted ? 1 : 0,
            truncated ? 1 : 0,
            input.unavailable ? 1 : 0,
            input.indexable === false ? 0 : 1,
          );
        if (inserted.changes === 0) return null;
        const seq = Number(inserted.lastInsertRowid);
        const searchablePath = [path, fromPath].filter(Boolean).join(" ");
        this.db
          .query("INSERT INTO events_fts (rowid, summary, evidence, path) VALUES (?, ?, ?, ?)")
          .run(seq, summary.text, evidence?.text ?? "", searchablePath);
        return toEvent(this.db.query(`SELECT ${columns("e", true)} FROM events e WHERE e.seq = ?`).get(seq) as EventRow);
      })
      .immediate();
  }

  linkEntry(sessionId: string, key: string, entryId: string, parentEntryId?: string): void {
    this.db
      .query(
        "UPDATE events SET entry_id = ?, parent_entry_id = COALESCE(?, parent_entry_id) WHERE session_id = ? AND key = ? AND expires_at > ?",
      )
      .run(entryId, parentEntryId ?? null, sessionId, key, this.clock());
  }

  query(input: HistoryQuery): HistoryPage {
    const now = this.clock();
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(input.limit ?? DEFAULT_LIMIT)));
    const where = ["e.workspace_id = ?", "e.expires_at > ?"];
    const params: (string | number)[] = [input.workspaceId, now];
    let from = "events e";
    if (input.sessionId) {
      where.push("e.session_id = ?");
      params.push(input.sessionId);
    }
    if (input.from !== undefined) {
      where.push("e.occurred_at >= ?");
      params.push(input.from);
    }
    if (input.to !== undefined) {
      where.push("e.occurred_at <= ?");
      params.push(input.to);
    }
    if (input.outcome) {
      where.push("e.outcome = ?");
      params.push(input.outcome);
    }
    if (input.path) {
      const path = input.path.replace(/\/+$/, "");
      const prefix = `${path}/`;
      where.push("(e.path = ? OR e.from_path = ? OR substr(e.path, 1, ?) = ? OR substr(e.from_path, 1, ?) = ?)");
      params.push(path, path, prefix.length, prefix, prefix.length, prefix);
    }
    if (input.query) {
      const match = ftsQuery(input.query);
      if (!match) return { events: [], cutoff: now - HISTORY_RETENTION_MS };
      from = "events_fts f JOIN events e ON e.seq = f.rowid";
      where.push("events_fts MATCH ?");
      params.push(match);
    }
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (!cursor) throw new Error("invalid_cursor: the history cursor is not valid");
      where.push("(e.occurred_at < ? OR (e.occurred_at = ? AND e.seq < ?))");
      params.push(cursor[0], cursor[0], cursor[1]);
    }
    params.push(limit + 1);
    const rows = this.db
      .query(
        `SELECT ${columns("e", Boolean(input.evidence))} FROM ${from} WHERE ${where.join(" AND ")} ORDER BY e.occurred_at DESC, e.seq DESC LIMIT ?`,
      )
      .all(...params) as EventRow[];
    const events: HistoryEvent[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const size = Buffer.byteLength(row.summary) + (row.evidence ? Buffer.byteLength(row.evidence) : 0);
      // Evidence is bounded per page; the remainder is reached with the cursor, never silently dropped.
      if (events.length > 0 && bytes + size > HISTORY_QUERY_BYTES) break;
      bytes += size;
      events.push(toEvent(row));
    }
    const page: HistoryPage = { events, cutoff: now - HISTORY_RETENTION_MS };
    const last = events.at(-1);
    if (last && events.length < rows.length)
      page.nextCursor = Buffer.from(JSON.stringify([last.occurredAt, last.seq])).toString("base64url");
    return page;
  }

  get(id: string, workspaceId: string): HistoryEvent | undefined {
    const row = this.db
      .query(`SELECT ${columns("e", true)} FROM events e WHERE e.id = ? AND e.workspace_id = ? AND e.expires_at > ?`)
      .get(id, workspaceId, this.clock()) as EventRow | null;
    return row ? toEvent(row) : undefined;
  }

  status(workspaceId: string): HistoryStatus {
    const now = this.clock();
    const count = (sql: string, ...params: (string | number)[]): number =>
      this.db.query<{ n: number }, (string | number)[]>(sql).get(...params)?.n ?? 0;
    const outbox = (status: string): number =>
      count(
        `SELECT COUNT(*) AS n FROM outbox o JOIN sessions s ON s.id = o.session_id WHERE s.workspace_id = ? AND o.status = ? AND o.expires_at > ?`,
        workspaceId,
        status,
        now,
      );
    const failure = this.db
      .query(
        `SELECT o.error FROM outbox o JOIN sessions s ON s.id = o.session_id
         WHERE s.workspace_id = ? AND o.status IN ('pending', 'sending') AND o.error IS NOT NULL AND o.expires_at > ?
         ORDER BY o.retry_at DESC LIMIT 1`,
      )
      .get(workspaceId, now) as { error: string } | null;
    const gaps = this.db
      .query(
        `SELECT ${columns("e", true)} FROM events e WHERE e.workspace_id = ? AND e.expires_at > ? AND e.kind LIKE 'coverage.%' ORDER BY e.occurred_at, e.seq LIMIT 50`,
      )
      .all(workspaceId, now) as EventRow[];
    const roots = this.db.query("SELECT root, last_scan_at, error FROM roots WHERE workspace_id = ? ORDER BY root").all(workspaceId) as {
      root: string;
      last_scan_at: number;
      error: string | null;
    }[];
    const status: HistoryStatus = {
      events: count("SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND expires_at > ?", workspaceId, now),
      sessions: count("SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ?", workspaceId),
      pendingUploads: outbox("pending") + outbox("sending"),
      proposedUploads: outbox("proposed"),
      acceptedUploads: outbox("accepted"),
      roots: roots.map((r): ObservedRoot =>
        r.error === null ? { root: r.root, lastScanAt: r.last_scan_at } : { root: r.root, lastScanAt: r.last_scan_at, error: r.error },
      ),
      gaps: gaps.map(toEvent),
    };
    if (failure) status.uploadError = failure.error;
    return status;
  }

  inventory(workspaceId: string, root: string): FileObservation[] {
    const rows = this.db
      .query("SELECT path, kind, last_seen_at FROM inventory WHERE workspace_id = ? AND root = ? AND last_seen_at > ? ORDER BY path")
      .all(workspaceId, root, this.clock() - HISTORY_RETENTION_MS) as {
      path: string;
      kind: FileObservation["kind"];
      last_seen_at: number;
    }[];
    return rows.map((r) => ({ path: r.path, kind: r.kind, lastSeenAt: r.last_seen_at }));
  }

  rememberFile(workspaceId: string, root: string, entry: FileObservation): void {
    this.db
      .query("INSERT OR REPLACE INTO inventory (workspace_id, root, path, kind, last_seen_at) VALUES (?, ?, ?, ?, ?)")
      .run(workspaceId, root, entry.path, entry.kind, entry.lastSeenAt);
  }

  /** The root's whole metadata inventory as of `at` (paths and kinds only; never contents). */
  replaceInventory(workspaceId: string, root: string, entries: FileObservation[], at: number): void {
    this.db
      .transaction(() => {
        this.db.query("DELETE FROM inventory WHERE workspace_id = ? AND root = ?").run(workspaceId, root);
        const insert = this.db.query(
          "INSERT OR REPLACE INTO inventory (workspace_id, root, path, kind, last_seen_at) VALUES (?, ?, ?, ?, ?)",
        );
        for (const entry of entries) insert.run(workspaceId, root, entry.path, entry.kind, entry.lastSeenAt);
        this.upsertRoot(workspaceId, root, at);
      })
      .immediate();
  }

  recordRoot(workspaceId: string, root: string, at: number, error?: string): void {
    this.upsertRoot(workspaceId, root, at, error === undefined ? undefined : sanitizeHistory(error, 1024).text);
  }

  /** First destination wins: a session's activity is only ever indexed for one account. */
  bindDestination(sessionId: string, destination: string): boolean {
    this.db.query("INSERT OR IGNORE INTO session_destinations (session_id, destination) VALUES (?, ?)").run(sessionId, destination);
    const bound = this.db
      .query<{ destination: string }, [string]>("SELECT destination FROM session_destinations WHERE session_id = ?")
      .get(sessionId);
    return bound?.destination === destination;
  }

  private upsertRoot(workspaceId: string, root: string, at: number, error?: string): void {
    this.db
      .query(
        `INSERT INTO roots (workspace_id, root, last_scan_at, error) VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id, root) DO UPDATE SET last_scan_at = excluded.last_scan_at, error = excluded.error`,
      )
      .run(workspaceId, root, at, error ?? null);
  }

  /** Unexpired indexable events of the session not yet assigned to a segment for this destination, in order. */
  unindexedEvents(sessionId: string, destination: string): HistoryEvent[] {
    const rows = this.db
      .query(
        `SELECT ${columns("e", true)} FROM events e
         WHERE e.session_id = ? AND e.indexable = 1 AND e.expires_at > ?
           AND NOT EXISTS (SELECT 1 FROM outbox_events l WHERE l.event_id = e.id AND l.destination = ?)
         ORDER BY e.occurred_at, e.seq`,
      )
      .all(sessionId, this.clock(), destination) as EventRow[];
    return rows.map(toEvent);
  }

  /** The segment and its event associations land together; an existing segment is never rewritten. */
  enqueue(item: HistoryOutbox): void {
    this.db
      .transaction(() => {
        // Another recorder can have sealed an overlapping set after our read. Never upload a second payload
        // containing already-indexed evidence; the remaining local events are selected by the next seal.
        const overlap = this.db
          .query("SELECT 1 FROM outbox_events WHERE destination = ? AND event_id IN (SELECT value FROM json_each(?)) LIMIT 1")
          .get(item.destination, JSON.stringify(item.eventIds));
        if (overlap) return;
        const inserted = this.db
          .query(
            `INSERT OR IGNORE INTO outbox (id, session_id, destination, payload, expires_at, status, memory_id, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            item.id,
            item.sessionId,
            item.destination,
            JSON.stringify(item.payload),
            item.expiresAt,
            item.status,
            item.memoryId ?? null,
            item.error ?? null,
            this.clock(),
          );
        if (inserted.changes === 0) return;
        const link = this.db.query("INSERT OR IGNORE INTO outbox_events (outbox_id, event_id, destination, position) VALUES (?, ?, ?, ?)");
        item.eventIds.forEach((eventId, position) => link.run(item.id, eventId, item.destination, position));
      })
      .immediate();
  }

  /** Leases the oldest due segment for this destination; another plugin instance cannot claim it meanwhile. */
  claimUpload(destination: string): HistoryOutbox | undefined {
    return this.db
      .transaction((): HistoryOutbox | undefined => {
        const now = this.clock();
        const row = this.db
          .query(
            `SELECT id, session_id, destination, payload, expires_at, status, memory_id, error FROM outbox
           WHERE destination = ? AND expires_at > ? AND retry_at <= ?
             AND (status = 'pending' OR (status = 'sending' AND lease_until <= ?))
           ORDER BY created_at, id LIMIT 1`,
          )
          .get(destination, now + UPLOAD_MIN_LIFETIME_MS, now, now) as OutboxRow | null;
        if (!row) return undefined;
        this.db
          .query("UPDATE outbox SET status = 'sending', lease_until = ?, attempts = attempts + 1 WHERE id = ?")
          .run(now + UPLOAD_LEASE_MS, row.id);
        return toOutbox({ ...row, status: "sending" }, this.segmentEvents(row.id));
      })
      .immediate();
  }

  finishUpload(id: string, status: "accepted" | "proposed", memoryId?: string): void {
    this.db
      .query("UPDATE outbox SET status = ?, memory_id = ?, error = NULL, lease_until = 0 WHERE id = ?")
      .run(status, memoryId ?? null, id);
  }

  failUpload(id: string, error: string, retryAt: number): void {
    this.db
      .query(
        "UPDATE outbox SET status = 'pending', error = ?, retry_at = ?, lease_until = 0 WHERE id = ? AND status IN ('pending', 'sending')",
      )
      .run(sanitizeHistory(error, 1024).text, Math.min(retryAt, Number.MAX_SAFE_INTEGER), id);
  }

  private segmentEvents(outboxId: string): string[] {
    const rows = this.db
      .query<{ event_id: string }, [string]>("SELECT event_id FROM outbox_events WHERE outbox_id = ? ORDER BY position")
      .all(outboxId);
    return rows.map((r) => r.event_id);
  }

  /** Local evidence behind a history reference, only for this device and this workspace, and only while unexpired. */
  resolveReference(source: string, workspaceId: string): HistoryEvent[] | undefined {
    const ref = parseReference(source);
    if (!ref || ref.device !== this.deviceId) return undefined;
    const now = this.clock();
    const owner = this.db
      .query(
        `SELECT o.id FROM outbox o JOIN sessions s ON s.id = o.session_id WHERE o.id = ? AND o.session_id = ? AND s.workspace_id = ? AND o.expires_at > ?`,
      )
      .get(ref.segment, ref.session, workspaceId, now) as { id: string } | null;
    if (!owner) return undefined;
    const rows = this.db
      .query(
        `SELECT ${columns("e", true)} FROM outbox_events l JOIN events e ON e.id = l.event_id
         WHERE l.outbox_id = ? AND e.session_id = ? AND e.workspace_id = ? AND e.expires_at > ? ORDER BY l.position`,
      )
      .all(owner.id, ref.session, workspaceId, now) as EventRow[];
    return rows.map(toEvent);
  }

  /** Physically removes what has passed its fixed age; nothing here moves a deadline. */
  purge(): void {
    const now = this.clock();
    const stale = now - HISTORY_RETENTION_MS;
    this.db
      .transaction(() => {
        this.db.query("DELETE FROM events_fts WHERE rowid IN (SELECT seq FROM events WHERE expires_at <= ?)").run(now);
        this.db.query("DELETE FROM outbox_events WHERE event_id IN (SELECT id FROM events WHERE expires_at <= ?)").run(now);
        this.db.query("DELETE FROM events WHERE expires_at <= ?").run(now);
        this.db.query("DELETE FROM outbox_events WHERE outbox_id IN (SELECT id FROM outbox WHERE expires_at <= ?)").run(now);
        this.db.query("DELETE FROM outbox WHERE expires_at <= ?").run(now);
        this.db.query("DELETE FROM inventory WHERE last_seen_at <= ?").run(stale);
        this.db.query("DELETE FROM roots WHERE last_scan_at <= ?").run(stale);
        this.db
          .query(
            "DELETE FROM sessions WHERE started_at <= ? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.id) AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.session_id = sessions.id)",
          )
          .run(stale);
        this.db.query("DELETE FROM session_destinations WHERE session_id NOT IN (SELECT id FROM sessions)").run();
      })
      .immediate();
  }

  close(): void {
    this.registrations.clear();
    this.db.close();
  }
}
