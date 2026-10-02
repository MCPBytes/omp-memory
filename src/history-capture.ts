import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RECALL_TOOL } from "./core.ts";
import { isSensitivePath, sanitizeHistory, truncateUtf8 } from "./history-privacy.ts";
import {
  HISTORY_EVIDENCE_BYTES,
  HISTORY_TOOL,
  type HistoryEventInput,
  type HistoryOutcome,
  type HistorySession,
  type HistorySource,
  historyId,
  historyPath,
} from "./history-types.ts";

/** Bytes of a one-line summary; evidence carries the full sanitized text. */
const SUMMARY_BYTES = 320;
/** Upper bound on artifact references followed for one tool result. */
const MAX_ARTIFACTS = 8;
const ASYNC_RESULT_TYPE = "async-result";

/**
 * Tools whose output is recalled history or memory. Their results stay local and are never fed back into
 * the automatic cloud index as new activity.
 */
const RECALL_TOOLS = new RegExp(`(?:^|_)(?:${HISTORY_TOOL}|${RECALL_TOOL}|memory_(?:search|get|list|resolve|due|status))$`);
/** Displayed custom messages carrying recalled memory/history or recorder status; kept local only. */
const RECALL_MESSAGES = /^mcpbytes-|memory|history/i;

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[image omitted]");
  }
  return parts.join("\n");
}

function timeOf(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Stored path identity: local paths are normalized; internal URLs (`local://…`) are kept verbatim. */
function pathOf(session: HistorySession, path: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path) ? path : historyPath(path, session.cwd);
}

const oneLine = (text: string): string => truncateUtf8(text.replace(/\s+/g, " ").trim(), SUMMARY_BYTES).text;

interface Draft {
  key: string;
  kind: string;
  occurredAt: number;
  summary: string;
  source: HistorySource;
  outcome?: HistoryOutcome;
  evidence?: unknown;
  toolCallId?: string;
  toolName?: string;
  path?: string;
  fromPath?: string;
  indexable?: boolean;
  /** Set when evidence was already reduced by policy (e.g. a sensitive file read). */
  redacted?: boolean;
}

/** Applies sanitization to every caller-visible string and attaches session identity. */
function event(session: HistorySession, draft: Draft, branchId: string | undefined, observedAt?: number): HistoryEventInput {
  const summary = sanitizeHistory(draft.summary, SUMMARY_BYTES * 2);
  const out: HistoryEventInput = {
    key: draft.key,
    sessionId: session.id,
    kind: draft.kind,
    occurredAt: draft.occurredAt,
    summary: oneLine(summary.text),
    source: draft.source,
  };
  let redacted = summary.redacted || draft.redacted === true;
  if (draft.evidence !== undefined) {
    const evidence = sanitizeHistory(draft.evidence);
    if (evidence.text) out.evidence = evidence.text;
    redacted ||= evidence.redacted;
    if (evidence.truncated) out.truncated = true;
  }
  if (redacted) out.redacted = true;
  if (observedAt !== undefined) out.observedAt = observedAt;
  if (draft.outcome) out.outcome = draft.outcome;
  if (draft.toolCallId) out.toolCallId = draft.toolCallId;
  if (draft.toolName) out.toolName = draft.toolName;
  if (draft.path) out.path = sanitizeHistory(draft.path).text;
  if (draft.fromPath) out.fromPath = sanitizeHistory(draft.fromPath).text;
  if (branchId) out.branchId = branchId;
  if (draft.indexable === false) out.indexable = false;
  return out;
}

const toolKey = (toolName: string, toolCallId: string, phase: string): string => `tool:${toolName}:${toolCallId}:${phase}`;

function readPath(toolName: string, args: unknown): string | undefined {
  if (toolName !== "read" || !isRecord(args)) return undefined;
  return typeof args.path === "string" ? args.path : undefined;
}

/** A tool-start observation: the host began executing a call. */
export function normalizeToolStart(
  session: HistorySession,
  event_: { toolCallId: string; toolName: string; args: unknown },
  at: number,
  branchId?: string,
): HistoryEventInput[] {
  const { toolCallId, toolName, args } = event_;
  return [
    event(
      session,
      {
        key: toolKey(toolName, toolCallId, "start"),
        kind: "tool.started",
        occurredAt: at,
        summary: `${toolName} started: ${sanitizeHistory(args, SUMMARY_BYTES).text}`,
        source: "tool",
        outcome: "started",
        evidence: { args },
        toolCallId,
        toolName,
        indexable: RECALL_TOOLS.test(toolName) ? false : undefined,
      },
      branchId,
    ),
  ];
}

