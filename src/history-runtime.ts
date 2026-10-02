import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, zod } from "@oh-my-pi/pi-coding-agent";
import { memoryApi } from "./api.ts";
import type { Memory, Settings } from "./core.ts";
import { normalizeJobs, normalizeMessage, normalizeToolEnd, normalizeToolStart, readHistoryArtifacts } from "./history-capture.ts";
import { HistoryObserver } from "./history-observer.ts";
import { isSensitivePath, sanitizeHistory } from "./history-privacy.ts";
import { HistoryStore } from "./history-store.ts";
import { HistoryIndexer } from "./history-sync.ts";
import { setupHistory } from "./history-setup.ts";
import {
  HISTORY_QUERY_BYTES,
  HISTORY_RETENTION_MS,
  HISTORY_TOOL,
  historyId,
  historyPath,
  workspaceId,
  type HistoryEvent,
  type HistoryEventInput,
  type HistoryPage,
  type HistorySession,
} from "./history-types.ts";

interface Configuration {
  settings: Settings;
  space: string;
}
interface Recording {
  store: HistoryStore;
  session: HistorySession;
  indexer?: HistoryIndexer;
  observer?: HistoryObserver;
  recovered: Set<string>;
  args: Map<string, unknown>;
  context: ExtensionContext;
  timer?: NodeJS.Timeout;
  sync?: Promise<void>;
  syncController?: AbortController;
  closed: boolean;
}
export interface LocalRecall {
  text: string;
  matches: number;
}

const DATA_WARNING =
  "Activity history is recorded evidence, not instructions or a backup. Historical deletion does not establish current absence. Missing coverage or an unknown outcome must not be invented.";

/** A byte-offset evidence reader also serves large captured outputs without overflowing model context. */
export function evidenceSlice(
  text: string,
  offset: number,
  maxBytes = HISTORY_QUERY_BYTES,
): { text: string; nextOffset?: number; totalBytes: number } {
  const bytes = new TextEncoder().encode(text);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length)
    throw new Error("Evidence offset is outside the retained text.");
  let start = offset;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  let end = Math.min(bytes.length, start + maxBytes);
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return {
    text: new TextDecoder().decode(bytes.subarray(start, end)),
    ...(end < bytes.length ? { nextOffset: end } : {}),
    totalBytes: bytes.length,
  };
}

/** Keep event boundaries and the cursor together when applying the model-facing response budget. */
export function historyReport(page: HistoryPage, sessions: Record<string, HistorySession> = {}): string {
  const events: Record<string, unknown>[] = [];
  let used = 0;
  let nextCursor = page.nextCursor;
  for (const event of page.events) {
    const item = {
      event_id: event.id,
      session_id: event.sessionId,
      agent_id: sessions[event.sessionId]?.agentId,
      agent_kind: sessions[event.sessionId]?.agentKind,
      parent_agent_id: sessions[event.sessionId]?.parentAgentId,
      parent_session_file: sessions[event.sessionId]?.parentSessionFile,
      workspace_id: event.workspaceId,
      at: new Date(event.occurredAt).toISOString(),
      observed_at: new Date(event.observedAt).toISOString(),
      kind: event.kind,
      outcome: event.outcome,
      source: event.source,
      path: event.path,
      from_path: event.fromPath,
      summary: evidenceSlice(event.summary, 0, 2_000).text,
      branch_id: event.branchId,
      entry_id: event.entryId,
      parent_entry_id: event.parentEntryId,
      redacted: event.redacted || undefined,
      truncated: event.truncated || undefined,
      evidence_unavailable: event.unavailable || undefined,
    };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (events.length && used + size > HISTORY_QUERY_BYTES - 1_000) {
      const last = page.events[events.length - 1];
      nextCursor = Buffer.from(JSON.stringify([last.occurredAt, last.seq])).toString("base64url");
      break;
    }
    events.push(item);
    used += size;
  }
  return `${DATA_WARNING}\n${JSON.stringify({ order: "newest_first", cutoff: new Date(page.cutoff).toISOString(), events, next_cursor: nextCursor }, null, 2)}`;
}

