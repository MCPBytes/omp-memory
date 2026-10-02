/**
 * Optional cloud index of local history: deterministic compact episodes in an existing MCPBytes space. Each segment is
 * sealed once with its final payload, original expiry and request key, so a retry after a lost response or a restart
 * replays the exact same write. No model is called; text is only what was recorded.
 */
import { type MemoryApi, MemoryApiError, describeError } from "./api.ts";
import { historyReference, UPLOAD_MIN_LIFETIME_MS } from "./history-store.ts";
import { HISTORY_TOOL, historyId, type HistoryEvent, type HistoryStorage } from "./history-types.ts";

/** Server text limit is 8 KiB; leave room for multibyte boundaries. */
const SEGMENT_BYTES = 8_000;
const LINE_SUMMARY_CHARS = 600;
const MAX_UPLOADS_PER_FLUSH = 20;
const RETRY_MS = 5 * 60_000;
const REFUSED_RETRY_MS = 60 * 60_000;
/** Recalling memory is not new activity; feeding it back would index history about history. */
const RECURSIVE_TOOLS: Record<string, true> = { [HISTORY_TOOL]: true, memory_recall: true };

export interface IndexerOptions {
  /** Fingerprint of the API key/account; a different destination never receives another's segments. */
  destination: string;
  space: string;
}

/** Explicit requests, decisions and observed results; launches and requests are covered by their outcomes. */
export function indexable(event: HistoryEvent): boolean {
  if (event.indexable === false || event.unavailable) return false;
  if (event.toolName && RECURSIVE_TOOLS[event.toolName]) return false;
  if (event.toolName && (event.outcome === "requested" || event.outcome === "started")) return false;
  return event.summary.trim().length > 0;
}

function line(event: HistoryEvent): string {
  const parts = [new Date(event.occurredAt).toISOString(), event.kind];
  if (event.outcome) parts.push(`[${event.outcome}]`);
  if (event.toolName) parts.push(event.toolName);
  if (event.fromPath && event.path) parts.push(`${event.fromPath} -> ${event.path}`);
  else if (event.path) parts.push(event.path);
  const summary = event.summary.replace(/\s+/g, " ").trim();
  const clipped = summary.length > LINE_SUMMARY_CHARS ? `${summary.slice(0, LINE_SUMMARY_CHARS)} …` : summary;
  return `- ${parts.join(" ")}: ${clipped}${event.redacted ? " (redacted)" : ""}`;
}

export class HistoryIndexer {
  /** Last upload failure or refusal, for status surfaces; cleared by a successful upload. */
  lastError: string | undefined;
  private readonly store: HistoryStorage;
  private readonly api: MemoryApi;
  private readonly options: IndexerOptions;
  private readonly clock: () => number;

  constructor(store: HistoryStorage, api: MemoryApi, options: IndexerOptions, clock: () => number = Date.now) {
    this.store = store;
    this.api = api;
    this.options = options;
    this.clock = clock;
  }

  /** Groups the session's not-yet-indexed meaningful events into immutable segments and persists them. */
  seal(sessionId: string): void {
    const { destination, space } = this.options;
    if (!this.store.bindDestination(sessionId, destination)) {
      // A session resumed under another key/account: none of its activity goes to the new destination.
      this.lastError =
        "destination_changed: this session was indexed for another MCPBytes account or key; start a new session to index new activity (local history still records it)";
      return;
    }
    const selected = this.store.unindexedEvents(sessionId, destination).filter(indexable);
    const header = `Agent activity (session ${sessionId.slice(0, 12)}), observed locally:`;
    let group: HistoryEvent[] = [];
    let text = header;
    const emit = (): void => {
      if (group.length === 0) return;
      const eventIds = group.map((e) => e.id);
      const segment = historyId("segment", this.store.deviceId, sessionId, ...eventIds);
      // The oldest event fixes the deadline; summarizing cannot give expired evidence a fresh life.
      const expiresAt = Math.min(...group.map((e) => e.expiresAt));
      this.store.enqueue({
        id: segment,
        sessionId,
        destination,
        eventIds,
        expiresAt,
        status: "pending",
        payload: {
          space,
          kind: "episode",
          text,
          source: historyReference(this.store.deviceId, sessionId, segment),
          expires_at: new Date(expiresAt).toISOString(),
          request_key: historyId("history-index", destination, segment),
        },
      });
      group = [];
      text = header;
    };
    for (const event of selected) {
      const next = `${text}\n${line(event)}`;
      if (group.length > 0 && Buffer.byteLength(next) > SEGMENT_BYTES) {
        emit();
        text = `${header}\n${line(event)}`;
      } else {
        text = next;
      }
      group.push(event);
      // At most 4 UTF-8 bytes per UTF-16 unit, so this always fits.
      if (Buffer.byteLength(text) > SEGMENT_BYTES) text = `${text.slice(0, SEGMENT_BYTES / 4 - 2)} …`;
    }
    emit();
  }

  /** Sends due segments once each; stops at the first outage or account refusal and never loops on one item. */
  async flush(signal?: AbortSignal): Promise<void> {
    const seen = new Set<string>();
    for (let sent = 0; sent < MAX_UPLOADS_PER_FLUSH && !signal?.aborted; sent++) {
      const item = this.store.claimUpload(this.options.destination);
      if (!item) return;
      if (seen.has(item.id)) {
        this.store.failUpload(item.id, item.error ?? "deferred", this.clock());
        return;
      }
      seen.add(item.id);
      if (item.expiresAt - this.clock() <= UPLOAD_MIN_LIFETIME_MS) {
        this.store.failUpload(item.id, "expiring: kept local until it expires", item.expiresAt);
        continue;
      }
      try {
        const receipt = await this.api.remember(item.payload, signal);
        this.store.finishUpload(item.id, receipt.status === "proposed" ? "proposed" : "accepted", receipt.memory_id);
        this.lastError = undefined;
      } catch (error) {
        const message = describeError(error);
        this.lastError = message;
        const now = this.clock();
        if (signal?.aborted) {
          // Ambiguous: the server may have accepted it; the same request key replays it next time.
          this.store.failUpload(item.id, message, now);
          return;
        }
        if (
          error instanceof MemoryApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![401, 403, 408, 402, 429].includes(error.status)
        ) {
          // This payload itself is refused (invalid, sensitive, expiry): never resent; it stays local until expiry.
          this.store.failUpload(item.id, `refused: ${message}`, item.expiresAt);
          continue;
        }
        const refused = error instanceof MemoryApiError && [401, 402, 403, 429].includes(error.status);
        const retryAfter = error instanceof MemoryApiError ? error.retryAfterMs : undefined;
        const wait = retryAfter !== undefined && retryAfter > 0 ? retryAfter : refused ? REFUSED_RETRY_MS : RETRY_MS;
        this.store.failUpload(item.id, refused ? `blocked: ${message}` : message, now + wait);
        return;
      }
    }
  }
}