interface ToolVerdict {
  kind: string;
  outcome: HistoryOutcome;
  note: string;
}

/**
 * What a result actually establishes. A non-error result means the tool reported success; bash reports a
 * nonzero exit, a timeout, cancellation, a missing exit status, or a background launch distinctly.
 */
function toolVerdict(toolName: string, details: Fields, isError: boolean, text: string): ToolVerdict {
  const async = isRecord(details.async) ? details.async : undefined;
  if (async?.state === "running") {
    const job = typeof async.jobId === "string" ? ` ${async.jobId}` : "";
    return {
      kind: "job.launched",
      outcome: "started",
      note: `launched background job${job}; completion not observed by this result`,
    };
  }
  if (async?.state === "failed") return { kind: "tool.failed", outcome: "failed", note: "background job failed" };
  if (async?.state === "cancelled" || async?.state === "canceled") {
    return { kind: "tool.canceled", outcome: "canceled", note: "canceled" };
  }
  if (details.timedOut === true) return { kind: "tool.failed", outcome: "failed", note: "timed out" };
  if (typeof details.exitCode === "number" && details.exitCode !== 0) {
    return { kind: "tool.failed", outcome: "failed", note: `exited with code ${details.exitCode}` };
  }
  const head = text.slice(0, 400);
  const tail = text.slice(-400);
  if (/^\[Command (?:cancelled|aborted)\]/i.test(head) || /\[Command (?:cancelled|aborted)\]\s*$/i.test(tail)) {
    return { kind: "tool.canceled", outcome: "canceled", note: "canceled" };
  }
  if (/Command failed: missing exit status\s*$/i.test(tail)) {
    return { kind: "tool.unknown", outcome: "unknown", note: "final exit status was not reported" };
  }
  if (async?.state === "completed") return { kind: "tool.completed", outcome: "completed", note: "background job completed" };
  if (!isError) return { kind: "tool.completed", outcome: "completed", note: "reported success" };
  if (/^Command aborted|\b(?:aborted|cancell?ed) by (?:the )?user\b/i.test(`${head}\n${tail}`)) {
    return { kind: "tool.canceled", outcome: "canceled", note: "canceled" };
  }
  return { kind: "tool.failed", outcome: "failed", note: toolName === "bash" ? "failed" : "reported an error" };
}

interface EditEntry {
  path?: string;
  op?: string;
  move?: string;
  sourcePath?: string;
  isError?: boolean;
  errorText?: string;
  diagnostics?: string;
}

/**
 * Multi-file results carry per-file success; a single-file result's outcome is the call's overall outcome.
 */
function editEntries(details: Fields, isError: boolean): EditEntry[] {
  const perFile = Array.isArray(details.perFileResults);
  const raw = perFile
    ? details.perFileResults
    : typeof details.path === "string" && ("op" in details || "diff" in details)
      ? [details]
      : [];
  if (!Array.isArray(raw)) return [];
  const entries: EditEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.path !== "string") continue;
    const diagnostics = isRecord(item.diagnostics) ? item.diagnostics : undefined;
    entries.push({
      path: item.path,
      op: typeof item.op === "string" ? item.op : undefined,
      move: typeof item.move === "string" ? item.move : undefined,
      sourcePath: typeof item.sourcePath === "string" ? item.sourcePath : undefined,
      isError: item.isError === true || (!perFile && isError),
      errorText: typeof item.errorText === "string" ? item.errorText : undefined,
      diagnostics: typeof diagnostics?.summary === "string" ? diagnostics.summary : undefined,
    });
  }
  return entries;
}

const FILE_KIND: Record<string, [done: string, failed: string, verb: string]> = {
  delete: ["file.deleted", "file.delete_failed", "delete"],
  create: ["file.created", "file.create_failed", "create"],
  update: ["file.updated", "file.update_failed", "update"],
  move: ["file.moved", "file.move_failed", "move"],
};