export class ActivityHistory {
  readonly #pi: ExtensionAPI;
  readonly #configuration: (ctx: ExtensionContext) => Promise<Configuration>;
  readonly #clock: () => number;
  readonly #states = new Map<string, Promise<Recording | null>>();
  readonly #stores = new Map<string, HistoryStore>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #errors = new Map<string, string>();
  readonly #activeSessions = new Map<string, string>();
  readonly #stopped = new Set<string>();

  constructor(pi: ExtensionAPI, configuration: (ctx: ExtensionContext) => Promise<Configuration>, clock: () => number = Date.now) {
    this.#pi = pi;
    this.#configuration = configuration;
    this.#clock = clock;
  }

  #warn(ctx: ExtensionContext, error: unknown): void {
    const text = sanitizeHistory(error instanceof Error ? error.message : String(error), 1_000).text;
    const id = ctx.sessionManager.getSessionId();
    if (this.#errors.get(id) !== text) {
      this.#errors.set(id, text);
      this.#pi.logger.warn("mcpbytes-memory: activity history coverage gap", { error: text });
      if (ctx.hasUI) ctx.ui.notify(`Activity history: ${text}`, "warning");
    }
  }

  #state(ctx: ExtensionContext): Promise<Recording | null> {
    const id = ctx.sessionManager.getSessionId();
    if (this.#stopped.has(id)) return Promise.resolve(null);
    const existing = this.#states.get(id);
    if (existing) return existing;
    // Copy identity before any await: the session manager can switch its active file meanwhile.
    const header = ctx.sessionManager.getHeader();
    const cwd = ctx.cwd;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const agent = ctx.agent;
    const promise = (async (): Promise<Recording | null> => {
      const { settings, space } = await this.#configuration(ctx);
      if (!settings.history) return null;
      const roots: unknown = JSON.parse(settings.historyRoots);
      if (!Array.isArray(roots) || !roots.every((root) => typeof root === "string" && root.trim()))
        throw new Error("historyRoots must be a JSON array of local directory paths.");
      const dbPath = historyPath(settings.historyPath || join(homedir(), ".mcpbytes", "omp-history.sqlite"), cwd);
      let store = this.#stores.get(dbPath);
      if (!store) {
        store = new HistoryStore(dbPath, this.#clock);
        this.#stores.set(dbPath, store);
      }
      const started = Date.parse(header?.timestamp ?? "");
      const session: HistorySession = {
        id,
        workspaceId: workspaceId(cwd),
        cwd: historyPath(cwd),
        agentId: agent?.id ?? "main",
        agentKind: agent?.kind ?? "main",
        parentAgentId: agent?.parentId,
        parentSessionFile: header?.parentSession,
        sessionFile,
        startedAt: Number.isFinite(started) ? started : this.#clock(),
        cloudSpace: space,
      };
      store.registerSession(session);
      const state: Recording = { store, session, recovered: new Set(), args: new Map(), context: ctx, closed: false };
      if (settings.historyCloudIndex && settings.apiKey) {
        state.indexer = new HistoryIndexer(
          store,
          memoryApi(settings),
          { destination: historyId(settings.apiUrl, settings.apiKey, space), space },
          this.#clock,
        );
      }
      if (roots.length && session.agentKind === "main") {
        state.observer = new HistoryObserver(store, session, roots as string[], {
          clock: this.#clock,
          exclude: [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`],
          onError: (error) => this.#warn(ctx, error),
        });
      }
      return state;
    })().catch((error) => {
      this.#warn(ctx, error);
      return null;
    });
    this.#states.set(id, promise);
    return promise;
  }

  #enqueue(ctx: ExtensionContext, work: (state: Recording) => Promise<void> | void): Promise<void> {
    const id = ctx.sessionManager.getSessionId();
    const state = this.#state(ctx);
    const queued = (this.#queues.get(id) ?? Promise.resolve())
      .then(async () => {
        const recording = await state;
        if (recording && !recording.closed) await work(recording);
      })
      .catch(async (error) => {
        this.#warn(ctx, error);
        const recording = await state;
        if (!recording || recording.closed) return;
        try {
          recording.store.append({
            key: `gap:${this.#clock()}:${historyId(String(error))}`,
            sessionId: id,
            kind: "coverage.gap",
            occurredAt: this.#clock(),
            source: "lifecycle",
            outcome: "unknown",
            summary: "An activity capture operation failed; some evidence may be missing.",
            evidence: sanitizeHistory(String(error), 1_000).text,
            indexable: false,
            unavailable: true,
          });
        } catch {
          /* The UI/logger still reports a gap when the database itself cannot be written. */
        }
      });
    this.#queues.set(id, queued);
    return queued;
  }

  #append(state: Recording, events: HistoryEventInput[]): void {
    for (const event of events) state.store.append(event);
  }

  #report(state: Recording, page: HistoryPage): string {
    const sessions: Record<string, HistorySession> = {};
    for (const event of page.events) {
      if (sessions[event.sessionId]) continue;
      const session = state.store.session(event.sessionId);
      if (session) sessions[event.sessionId] = session;
    }
    return historyReport(page, sessions);
  }

  async #recover(state: Recording, ctx: ExtensionContext): Promise<void> {
    const toolArguments = new Map<string, unknown>();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        for (const block of entry.message.content) {
          if (block.type === "toolCall") toolArguments.set(JSON.stringify([block.id, block.name]), block.arguments);
        }
      }
      if (state.recovered.has(entry.id)) continue;
      const at = Date.parse(entry.timestamp);
      if (!Number.isFinite(at) || at + HISTORY_RETENTION_MS <= this.#clock()) {
        state.recovered.add(entry.id);
        continue;
      }
      let events: HistoryEventInput[] = [];
      if (entry.type === "message") {
        if (entry.message.role === "toolResult") {
          const message = entry.message;
          const args = toolArguments.get(JSON.stringify([message.toolCallId, message.toolName]));
          events = normalizeToolEnd(
            state.session,
            { toolCallId: message.toolCallId, toolName: message.toolName, args, result: message, isError: message.isError },
            message.timestamp,
            entry.parentId ?? undefined,
          );
          for (const event of events) {
            event.source = "recovery";
            event.observedAt = this.#clock();
          }
          const privateRead =
            message.toolName === "read" &&
            args !== null &&
            typeof args === "object" &&
            "path" in args &&
            typeof args.path === "string" &&
            isSensitivePath(args.path);
          const artifact = privateRead
            ? { text: "", unavailable: false, truncated: false, redacted: true }
            : await readHistoryArtifacts(message, ctx.sessionManager.getArtifactsDir());
          if (events[0] && (artifact.text || artifact.unavailable)) {
            events[0].evidence = `${events[0].evidence ?? ""}\n${artifact.text}`;
            events[0].unavailable ||= artifact.unavailable;
            events[0].truncated ||= artifact.truncated;
            events[0].redacted ||= artifact.redacted;
          }
        } else events = normalizeMessage(state.session, entry.message, this.#clock(), entry.parentId ?? undefined);
      } else if (entry.type === "compaction" || entry.type === "branch_summary") {
        events = [
          {
            key: `entry:${entry.id}`,
            sessionId: state.session.id,
            kind: entry.type === "compaction" ? "session.compacted" : "session.branch_summary",
            occurredAt: at,
            summary:
              entry.type === "compaction"
                ? "The model context was compacted; original captured events remain separate."
                : "A branch summary was recorded; branches are not a single executed sequence.",
            evidence: sanitizeHistory(entry.summary).text,
            source: "lifecycle",
            indexable: false,
          },
        ];
      } else if (entry.type === "custom_message") {
        events = normalizeMessage(
          state.session,
          {
            role: "custom",
            customType: entry.customType,
            content: entry.content,
            details: entry.details,
            display: entry.display,
            timestamp: at,
          },
          this.#clock(),
          entry.parentId ?? undefined,
        );
      }
      for (const event of events) {
        event.entryId = entry.id;
        event.parentEntryId = entry.parentId ?? undefined;
        state.store.append(event);
        state.store.linkEntry(state.session.id, event.key, entry.id, entry.parentId ?? undefined);
      }
      state.recovered.add(entry.id);
    }
  }

  #sync(state: Recording): void {
    if (!state.indexer || state.sync || state.closed) return;
    state.indexer.seal(state.session.id);
    state.syncController = new AbortController();
    state.sync = state.indexer
      .flush(state.syncController.signal)
      .catch((error) => this.#warn(state.context, error))
      .finally(() => {
        state.sync = undefined;
        state.syncController = undefined;
      });
  }

  async start(ctx: ExtensionContext): Promise<void> {
    const id = ctx.sessionManager.getSessionId();
    const agent = ctx.agent?.id ?? "main";
    const previous = this.#activeSessions.get(agent);
    if (previous && previous !== id) {
      const old = await this.#states.get(previous);
      if (old && !old.closed) {
        clearInterval(old.timer);
        await old.observer?.stop();
        await this.#queues.get(previous);
        this.#sync(old);
        old.closed = true;
        old.args.clear();
      }
    }
    this.#activeSessions.set(agent, id);
    this.#stopped.delete(id);
    const resumed = await this.#states.get(id);
    if (resumed?.closed) {
      await resumed.sync;
      this.#states.delete(id);
      this.#queues.delete(id);
    }
    return this.#enqueue(ctx, async (state) => {
      await this.#recover(state, ctx);
      state.store.purge();
      if (!state.timer) {
        state.timer = setInterval(() => {
          void this.#enqueue(ctx, (recording) => {
            this.#append(
              recording,
              normalizeJobs(recording.session, ctx.getAsyncJobSnapshot(), this.#clock(), ctx.sessionManager.getLeafId() ?? undefined),
            );
            recording.store.purge();
          });
        }, 5_000);
        state.timer.unref();
        await state.observer?.start();
      }
      state.store.append({
        key: `recorder.start:${this.#clock()}`,
        sessionId: state.session.id,
        kind: "capture.started",
        occurredAt: this.#clock(),
        summary:
          "Local 30-day activity capture is active; workspace observations cover only configured roots. Background status is recorded only when exposed by the host.",
        source: "lifecycle",
        indexable: false,
      });
      this.#sync(state);
    });
  }

  toolStart(ctx: ExtensionContext, event: { toolCallId: string; toolName: string; args: unknown }): Promise<void> {
    const at = this.#clock();
    const branch = ctx.sessionManager.getLeafId() ?? undefined;
    return this.#enqueue(ctx, (state) => {
      state.args.set(JSON.stringify([event.toolCallId, event.toolName]), event.args);
      this.#append(state, normalizeToolStart(state.session, event, at, branch));
    });
  }

  toolEnd(ctx: ExtensionContext, event: { toolCallId: string; toolName: string; result: unknown; isError: boolean }): Promise<void> {
    const at = this.#clock();
    const branch = ctx.sessionManager.getLeafId() ?? undefined;
    const artifactsDir = ctx.sessionManager.getArtifactsDir();
    return this.#enqueue(ctx, async (state) => {
      const key = JSON.stringify([event.toolCallId, event.toolName]);
      const args = state.args.get(key);
      const events = normalizeToolEnd(state.session, { ...event, args }, at, branch);
      state.args.delete(key);
      const privateRead =
        event.toolName === "read" &&
        args !== null &&
        typeof args === "object" &&
        "path" in args &&
        typeof args.path === "string" &&
        isSensitivePath(args.path);
      const artifact = privateRead
        ? { text: "", unavailable: false, truncated: false, redacted: true }
        : await readHistoryArtifacts(event.result, artifactsDir);
      if (events[0] && (artifact.text || artifact.unavailable)) {
        events[0].evidence = `${events[0].evidence ?? ""}\n${artifact.text}`;
        events[0].unavailable ||= artifact.unavailable;
        events[0].truncated ||= artifact.truncated;
        events[0].redacted ||= artifact.redacted;
      }
      this.#append(state, events);
      for (const captured of events) {
        if (captured.path && captured.outcome === "completed" && captured.kind !== "file.deleted" && captured.kind.startsWith("file."))
          await state.observer?.rememberPresentFile(captured.path);
      }
      this.#append(state, normalizeJobs(state.session, ctx.getAsyncJobSnapshot(), at, branch));
    });
  }

  message(ctx: ExtensionContext, message: unknown): Promise<void> {
    const at = this.#clock();
    const branch = ctx.sessionManager.getLeafId() ?? undefined;
    return this.#enqueue(ctx, (state) => {
      this.#append(state, normalizeMessage(state.session, message, at, branch));
      this.#append(state, normalizeJobs(state.session, ctx.getAsyncJobSnapshot(), at, branch));
    });
  }

  lifecycle(ctx: ExtensionContext, kind: string, evidence: unknown, entryId?: string): Promise<void> {
    const at = this.#clock();
    const branch = ctx.sessionManager.getLeafId() ?? undefined;
    return this.#enqueue(ctx, (state) => {
      const clean = sanitizeHistory(evidence);
      state.store.append({
        key: entryId ? `entry:${entryId}` : `${kind}:${at}:${historyId(clean.text)}`,
        sessionId: state.session.id,
        kind,
        occurredAt: at,
        summary: kind.replaceAll(".", " "),
        evidence: clean.text,
        source: "lifecycle",
        branchId: branch,
        entryId,
        redacted: clean.redacted,
        truncated: clean.truncated,
        indexable: false,
      });
    });
  }

  settle(ctx: ExtensionContext): Promise<void> {
    return this.#enqueue(ctx, async (state) => {
      await this.#recover(state, ctx);
      this.#append(
        state,
        normalizeJobs(state.session, ctx.getAsyncJobSnapshot(), this.#clock(), ctx.sessionManager.getLeafId() ?? undefined),
      );
      await state.observer?.scan();
      state.store.purge();
      this.#sync(state);
    });
  }

  async stop(ctx: ExtensionContext): Promise<void> {
    await this.settle(ctx);
    await this.#close();
  }

  /** Settings changes must not initiate uploads with the old consent. Abort/drain first, then load the saved settings. */
  async restart(ctx: ExtensionContext): Promise<void> {
    await this.#close();
    this.#states.clear();
    this.#queues.clear();
    this.#errors.clear();
    this.#activeSessions.clear();
    this.#stopped.clear();
    await this.start(ctx);
  }

  async #close(): Promise<void> {
    const states = await Promise.all(this.#states.values());
    for (const state of states) {
      if (!state) continue;
      clearInterval(state.timer);
      await state.observer?.stop();
      state.syncController?.abort();
      await state.sync;
      await this.#queues.get(state.session.id);
      state.closed = true;
      state.args.clear();
      this.#stopped.add(state.session.id);
    }
    for (const store of this.#stores.values()) store.close();
    this.#stores.clear();
  }

  async search(ctx: ExtensionContext, query: string): Promise<LocalRecall | null> {
    const state = await this.#state(ctx);
    if (!state || state.closed) return null;
    await this.#queues.get(state.session.id);
    const page = state.store.query({ workspaceId: state.session.workspaceId, query, limit: 8 });
    return { text: this.#report(state, page), matches: page.events.length };
  }

  async expand(ctx: ExtensionContext, memories: Memory[]): Promise<string> {
    const sources = [...new Set(memories.flatMap((memory) => (memory.source?.startsWith("mcpbytes-history://") ? [memory.source] : [])))];
    if (!sources.length) return "";
    const state = await this.#state(ctx);
    const parts: string[] = [];
    for (const source of sources) {
      const events = state && !state.closed ? state.store.resolveReference(source, state.session.workspaceId) : undefined;
      if (!events?.length) {
        parts.push(
          `Local evidence unavailable for ${source}: it may belong to another device/workspace, have expired, or local capture may be off. The cloud text is a summary, not the raw record.`,
        );
      } else {
        parts.push(
          this.#report(state!, {
            events: events
              .slice()
              .sort((a, b) => b.occurredAt - a.occurredAt || b.seq - a.seq)
              .slice(0, 8),
            cutoff: this.#clock() - HISTORY_RETENTION_MS,
          }),
        );
      }
    }
    const context = evidenceSlice(parts.join("\n\n"), 0);
    return (
      context.text +
      (context.nextOffset !== undefined ? "\n[Context truncated; retrieve individual event evidence with memory_history.]" : "")
    );
  }

  async guidance(ctx: ExtensionContext): Promise<string> {
    const state = await this.#state(ctx);
    if (!state || state.closed) return "";
    return `# Local activity history\nUse ${HISTORY_TOOL} for evidence of what happened in this workspace during the last 30 days: date/path/session queries and paged event evidence. ${DATA_WARNING} Cloud summaries only have raw evidence on their originating device. Workspace ID: ${state.session.workspaceId}.`;
  }

  async inspect(
    ctx: ExtensionContext,
    input: {
      mode: "timeline" | "search" | "evidence" | "status";
      query?: string;
      workspace?: string;
      session_id?: string;
      since?: string;
      until?: string;
      path?: string;
      outcome?: "requested" | "started" | "completed" | "failed" | "canceled" | "unknown" | "observed";
      cursor?: string;
      limit?: number;
      event_id?: string;
      offset?: number;
    },
  ): Promise<string> {
    const state = await this.#state(ctx);
    if (!state || state.closed)
      throw new Error(
        this.#errors.get(ctx.sessionManager.getSessionId()) ??
          "Local activity history is off. Run /mcpbytes-history setup; no API key is required for local capture.",
      );
    await this.#queues.get(state.session.id);
    const workspace = input.workspace ? workspaceId(resolve(state.session.cwd, input.workspace)) : state.session.workspaceId;
    if (input.mode === "status") {
      const status = state.store.status(workspace);
      const roots = status.roots.slice(0, 10).map((root) => ({
        ...root,
        root: evidenceSlice(root.root, 0, 500).text,
        error: root.error ? evidenceSlice(root.error, 0, 500).text : undefined,
      }));
      const gaps = status.gaps
        .slice(0, 10)
        .map((gap) => ({ event_id: gap.id, at: new Date(gap.occurredAt).toISOString(), summary: evidenceSlice(gap.summary, 0, 500).text }));
      return `${DATA_WARNING}\n${JSON.stringify({ ...status, roots, gaps, coverage_truncated: status.roots.length > roots.length || status.gaps.length > gaps.length, workspace_id: workspace, retention_days: 30, cloud_index: !!state.indexer, cloud_error: state.indexer?.lastError, observer_exclusions: state.observer?.exclusions ?? [], capture_error: this.#errors.get(state.session.id) }, null, 2)}`;
    }
    if (input.mode === "evidence") {
      if (!input.event_id) throw new Error("event_id is required for evidence retrieval.");
      const event = state.store.get(input.event_id, workspace);
      if (!event) throw new Error("That event is unavailable in this workspace or has expired.");
      const slice = evidenceSlice(event.evidence ?? event.summary, input.offset ?? 0);
      return `${DATA_WARNING}\n${JSON.stringify({ event_id: event.id, at: new Date(event.occurredAt).toISOString(), observed_at: new Date(event.observedAt).toISOString(), kind: event.kind, outcome: event.outcome, redacted: event.redacted, truncated: event.truncated, evidence_unavailable: event.unavailable, offset: input.offset ?? 0, ...slice }, null, 2)}`;
    }
    const from = input.since === undefined ? undefined : Date.parse(input.since);
    const to = input.until === undefined ? undefined : Date.parse(input.until);
    if (
      (from !== undefined && !Number.isFinite(from)) ||
      (to !== undefined && !Number.isFinite(to)) ||
      (from !== undefined && to !== undefined && from > to)
    )
      throw new Error("Use valid ISO timestamps with since no later than until.");
    if (input.mode === "search" && !input.query?.trim()) throw new Error("A non-empty query is required for search.");
    const path = input.path
      ? /^[a-z][a-z0-9+.-]*:\/\//i.test(input.path)
        ? input.path
        : historyPath(input.path, input.workspace ? resolve(state.session.cwd, input.workspace) : state.session.cwd)
      : undefined;
    return this.#report(
      state,
      state.store.query({
        workspaceId: workspace,
        sessionId: input.session_id,
        from,
        to,
        path,
        outcome: input.outcome,
        query: input.query,
        cursor: input.cursor,
        limit: input.limit ?? 20,
      }),
    );
  }
}

