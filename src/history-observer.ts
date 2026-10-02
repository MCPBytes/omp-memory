import { type Dirent, type FSWatcher, watch } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { type FileObservation, type HistorySession, type HistoryStorage, historyId, historyPath } from "./history-types.ts";

export interface HistoryObserverOptions {
  clock?: () => number;
  onError?: (error: unknown) => void;
  debounceMs?: number;
  scanIntervalMs?: number;
  /** Explicit subtrees never inventoried (e.g. the history database directory). Reported via `exclusions`. */
  exclude?: string[];
}

interface ScanResult {
  entries: FileObservation[];
  /** Normalized directories that could not be read; their previous evidence is preserved. */
  gaps: string[];
  /** The root itself no longer exists, which is evidence of removal, unlike a permission failure. */
  missing?: boolean;
}

const slash = (path: string): string => path.replaceAll("\\", "/");
/** Root notes written after a completed scan; other root errors mean no baseline exists. */
const SCANNED_NOTE = /^(root directory missing|partial scan|watch unavailable)/;
const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/**
 * Metadata-only observer for explicit workspace roots. Records paths, kinds and last-seen
 * times, never contents. Absence is reported as an observation with unknown actor and cause.
 */
export class HistoryObserver {
  private readonly store: HistoryStorage;
  private readonly session: HistorySession;
  private readonly roots: string[];
  private readonly clock: () => number;
  private readonly onError: (error: unknown) => void;
  private readonly debounceMs: number;
  private readonly scanIntervalMs: number;
  private readonly requestedExclusions: string[];
  private canonicalRoots: string[] = [];
  private excluded: string[] = [];
  private watchers: FSWatcher[] = [];
  private readonly watchErrors = new Map<string, string>();
  private debounce: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | undefined;
  private stopped = false;
  private running = false;

  constructor(store: HistoryStorage, session: HistorySession, roots: string[], options: HistoryObserverOptions = {}) {
    this.store = store;
    this.session = session;
    this.roots = roots;
    this.clock = options.clock ?? Date.now;
    this.onError = options.onError ?? (() => {});
    this.debounceMs = options.debounceMs ?? 500;
    this.scanIntervalMs = options.scanIntervalMs ?? 300_000;
    this.requestedExclusions = options.exclude ?? [];
  }

  /** Canonical roots being observed. */
  get observedRoots(): readonly string[] {
    return this.canonicalRoots;
  }

  /** Explicitly excluded subtrees, canonicalized; nothing else is excluded. */
  get exclusions(): readonly string[] {
    return this.excluded;
  }