/**
 * Per-file outcomes reported by the native edit tool. Each file keeps its own outcome; a failed delete is
 * an attempt, never a disappearance. A move is a rename, not a deletion of its source.
 */
function fileEvents(
  session: HistorySession,
  toolName: string,
  toolCallId: string,
  details: Fields,
  at: number,
  source: HistorySource,
  indexable: boolean,
  isError: boolean,
): Draft[] {
  const drafts: Draft[] = [];
  editEntries(details, isError).forEach((entry, index) => {
    const moved = entry.move !== undefined && entry.sourcePath !== undefined;
    const op = moved ? "move" : entry.op && Object.hasOwn(FILE_KIND, entry.op) ? entry.op : "update";
    const [done, failed, verb] = FILE_KIND[op]!;
    const path = entry.move ?? entry.path!;
    const where = moved ? `${entry.sourcePath} -> ${path}` : path;
    const summary = entry.isError
      ? `${toolName} attempted to ${verb} ${where} but that file operation failed${entry.errorText ? `: ${entry.errorText}` : ""}`
      : `${toolName} reported ${verb} of ${where} succeeded`;
    const evidence = [entry.errorText, entry.diagnostics].filter(Boolean).join("\n");
    drafts.push({
      key: `file:${toolName}:${toolCallId}:${index}`,
      kind: entry.isError ? failed : done,
      occurredAt: at,
      summary,
      source,
      outcome: entry.isError ? "failed" : "completed",
      evidence: evidence || undefined,
      toolCallId,
      toolName,
      path: pathOf(session, path),
      fromPath: moved ? pathOf(session, entry.sourcePath!) : undefined,
      indexable: indexable ? undefined : false,
    });
  });
  return drafts;
}

function toolEnd(
  session: HistorySession,
  end: { toolCallId: string; toolName: string; args?: unknown; result: unknown; isError: boolean },
  at: number,
  source: HistorySource,
  branchId: string | undefined,
  observedAt?: number,
): HistoryEventInput[] {
  const { toolCallId, toolName, args, isError } = end;
  const result = isRecord(end.result) ? end.result : {};
  const details = isRecord(result.details) ? result.details : {};
  let text = textOf(result.content);
  if (!text && typeof end.result === "string") text = end.result;
  const verdict = toolVerdict(toolName, details, isError, text);
  const sensitivePath = readPath(toolName, args);
  const sensitive = sensitivePath !== undefined && isSensitivePath(sensitivePath);
  const indexable = !sensitive && !RECALL_TOOLS.test(toolName);
  if (sensitive) text = `[content of sensitive file ${sensitivePath} omitted]`;

  const facts: Fields = { outcome: verdict.note };
  if (args !== undefined) facts.args = args;
  for (const key of ["exitCode", "timedOut", "wallTimeMs", "timeoutSeconds"]) {
    if (details[key] !== undefined) facts[key] = details[key];
  }
  if (isRecord(details.async)) facts.async = details.async;
  const meta = isRecord(details.meta) ? details.meta : undefined;
  if (meta?.truncation !== undefined) facts.outputTruncation = meta.truncation;
  if (meta?.artifactError !== undefined) facts.artifactError = meta.artifactError;
  const evidence = `${sanitizeHistory(facts).text}\n\n${text}`;

  const drafts: Draft[] = [
    {
      key: toolKey(toolName, toolCallId, "end"),
      kind: verdict.kind,
      occurredAt: at,
      summary: `${toolName} ${verdict.note}${text && !sensitive ? `: ${text}` : ""}`,
      source,
      outcome: verdict.outcome,
      evidence,
      toolCallId,
      toolName,
      indexable: indexable ? undefined : false,
      redacted: sensitive,
    },
  ];
  drafts.push(...fileEvents(session, toolName, toolCallId, details, at, source, indexable, isError));
  if (
    toolName === "write" &&
    !isError &&
    isRecord(args) &&
    typeof args.path === "string" &&
    !/^[a-z][a-z0-9+.-]*:\/\/|:[^\\/]+$/i.test(args.path)
  ) {
    drafts.push({
      key: `file:${toolName}:${toolCallId}:0`,
      kind: "file.written",
      occurredAt: at,
      summary: `write reported writing ${args.path}`,
      source,
      outcome: "completed",
      toolCallId,
      toolName,
      path: pathOf(session, args.path),
      indexable: indexable ? undefined : false,
    });
  }
  return drafts.map((draft) => event(session, draft, branchId, observedAt));
}