export function registerActivityHistory(
  pi: ExtensionAPI,
  configuration: (ctx: ExtensionContext) => Promise<Configuration>,
  settingsChanged: () => void,
  clock?: () => number,
): ActivityHistory {
  const history = new ActivityHistory(pi, configuration, clock);
  const z = pi.zod;
  const params = z.object({
    mode: z.enum(["timeline", "search", "evidence", "status"]).default("timeline"),
    query: z.string().max(1024).optional(),
    workspace: z.string().optional().describe("Local workspace directory; defaults to the current workspace"),
    session_id: z.string().optional(),
    since: z.string().optional().describe("Inclusive original-event timestamp, ISO 8601"),
    until: z.string().optional().describe("Inclusive original-event timestamp, ISO 8601"),
    path: z.string().optional().describe("Affected path to filter; matches deletions and rename sources"),
    outcome: z.enum(["requested", "started", "completed", "failed", "canceled", "unknown", "observed"]).optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    event_id: z.string().optional().describe("An event returned by timeline/search, for evidence retrieval"),
    offset: z.number().int().min(0).optional().describe("Evidence byte offset; use nextOffset to continue"),
  });
  pi.on("session_start", (_event, ctx) => history.start(ctx));
  pi.on("session_switch", (event, ctx) => history.start(ctx).then(() => history.lifecycle(ctx, "session.switched", event)));
  pi.on("session_branch", (event, ctx) => history.start(ctx).then(() => history.lifecycle(ctx, "session.branched", event)));
  pi.on("session_tree", (event, ctx) => history.lifecycle(ctx, "session.tree_navigation", event));
  pi.on("session_compact", (event, ctx) =>
    history.lifecycle(ctx, "session.compacted", event.compactionEntry.summary, event.compactionEntry.id),
  );
  pi.on("tool_execution_start", (event, ctx) => history.toolStart(ctx, event));
  pi.on("tool_execution_end", (event, ctx) => history.toolEnd(ctx, event));
  pi.on("message_end", (event, ctx) => history.message(ctx, event.message));
  pi.on("agent_end", (event, ctx) => (event.willContinue ? undefined : history.settle(ctx)));
  pi.on("session_shutdown", (_event, ctx) => history.stop(ctx));
  pi.registerTool({
    name: HISTORY_TOOL,
    label: "Read activity history",
    description:
      "Read this device's opt-in, last-30-days activity evidence. Search by words/date/path/session, retrieve a timeline or paged event evidence, or inspect capture coverage. Free and local. Observed deletion is not file restoration or proof of current absence; unavailable evidence stays unknown.",
    parameters: params,
    loadMode: "essential",
    approval: "read",
    async execute(_toolCallId, input: zod.infer<typeof params>, _signal, _onUpdate, ctx) {
      try {
        return { content: [{ type: "text", text: await history.inspect(ctx, input) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: sanitizeHistory(error instanceof Error ? error.message : String(error), 1_000).text }],
          isError: true,
        };
      }
    },
  });
  pi.registerCommand("mcpbytes-history", {
    description: "Guided `setup`, local capture status, or `search <words>`",
    handler: async (args, ctx) => {
      const [command, ...words] = args.trim().split(/\s+/);
      let text: string;
      try {
        if (command === "setup") {
          const { settings } = await configuration(ctx);
          const saved = await setupHistory(ctx, settings, z);
          if (!saved) text = "History setup canceled. No settings changed.";
          else {
            const savedPath = saved.path.replaceAll("\\", "/");
            settingsChanged();
            try {
              await history.restart(ctx);
              if (saved.enabled) {
                await history.inspect(ctx, { mode: "status" });
                text = `History is active in this session. Watching: ${saved.roots.length ? saved.roots.join(", ") : "tool activity only"}. Cloud indexing: ${saved.cloudIndex ? "on (uses MCPBytes credits)" : "off"}.\nSaved project settings to \`${savedPath}\`. Other running sessions must reload.\nUse /mcpbytes-history to inspect coverage, or /mcpbytes-history search <words>.`;
              } else
                text = `Activity history and its cloud indexing are off in this session. Curated Memory is unchanged; existing activity records keep their original expiry.\nSaved project settings to \`${savedPath}\`. Other running sessions must reload.`;
            } catch (error) {
              text = `Settings saved to \`${savedPath}\`, but capture could not start: ${sanitizeHistory(error instanceof Error ? error.message : String(error), 1_000).text}\nRun /mcpbytes-history to inspect the problem.`;
            }
          }
          pi.sendMessage(
            { customType: "mcpbytes-history-status", content: text, display: true, attribution: "user" },
            { triggerTurn: false },
          );
          return;
        }
        text = await history.inspect(ctx, command === "search" ? { mode: "search", query: words.join(" ") } : { mode: "status" });
      } catch (error) {
        text = sanitizeHistory(error instanceof Error ? error.message : String(error), 1_000).text;
      }
      pi.sendMessage({ customType: "mcpbytes-history-status", content: text, display: true, attribution: "user" }, { triggerTurn: false });
    },
  });
  return history;
}
