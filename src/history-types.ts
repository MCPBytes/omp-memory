import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { RememberRequest } from "./api.ts";

export const HISTORY_DAYS = 30;
export const HISTORY_RETENTION_MS = HISTORY_DAYS * 86_400_000;
export const HISTORY_TOOL = "memory_history";
export const HISTORY_EVIDENCE_BYTES = 262_144;
export const HISTORY_QUERY_BYTES = 24_000;

export type HistoryOutcome = "requested" | "started" | "completed" | "failed" | "canceled" | "unknown" | "observed";
export type HistorySource = "message" | "tool" | "filesystem" | "lifecycle" | "job" | "recovery";

export interface HistorySession {
  id: string;
  workspaceId: string;
  cwd: string;
  agentId: string;
  agentKind: "main" | "sub";
  parentAgentId?: string;
  parentSessionFile?: string;
  sessionFile?: string;
  startedAt: number;
  cloudSpace: string;
}

export interface HistoryEventInput {
  /** Unique within a session and stable when the same persisted event is recovered. */
  key: string;
  sessionId: string;
  kind: string;
  occurredAt: number;
  observedAt?: number;
  summary: string;
  evidence?: string;
  source: HistorySource;
  outcome?: HistoryOutcome;
  toolCallId?: string;
  toolName?: string;
  path?: string;
  fromPath?: string;
  branchId?: string;
  entryId?: string;
  parentEntryId?: string;
  redacted?: boolean;
  truncated?: boolean;
  unavailable?: boolean;
  /** False for recalled history, private data, and recorder bookkeeping. */
  indexable?: boolean;
}

export interface HistoryEvent extends HistoryEventInput {
  id: string;
  seq: number;
  workspaceId: string;
  observedAt: number;
  expiresAt: number;
}

export interface HistoryQuery {
  workspaceId: string;
  sessionId?: string;
  from?: number;
  to?: number;
  path?: string;
  outcome?: HistoryOutcome;
  query?: string;
  cursor?: string;
  limit?: number;
  evidence?: boolean;
}

export interface HistoryPage {
  events: HistoryEvent[];
  nextCursor?: string;
  cutoff: number;
}

export interface FileObservation {
  path: string;
  kind: "file" | "directory" | "symlink";
  lastSeenAt: number;
}

export interface ObservedRoot {
  root: string;
  lastScanAt: number;
  error?: string;
}

export interface HistoryOutbox {
  id: string;
  sessionId: string;
  destination: string;
  eventIds: string[];
  payload: RememberRequest;
  expiresAt: number;
  status: "pending" | "sending" | "accepted" | "proposed";
  memoryId?: string;
  error?: string;
}

export interface HistoryStatus {
  events: number;
  sessions: number;
  pendingUploads: number;
  proposedUploads: number;
  acceptedUploads: number;
  uploadError?: string;
  roots: ObservedRoot[];
  gaps: HistoryEvent[];
}

/** Storage boundary shared by capture, indexing, and the metadata observer. */
export interface HistoryStorage {
  readonly deviceId: string;
  registerSession(session: HistorySession): void;
  session(id: string): HistorySession | undefined;
  append(input: HistoryEventInput): HistoryEvent | null;
  linkEntry(sessionId: string, key: string, entryId: string, parentEntryId?: string): void;
  query(input: HistoryQuery): HistoryPage;
  get(id: string, workspaceId: string): HistoryEvent | undefined;
  status(workspaceId: string): HistoryStatus;
  inventory(workspaceId: string, root: string): FileObservation[];
  rememberFile(workspaceId: string, root: string, entry: FileObservation): void;
  replaceInventory(workspaceId: string, root: string, entries: FileObservation[], at: number): void;
  recordRoot(workspaceId: string, root: string, at: number, error?: string): void;
  /** First cloud destination wins; a resumed session cannot leak prior activity to another account. */
  bindDestination(sessionId: string, destination: string): boolean;
  unindexedEvents(sessionId: string, destination: string): HistoryEvent[];
  enqueue(item: HistoryOutbox): void;
  claimUpload(destination: string): HistoryOutbox | undefined;
  finishUpload(id: string, status: "accepted" | "proposed", memoryId?: string): void;
  failUpload(id: string, error: string, retryAt: number): void;
  resolveReference(source: string, workspaceId: string): HistoryEvent[] | undefined;
  purge(): void;
  close(): void;
}

export function historyId(...parts: (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40);
}

/** Local paths never become fetchable cloud references. Windows path identity is case-insensitive. */
export function historyPath(path: string, cwd?: string): string {
  const normalized = resolve(cwd ?? process.cwd(), path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export const workspaceId = (cwd: string): string => historyId("workspace", historyPath(cwd));