/** A tool-end observation plus any per-file outcomes the tool reported. */
export function normalizeToolEnd(
  session: HistorySession,
  end: { toolCallId: string; toolName: string; args?: unknown; result: unknown; isError: boolean },
  at: number,
  branchId?: string,
): HistoryEventInput[] {
  return toolEnd(session, end, at, "tool", branchId);
}

function shellOutcome(message: Fields): HistoryOutcome {
  if (message.cancelled === true) return "canceled";
  if (typeof message.exitCode !== "number") return "unknown";
  return message.exitCode === 0 ? "completed" : "failed";
}

/**
 * Finalized or recovered session messages. Keys depend only on persisted content, so recovery after an
 * interruption deduplicates against live capture. Hidden reasoning, system/developer prompts, synthetic
 * user turns and hidden injected context are excluded.
 */
export function normalizeMessage(session: HistorySession, message: unknown, observedAt: number, branchId?: string): HistoryEventInput[] {
  if (!isRecord(message)) return [];
  const at = timeOf(message.timestamp, observedAt);
  /**
   * Persisted timestamps identify a message; content hashes are only a fallback, because a stored copy may be
   * truncated and must still dedupe against the live capture.
   */
  const hasStamp = typeof message.timestamp === "number" || typeof message.timestamp === "string";
  const messageKey = (prefix: string, content: string) =>
    hasStamp ? `${prefix}:${String(message.timestamp)}` : `${prefix}:h:${historyId(content)}`;
  const drafts: Draft[] = [];
  switch (message.role) {
    case "user": {
      if (message.synthetic === true) return [];
      const text = textOf(message.content);
      if (!text.trim()) return [];
      drafts.push({
        key: messageKey("msg:user", text),
        kind: "message.user",
        occurredAt: at,
        summary: `User: ${text}`,
        source: "message",
        outcome: "requested",
        evidence: text,
      });
      break;
    }
    case "assistant": {
      const content = Array.isArray(message.content) ? message.content : [];
      const text = textOf(content);
      const stop = typeof message.stopReason === "string" ? message.stopReason : undefined;
      const failure =
        (stop === "error" || stop === "aborted") && typeof message.errorMessage === "string" ? `\n[${stop}: ${message.errorMessage}]` : "";
      if (text.trim() || failure) {
        drafts.push({
          key: messageKey("msg:assistant", `${text}${failure}`),
          kind: "message.assistant",
          occurredAt: at,
          summary: `Assistant: ${text || failure}`,
          source: "message",
          outcome: stop === "aborted" ? "canceled" : stop === "error" ? "failed" : "observed",
          evidence: `${text}${failure}`,
          // Narration can quote recalled history. Retain it locally, but index user goals and tool evidence instead.
          indexable: false,
        });
      }
      for (const block of content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        if (typeof block.id !== "string" || typeof block.name !== "string") continue;
        drafts.push({
          key: toolKey(block.name, block.id, "request"),
          kind: "tool.requested",
          occurredAt: at,
          summary: `Assistant requested ${block.name}: ${sanitizeHistory(block.arguments, SUMMARY_BYTES).text}`,
          source: "message",
          outcome: "requested",
          evidence: { args: block.arguments },
          toolCallId: block.id,
          toolName: block.name,
          indexable: RECALL_TOOLS.test(block.name) ? false : undefined,
        });
      }
      break;
    }
    case "toolResult": {
      if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string") return [];
      return toolEnd(
        session,
        { toolCallId: message.toolCallId, toolName: message.toolName, result: message, isError: message.isError === true },
        at,
        "recovery",
        branchId,
        observedAt,
      );
    }
    case "bashExecution":
    case "pythonExecution": {
      const code = typeof message.command === "string" ? message.command : typeof message.code === "string" ? message.code : "";
      const outcome = shellOutcome(message);
      const label = message.role === "bashExecution" ? "shell" : "python";
      const exit = typeof message.exitCode === "number" ? ` (exit ${message.exitCode})` : "";
      drafts.push({
        key: messageKey(`msg:${message.role}`, code),
        kind: `${label}.user`,
        occurredAt: at,
        summary: `User ran ${label} ${outcome}${exit}: ${code}`,
        source: "message",
        outcome,
        evidence: `${code}\n\n${typeof message.output === "string" ? message.output : ""}`,
      });
      break;
    }
    case "compactionSummary":
    case "branchSummary": {
      const summary = typeof message.summary === "string" ? message.summary : "";
      const compacted = message.role === "compactionSummary";
      drafts.push({
        key: messageKey(`msg:${message.role}`, summary),
        kind: compacted ? "session.compacted" : "session.branch_summary",
        occurredAt: at,
        summary: compacted
          ? "Context was compacted; recorded history is retained unchanged"
          : "A branch summary was recorded for an abandoned branch",
        source: "lifecycle",
        outcome: "observed",
        evidence: summary ? `[model-written summary]\n${summary}` : undefined,
        indexable: false,
      });
      break;
    }
    case "custom": {
      if (message.display !== true) return [];
      const customType = typeof message.customType === "string" ? message.customType : "custom";
      const text = textOf(message.content);
      const details = isRecord(message.details) ? message.details : {};
      if (customType === ASYNC_RESULT_TYPE && Array.isArray(details.jobs)) {
        for (const job of details.jobs) {
          if (!isRecord(job) || typeof job.jobId !== "string") continue;
          drafts.push({
            key: `job:${job.jobId}:delivered`,
            kind: "job.delivered",
            occurredAt: at,
            summary: `Background ${typeof job.type === "string" ? job.type : ""} job ${job.jobId} delivered its result; final status is not stated by the delivery`,
            source: "job",
            outcome: "unknown",
            evidence: text,
          });
        }
        break;
      }
      if (!text.trim()) return [];
      drafts.push({
        key: messageKey(`msg:custom:${customType}`, text),
        kind: "message.custom",
        occurredAt: at,
        summary: `${customType}: ${text}`,
        source: "message",
        outcome: "observed",
        evidence: text,
        indexable: RECALL_MESSAGES.test(customType) ? false : undefined,
      });
      break;
    }
    default:
      return [];
  }
  return drafts.map((draft) => event(session, draft, branchId, observedAt));
}