  async start(): Promise<void> {
    // A restart drains the previous run so watchers and timers never duplicate.
    if (this.running) await this.stop();
    this.running = true;
    this.stopped = false;
    this.canonicalRoots = [];
    this.watchErrors.clear();
    for (const root of this.roots) {
      const canonical = await this.canonicalRoot(root);
      if (canonical && !this.canonicalRoots.some((known) => historyPath(known) === historyPath(canonical)))
        this.canonicalRoots.push(canonical);
    }
    this.excluded = [];
    for (const path of this.requestedExclusions) {
      this.excluded.push(slash(await realpath(resolve(path)).catch(() => resolve(path))));
    }
    await this.scan();
    if (this.stopped) return;
    for (const root of this.canonicalRoots) {
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
          if (filename && this.isExcluded(join(root, String(filename)))) return;
          this.schedule();
        });
        watcher.on("error", (error) => this.watchFailed(root, error));
        this.watchers.push(watcher);
      } catch (error) {
        this.watchFailed(root, error);
      }
    }
    if (this.scanIntervalMs > 0) {
      this.interval = setInterval(() => void this.scan(), this.scanIntervalMs);
      this.interval.unref?.();
    }
  }

  /** Scans all roots. Concurrent requests coalesce into at most one queued scan. */
  scan(): Promise<void> {
    if (this.stopped) return this.chain;
    if (this.queued) return this.queued;
    const next = this.chain.then(async () => {
      this.queued = undefined;
      for (const root of this.canonicalRoots) {
        try {
          await this.scanRoot(root);
        } catch (error) {
          this.onError(error);
        }
      }
    });
    this.queued = next;
    this.chain = next;
    return next;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    clearTimeout(this.debounce);
    clearInterval(this.interval);
    this.debounce = undefined;
    this.interval = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    await this.chain;
  }

  /** A successful native mutation can precede the watch debounce; establish existence without rescanning the tree. */
  async rememberPresentFile(path: string): Promise<void> {
    if (this.stopped || /^[a-z][a-z0-9+.-]*:\/\//i.test(path) || this.isExcluded(path)) return;
    await this.chain;
    for (const root of this.canonicalRoots) {
      if (!within(historyPath(path), historyPath(root))) continue;
      try {
        const stat = await lstat(path);
        if (!stat.isSymbolicLink() && !within(historyPath(await realpath(path)), historyPath(root))) continue;
        this.store.rememberFile(this.session.workspaceId, root, {
          path: historyPath(path),
          kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
          lastSeenAt: this.clock(),
        });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
        this.onError(error);
      }
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.scan();
    }, this.debounceMs);
    this.debounce.unref?.();
  }

  /** Watch failures are coverage gaps; periodic resynchronization still covers the root. */
  private watchFailed(root: string, error: unknown): void {
    this.onError(error);
    const message = `watch unavailable, periodic scans only: ${error instanceof Error ? error.message : String(error)}`;
    this.watchErrors.set(root, message);
    this.store.recordRoot(this.session.workspaceId, root, this.clock(), message);
  }

  private async canonicalRoot(root: string): Promise<string | undefined> {
    const fail = (error: string): undefined => {
      this.onError(new Error(`history root ${root}: ${error}`));
      this.store.recordRoot(this.session.workspaceId, root, this.clock(), error);
      return undefined;
    };
    if (/^[a-z][a-z0-9+.-]+:\/\//i.test(root) || root.startsWith("\\\\")) return fail("only local directory paths are observed");
    const absolute = resolve(this.session.cwd, root);
    try {
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) return fail("root is a symbolic link; configure its target explicitly");
      if (!stat.isDirectory()) return fail("root is not a directory");
      return slash(await realpath(absolute));
    } catch (error) {
      // A previously scanned root that is now gone stays observed so removal and recreation are reconciled.
      const known = this.store.status(this.session.workspaceId).roots.find((entry) => historyPath(entry.root) === historyPath(absolute));
      if (isMissing(error) && known && known.lastScanAt > 0 && (!known.error || SCANNED_NOTE.test(known.error))) return known.root;
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  private isExcluded(path: string): boolean {
    const key = historyPath(path);
    return this.excluded.some((dir) => within(key, historyPath(dir)));
  }

  private async walk(root: string): Promise<ScanResult> {
    const at = this.clock();
    const entries: FileObservation[] = [];
    const gaps: string[] = [];
    let top: Dirent[];
    try {
      top = await readdir(root, { withFileTypes: true });
    } catch (error) {
      // Permission and other failures throw: an unreadable root is a coverage gap, not removal.
      if (isMissing(error)) return { entries, gaps, missing: true };
      throw error;
    }
    const stack: { dir: string; items: Dirent[] }[] = [{ dir: root, items: top }];
    while (stack.length) {
      const { dir, items } = stack.pop()!;
      for (const item of items) {
        const path = slash(join(dir, item.name));
        if (this.isExcluded(path)) continue;
        // Symbolic links are recorded but never followed, so no link escapes the root.
        const kind = item.isSymbolicLink() ? "symlink" : item.isDirectory() ? "directory" : "file";
        entries.push({ path: historyPath(path), kind, lastSeenAt: at });
        if (kind !== "directory") continue;
        try {
          stack.push({ dir: path, items: await readdir(path, { withFileTypes: true }) });
        } catch {
          gaps.push(historyPath(path));
        }
      }
    }
    return { entries, gaps };
  }

  private async scanRoot(root: string): Promise<void> {
    const ws = this.session.workspaceId;
    let result: ScanResult;
    try {
      result = await this.walk(root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.recordRoot(ws, root, this.clock(), `scan failed; inventory preserved: ${message}`);
      return;
    }
    const at = this.clock();
    const previous = this.store.inventory(ws, root);
    // Only a completed scan (possibly partial, missing-root, or watch-degraded) establishes a baseline.
    const baselined =
      previous.length > 0 ||
      this.store
        .status(ws)
        .roots.some(
          (known) =>
            historyPath(known.root) === historyPath(root) && known.lastScanAt > 0 && (!known.error || SCANNED_NOTE.test(known.error)),
        );
    const current = new Map(result.entries.map((entry) => [historyPath(entry.path), entry]));
    const prior = new Map(previous.map((entry) => [historyPath(entry.path), entry]));
    const inGap = (key: string): boolean => result.gaps.some((gap) => key !== gap && within(key, gap));

    const disappeared: FileObservation[] = [];
    const next = [...result.entries];
    for (const [key, entry] of prior) {
      if (current.has(key)) continue;
      if (this.isExcluded(entry.path)) continue;
      if (inGap(key)) {
        next.push(entry);
        continue;
      }
      disappeared.push(entry);
    }
    const appeared = baselined ? result.entries.filter((entry) => !prior.has(historyPath(entry.path))) : [];

    for (const entry of disappeared) {
      const candidates = appeared
        .filter((other) => basename(other.path) === basename(entry.path) && other.kind === entry.kind)
        .map((other) => other.path);
      const move = candidates.length
        ? ` A ${entry.kind} with the same name appeared at ${candidates.join(", ")}; this may be a move or rename.`
        : " It may have been moved, renamed or deleted.";
      this.store.append({
        key: historyId("file.disappeared", ws, historyPath(entry.path), entry.lastSeenAt),
        sessionId: this.session.id,
        kind: "file.disappeared",
        occurredAt: at,
        observedAt: at,
        summary: `${entry.kind} ${entry.path} no longer present; actor and cause unknown`,
        evidence: `${entry.kind} ${entry.path} was present at ${new Date(entry.lastSeenAt).toISOString()} and missing when observed at ${new Date(at).toISOString()}; actor and exact time unknown.${move}`,
        source: "filesystem",
        outcome: "observed",
        path: entry.path,
      });
    }
    for (const entry of appeared) {
      this.store.append({
        key: historyId("file.appeared", ws, historyPath(entry.path), at),
        sessionId: this.session.id,
        kind: "file.appeared",
        occurredAt: at,
        observedAt: at,
        summary: `${entry.kind} ${entry.path} newly observed; actor unknown`,
        evidence: `${entry.kind} ${entry.path} was first observed at ${new Date(at).toISOString()}; actor and exact time unknown.`,
        source: "filesystem",
        outcome: "observed",
        path: entry.path,
      });
    }
    this.store.replaceInventory(ws, root, next, at);
    const notes = [
      result.missing ? "root directory missing" : undefined,
      result.gaps.length
        ? `partial scan; ${result.gaps.length} unreadable director${result.gaps.length === 1 ? "y" : "ies"} preserved`
        : undefined,
      this.watchErrors.get(root),
    ].filter(Boolean);
    this.store.recordRoot(ws, root, at, notes.length ? notes.join("; ") : undefined);
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
