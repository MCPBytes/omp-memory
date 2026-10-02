import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { memoryApi } from "./api.ts";
import { PLUGIN, type Settings } from "./core.ts";
import { historyPath } from "./history-types.ts";

const SOURCE_FOLDERS: Record<string, true> = {
  src: true,
  source: true,
  app: true,
  apps: true,
  lib: true,
  test: true,
  tests: true,
  docs: true,
};

export interface HistorySetupResult {
  path: string;
  roots: string[];
  enabled: boolean;
  cloudIndex: boolean;
}

export interface HistorySetupHost {
  cwd: string;
  hasUI: boolean;
  agent: { kind: "main" | "sub" };
  waitForIdle(): Promise<void>;
  ui: Pick<ExtensionCommandContext["ui"], "select" | "input" | "confirm" | "notify">;
}
type ProjectDocument = Record<string, unknown> & { settings?: Record<string, Record<string, unknown>> };

/** omp's project config directories, highest priority first: the files its plugin loader reads overrides from. Mirrored
 *  because compiled omp does not serve `@oh-my-pi/pi-coding-agent/config` to extensions; importing it fails the load. */
const PROJECT_CONFIG_DIRS = [".omp", ".claude", ".codex", ".gemini"];

function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/** Mirror the host's actual precedence, including an existing alternative project config directory. */
async function projectDocument(cwd: string, z: ExtensionAPI["zod"]): Promise<{ path: string; data: ProjectDocument; mode: number }> {
  const paths = PROJECT_CONFIG_DIRS.map((dir) => resolve(cwd, dir, "plugin-overrides.json"));
  const schema = z.object({ settings: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).passthrough();
  for (const path of paths) {
    let info: Stats;
    try {
      info = await lstat(path);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Project settings must be a regular file: ${path}. Nothing was changed.`);
    const raw = await readFile(path, "utf8");
    try {
      return { path, data: schema.parse(JSON.parse(raw)), mode: info.mode & 0o777 };
    } catch {
      throw new Error(`Existing project settings are invalid: ${path}. Fix that file before running setup; nothing was changed.`);
    }
  }
  return { path: paths[0], data: {}, mode: 0o600 };
}

/** Validate roots using the same directory/symlink boundary as the observer, while keeping project-relative paths portable. */
async function chosenRoot(cwd: string, input: string): Promise<string> {
  const value = input.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("\\\\"))
    throw new Error("Choose an existing local directory, not a URL or network share.");
  const expanded = value === "~" ? homedir() : /^~[\\/]/.test(value) ? join(homedir(), value.slice(2)) : value;
  const path = resolve(cwd, expanded);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Choose a real directory, not a file or symbolic link.");
  const canonical = await realpath(path);
  const local = relative(await realpath(cwd), canonical);
  return !local
    ? "."
    : !isAbsolute(local) && local !== ".." && !local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      ? local.replaceAll("\\", "/")
      : canonical.replaceAll("\\", "/");
}

/** No credentials are requested or persisted. Only the three history options change, after explicit confirmation. */
export async function setupHistory(host: HistorySetupHost, settings: Settings, z: ExtensionAPI["zod"]): Promise<HistorySetupResult | null> {
  if (!host.hasUI || host.agent?.kind === "sub")
    throw new Error("Run /mcpbytes-history setup in an interactive main omp session. Nothing was changed.");
  await host.waitForIdle();
  const initial = await projectDocument(host.cwd, z);
  const suggested = (await readdir(host.cwd, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && Object.hasOwn(SOURCE_FOLDERS, entry.name.toLowerCase()))
    .map((entry) => entry.name)
    .sort();
  const options = [
    ...(suggested.length ? [{ label: "Watch source folders", description: `${suggested.join(", ")} — recommended` }] : []),
    { label: "Tool activity only", description: "Free local history, without scanning directories" },
    { label: "Watch this folder", description: `${host.cwd} — includes dependency and generated folders` },
    { label: "Choose folders", description: "Enter ordinary paths, one at a time; no JSON or escaping" },
    { label: "Turn history off", description: "Stop activity capture and its cloud indexing; existing records keep their original expiry" },
  ];
  const choice = await host.ui.select(`Activity history — ${host.cwd}`, options, {
    helpText: "Saved for this project only. Esc cancels without changing settings.",
  });
  if (choice === undefined) return null;
  const enabled = choice !== "Turn history off";
  let roots: string[];
  if (choice === "Watch source folders") roots = suggested;
  else if (choice === "Tool activity only" || !enabled) roots = [];
  else if (choice === "Watch this folder") roots = ["."];
  else if (choice === "Choose folders") {
    roots = [];
    for (;;) {
      const input = await host.ui.input(
        roots.length ? "Another folder (leave blank to finish; Esc cancels)" : "Folder to watch (relative to this project, or absolute)",
        "src or a full directory path",
      );
      if (input === undefined) return null;
      if (!input.trim() && roots.length) break;
      try {
        const root = await chosenRoot(host.cwd, input);
        const identity = historyPath(root, host.cwd);
        if (!roots.some((existing) => historyPath(existing, host.cwd) === identity)) roots.push(root);
      } catch {
        host.ui.notify(
          "That is not an accessible local directory. Enter an existing directory; symbolic links are not followed.",
          "warning",
        );
      }
    }
  } else return null;
  roots = await Promise.all(roots.map((root) => chosenRoot(host.cwd, root)));

  let cloudIndex = false;
  let cloudDescription = enabled ? "Off — local history is free and does not require an API key." : "Off — no activity indexing.";
  if (enabled && settings.apiKey) {
    const cloud = await host.ui.select("Cloud indexing", [
      { label: "Local only", description: "No activity descriptions uploaded and no indexing charges (recommended)" },
      {
        label: "Enable cloud indexing",
        description: "Uploads compact activity descriptions; current prices are checked before confirmation",
      },
    ]);
    if (cloud === undefined) return null;
    if (cloud === "Enable cloud indexing") {
      const catalog = await memoryApi(settings).catalog();
      const write = catalog.operations.find((operation) => operation.id === "memory_remember")?.credits;
      const search = catalog.operations.find((operation) => operation.id === "memory_search")?.credits;
      if (
        !catalog.served ||
        typeof write !== "number" ||
        !Number.isFinite(write) ||
        write < 0 ||
        typeof search !== "number" ||
        !Number.isFinite(search) ||
        search < 0
      ) {
        throw new Error("Cloud Memory or its current prices are unavailable. Nothing was changed; rerun setup with Local only.");
      }
      cloudIndex = true;
      cloudDescription = `On — ${write} credits per accepted compact episode; ${search} per qualifying semantic search. Existing retained activity in this session may be indexed. Raw evidence stays local.`;
    }
  }
  const approved = await host.ui.confirm(
    "Save activity history setup?",
    [
      `Project: ${host.cwd}`,
      enabled
        ? "Local capture: on, fixed 30-day retention. Redacted messages/tool evidence from this session may be recovered. No file restoration."
        : "Local capture: off. Existing records keep their fixed deadline; this does not erase them or change curated Memory.",
      `Watched folders: ${roots.length ? roots.join(", ") : enabled ? "none (tool activity only)" : "none (capture off)"}`,
      ...(roots.length ? ["Watching includes all descendants; .gitignore is not applied. Only metadata is scanned."] : []),
      `Cloud indexing: ${cloudDescription}`,
      `Settings file: ${initial.path}`,
      "Existing unrelated settings and API keys will not be changed. Applies now in this session; other running sessions must reload.",
    ].join("\n\n"),
  );
  if (!approved) return null;

  // Re-read after the dialogs so concurrent edits to unrelated settings are preserved.
  const latest = await projectDocument(host.cwd, z);
  if (latest.path !== initial.path)
    throw new Error("The active project settings file changed while setup was open. Nothing was changed; run setup again.");
  const parent = dirname(latest.path);
  try {
    if ((await lstat(parent)).isSymbolicLink())
      throw new Error("The project settings directory is a symbolic link; update it manually instead.");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const document: ProjectDocument = {
    ...latest.data,
    settings: {
      ...latest.data.settings,
      [PLUGIN]: {
        ...latest.data.settings?.[PLUGIN],
        history: enabled,
        ...(enabled ? { historyRoots: JSON.stringify(roots) } : {}),
        historyCloudIndex: cloudIndex,
      },
    },
  };
  await mkdir(parent, { recursive: true });
  const temporary = `${latest.path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: latest.mode, flag: "wx" });
    await rename(temporary, latest.path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { path: latest.path, roots, enabled, cloudIndex };
}