const JOB_OUTCOME: Record<string, [kind: string, outcome: HistoryOutcome]> = {
  running: ["job.running", "started"],
  completed: ["job.completed", "completed"],
  failed: ["job.failed", "failed"],
  cancelled: ["job.canceled", "canceled"],
};

/** Status transitions visible in `getAsyncJobSnapshot()`; each job/status pair is recorded once. */
export function normalizeJobs(session: HistorySession, snapshot: unknown, at: number, branchId?: string): HistoryEventInput[] {
  if (!isRecord(snapshot)) return [];
  const out: HistoryEventInput[] = [];
  for (const list of [snapshot.running, snapshot.recent]) {
    if (!Array.isArray(list)) continue;
    for (const job of list) {
      if (!isRecord(job) || typeof job.id !== "string" || typeof job.status !== "string") continue;
      const [kind, outcome] = JOB_OUTCOME[job.status] ?? ["job.unknown", "unknown"];
      const type = typeof job.type === "string" ? job.type : "background";
      const label = typeof job.label === "string" ? `: ${job.label}` : "";
      const occurredAt = timeOf(outcome === "started" ? job.startTime : (job.endTime ?? job.startTime), at);
      out.push(
        event(
          session,
          {
            key: `job:${job.id}:${job.status}`,
            kind,
            occurredAt,
            summary: `${type} job ${job.id} ${job.status}${label}`,
            source: "job",
            outcome,
            evidence: {
              id: job.id,
              type,
              status: job.status,
              label: job.label,
              agentId: job.agentId,
              startTime: job.startTime,
              endTime: job.endTime,
            },
          },
          branchId,
          at,
        ),
      );
    }
  }
  return out;
}

/** Artifact text retained as evidence for one tool result. */
export interface ArtifactEvidence {
  text: string;
  /** Some referenced output could not be retained (missing, binary, unreadable, or capture failed). */
  unavailable: boolean;
  /** Retained output is incomplete (byte budget or too many artifacts). */
  truncated: boolean;
  redacted: boolean;
}

/**
 * Artifact IDs from host-written result metadata only. Output text is untrusted: a command can print
 * `artifact://N` naming an unrelated artifact, so text references are never followed.
 */
function artifactIds(result: Fields): { ids: string[]; dropped: number; captureError?: unknown } {
  const ids = new Set<string>();
  const details = isRecord(result.details) ? result.details : {};
  const meta = isRecord(details.meta) ? details.meta : {};
  const limits = isRecord(meta.limits) ? meta.limits : {};
  for (const holder of [meta.truncation, limits.columnTruncated]) {
    if (!isRecord(holder)) continue;
    const id = holder.artifactId;
    if (typeof id === "string" && /^\d+$/.test(id)) ids.add(id);
  }
  const all = [...ids];
  return { ids: all.slice(0, MAX_ARTIFACTS), dropped: Math.max(0, all.length - MAX_ARTIFACTS), captureError: meta.artifactError };
}

/**
 * Follows a result's host output artifacts (`<artifactsDir>/<numericId>.<tool>.log`) before session cleanup
 * removes them. Only numeric IDs from the result's metadata are read, only regular files directly inside the
 * session artifact directory, and only text; the returned text is sanitized and bounded.
 */
export async function readHistoryArtifacts(result: unknown, artifactsDir: string | null): Promise<ArtifactEvidence> {
  if (!isRecord(result)) return { text: "", unavailable: false, truncated: false, redacted: false };
  const { ids, dropped, captureError } = artifactIds(result);
  const parts: string[] = [];
  let unavailable = false;
  let truncated = dropped > 0;
  let redacted = false;
  if (captureError !== undefined) {
    unavailable = true;
    const reason = sanitizeHistory(captureError, 400);
    redacted ||= reason.redacted;
    parts.push(`[full output capture failed: ${reason.text}]`);
  }
  if (dropped > 0) parts.push(`[${dropped} further output artifacts not retained]`);
  if (ids.length === 0 && /\[raw output: artifact:\/\/\d+\]/.test(textOf(result.content))) {
    unavailable = true;
    parts.push("[raw output reference has no trusted artifact metadata; only the tool preview was retained]");
  }
  if (ids.length === 0) return { text: parts.join("\n"), unavailable, truncated, redacted };
  if (!artifactsDir) {
    parts.push(`[artifacts ${ids.map((id) => `artifact://${id}`).join(", ")} unavailable: no session artifact directory]`);
    return { text: parts.join("\n"), unavailable: true, truncated, redacted };
  }
  let names: string[];
  try {
    names = await readdir(artifactsDir);
  } catch {
    parts.push(`[artifacts ${ids.map((id) => `artifact://${id}`).join(", ")} unavailable: artifact directory missing]`);
    return { text: parts.join("\n"), unavailable: true, truncated, redacted };
  }
  const budget = Math.floor(HISTORY_EVIDENCE_BYTES / ids.length);
  for (const id of ids) {
    const name = names.find((entry) => new RegExp(`^${id}\\.[A-Za-z0-9_-]+\\.log$`).test(entry));
    if (!name) {
      unavailable = true;
      parts.push(`[artifact://${id} unavailable: not found]`);
      continue;
    }
    const file = join(artifactsDir, name);
    try {
      const stat = await lstat(file);
      if (!stat.isFile()) {
        unavailable = true;
        parts.push(`[artifact://${id} unavailable: not a regular file]`);
        continue;
      }
      const handle = await open(file, "r");
      let bytes: Buffer;
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, budget));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        bytes = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      if (bytes.includes(0)) {
        unavailable = true;
        parts.push(`[artifact://${id} omitted: binary content]`);
        continue;
      }
      const cut = stat.size > bytes.length;
      // Streaming decode holds back an incomplete trailing sequence instead of emitting U+FFFD.
      const decoded = new TextDecoder("utf-8").decode(bytes, { stream: cut });
      const header = `[artifact://${id} full output${cut ? `, first ${Buffer.byteLength(decoded)} of ${stat.size} bytes` : ""}]\n`;
      const clean = sanitizeHistory(decoded, budget);
      truncated ||= cut || clean.truncated;
      redacted ||= clean.redacted;
      parts.push(header + clean.text);
    } catch {
      unavailable = true;
      parts.push(`[artifact://${id} unavailable: unreadable]`);
    }
  }
  return { text: parts.join("\n"), unavailable, truncated, redacted };
}
