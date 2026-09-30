/**
 * MCPBytes Memory for omp. omp's memory backends (`memory.backend`) are built in, so this plugin gives the same
 * behaviour through the extension API instead:
 *
 * - a session starts with one free call that checks the key can use Memory; when it cannot (a refused key, an account
 *   without Memory), the plugin says why once and stays off;
 * - the first request of a session is sent with the due intentions and the memories that match it (this project's
 *   space, then `default`), as an `<mcpbytes_memory>` message; standing instructions ride on every system prompt;
 * - `memory_recall` and `memory_retain` read and write that space (the MCPBytes MCP server, when also configured,
 *   still offers revise, forget and resolve);
 * - a stop after real work that saved nothing is continued once with a reminder to save what matters (like the
 *   automatic retention of omp's own backends, but the agent decides what is kept);
 * - `/mcpbytes-memory` shows the account's memory status and prices, or runs a free word search.
 *
 * Main sessions only: subagents get the tools when they ask for them, but no recall, instructions or reminder.
 */
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext, zod } from "@oh-my-pi/pi-coding-agent";
import { type Access, checkAccess, describeError, type MemoryApi, memoryApi } from "./api.ts";
import {
  guidance,
  isRetainTool,
  MESSAGE_TYPE,
  NUDGE,
  PLUGIN,
  RECALL_TOOL,
  recallBlock,
  recallQuery,
  requestKey,
  RETAIN_TOOL,
  type RetainOutcome,
  retainReport,
  resolveSettings,
  searchReport,
  searchSpaces,
  type Settings,
  shouldNudge,
  spaceName,
} from "./core.ts";

const NOT_CONFIGURED = `MCPBytes memory is off: no API key. Create one at https://console.mcpbytes.com (API keys), then run \`omp plugin config set ${PLUGIN} apiKey <key>\` or set MCPBYTES_API_KEY.`;

type SessionState = {
  settings: Settings;
  space: string;
  /** The first request's recall: kept so that a policy retry of the same request reuses it instead of buying it again. */
  recall?: { prompt: string; block: Promise<string | null> };
  /** Set once the first request is past, or when the session's history already holds a recall (a resumed session). */
  recallDone: boolean;
} & Access;

export default function mcpbytesMemory(pi: ExtensionAPI): void {
  const z = pi.zod;
  pi.setLabel("MCPBytes memory");
  const recallParams = z.object({
    query: z.string().describe("What you want to know, as a question or keywords"),
    words: z.boolean().optional().describe("Match words only (free), without search by meaning"),
  });
  const retainParams = z.object({
    items: z
      .array(
        z.object({
          text: z.string().describe("One self-contained sentence, in your own words"),
          kind: z.enum(["fact", "decision", "preference", "episode", "intention"]).optional().describe("Default fact; intention needs due_at"),
          global: z.boolean().optional().describe("Save to default, which every project recalls (the user's preferences)"),
          source: z.string().optional().describe("File path, commit or URL where it can be checked"),
          due_at: z.string().optional().describe("Intentions only: when to bring it up, ISO 8601, up to a year ahead"),
        }),
      )
      .min(1)
      .max(8),
  });
  const sessions = new Map<string, Promise<SessionState>>();
  let warned = false;
  // Since the last stop: tool calls that ran, and whether one of them saved to memory.
  let toolCalls = 0;
  let retained = false;

  async function storedSettings(cwd: string): Promise<Record<string, unknown>> {
    try {
      // Dynamic on purpose: the host's plugin settings module exists only when omp loads this as an installed plugin
      // (`-e` and SDK hosts may not provide it), and its absence must leave the environment settings working.
      const { getPluginSettings } = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins");
      return await getPluginSettings(PLUGIN, cwd);
    } catch (error) {
      pi.logger.warn("mcpbytes-memory: plugin settings unavailable, using the environment", { error: String(error) });
      return {};
    }
  }

  /** Like omp's own memory scoping: the primary checkout's name, so every worktree of a repository shares one space. */
  async function repositoryName(cwd: string): Promise<string> {
    const common = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeout: 5_000 });
    const dir = common.code === 0 ? common.stdout.trim() : "";
    if (dir && basename(dir) === ".git") return basename(dirname(dir));
    const top = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000 });
    return basename(top.code === 0 && top.stdout.trim() ? top.stdout.trim() : cwd);
  }

  async function prepare(ctx: ExtensionContext): Promise<SessionState> {
    const settings = resolveSettings(await storedSettings(ctx.cwd), process.env);
    const recallDone = ctx.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === MESSAGE_TYPE);
    // Independent lookups, so at once: whether the key can use Memory, and the repository that names the space.
    const [access, name] = await Promise.all([
      settings.apiKey ? checkAccess(memoryApi(settings)) : Promise.resolve<Access>({ api: null, off: NOT_CONFIGURED }),
      settings.space || repositoryName(ctx.cwd),
    ]);
    return { settings, space: spaceName(name), recallDone, ...access };
  }

  function sessionState(ctx: ExtensionContext): Promise<SessionState> {
    const id = ctx.sessionManager.getSessionId();
    let state = sessions.get(id);
    if (!state) {
      state = prepare(ctx);
      sessions.set(id, state);
    }
    return state;
  }

  async function recall(api: MemoryApi, space: string, prompt: string, ctx: ExtensionContext): Promise<string | null> {
    const spaces = searchSpaces(space);
    const query = recallQuery(prompt);
    try {
      const [due, found] = await Promise.all([api.due(spaces), query ? api.search({ query, spaces, limit: 8 }) : Promise.resolve({ results: [] })]);
      return recallBlock(space, due.intentions, found.results);
    } catch (error) {
      // Memory must never block work: the request goes on without it.
      if (ctx.hasUI) ctx.ui.notify(`MCPBytes memory: recall failed (${describeError(error)})`, "warning");
      return null;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent?.kind === "sub") return;
    // Prepared now, while the user types, so that the first request does not wait for it.
    const state = await sessionState(ctx);
    if (state.api === null && ctx.hasUI && !warned) {
      warned = true;
      ctx.ui.notify(state.off, "warning");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent?.kind === "sub") return;
    const state = await sessionState(ctx);
    if (state.api === null) return;
    const systemPrompt = [...event.systemPrompt, guidance(state.space)];
    if (!state.settings.autoRecall || state.recallDone) return { systemPrompt };
    // Handlers can run again for the same request (a policy retry): only a different prompt means the first one is past.
    if (state.recall && state.recall.prompt !== event.prompt) {
      state.recallDone = true;
      return { systemPrompt };
    }
    state.recall ??= { prompt: event.prompt, block: recall(state.api, state.space, event.prompt, ctx) };
    const block = await state.recall.block;
    return block ? { systemPrompt, message: { customType: MESSAGE_TYPE, content: block, display: true, attribution: "agent" } } : { systemPrompt };
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (ctx.agent?.kind === "sub") return;
    toolCalls++;
    if (!event.isError && isRetainTool(event.toolName)) retained = true;
  });

  pi.on("session_stop", async (event, ctx) => {
    const state = await sessionState(ctx);
    const nudge = shouldNudge({ enabled: state.api !== null && state.settings.retainNudge, toolCalls, retained, stopHookActive: event.stop_hook_active });
    toolCalls = 0;
    retained = false;
    return nudge ? { continue: true, additionalContext: NUDGE } : undefined;
  });

  pi.registerTool({
    name: RECALL_TOOL,
    label: "Recall memory",
    description: "Search the user's MCPBytes memory (this project's space, then default) by meaning and by words. Returns up to 8 memories with a relevance score, or the closest near misses. A search by meaning is charged only when it returns a match; words: true is always free.",
    parameters: recallParams,
    // Top-level like omp's own recall: the standing instructions name it, so it must not hide behind tool search.
    loadMode: "essential",
    approval: "read",
    // omp 18.4 infers `Static<>` only for ArkType/TypeBox schemas, so zod params are typed here.
    async execute(_toolCallId, params: zod.infer<typeof recallParams>, signal, _onUpdate, ctx) {
      const state = await sessionState(ctx);
      if (state.api === null) return { content: [{ type: "text", text: state.off }], isError: true };
      try {
        const found = await state.api.search({ query: recallQuery(params.query), spaces: searchSpaces(state.space), mode: params.words ? "words" : "auto", limit: 8 }, signal);
        return {
          content: [{ type: "text", text: searchReport(found) }],
          details: { results: found.results.length, charged: found.charged ?? 0 },
          useless: !found.results.length && !found.near_misses?.length,
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Recall failed: ${describeError(error)}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: RETAIN_TOOL,
    label: "Save to memory",
    description: "Save durable knowledge to the user's MCPBytes memory: this project's space, or default (every project) with global: true. For decisions and their reasons, constraints, fixes for recurring failures, the user's stated preferences. Each saved memory is charged. Credentials are refused. A space the user set to review holds the memory until they approve it.",
    parameters: retainParams,
    loadMode: "essential",
    // A paid write to the user's account: the approval mode decides whether it asks first.
    approval: "write",
    async execute(_toolCallId, params: zod.infer<typeof retainParams>, signal, _onUpdate, ctx) {
      const state = await sessionState(ctx);
      if (state.api === null) return { content: [{ type: "text", text: state.off }], isError: true };
      const sessionId = ctx.sessionManager.getSessionId();
      const outcomes: RetainOutcome[] = [];
      for (const item of params.items) {
        const space = item.global ? "default" : state.space;
        try {
          const receipt = await state.api.remember(
            {
              space,
              kind: item.kind ?? "fact",
              text: item.text,
              ...(item.source ? { source: item.source } : {}),
              ...(item.due_at ? { due_at: item.due_at } : {}),
              request_key: requestKey(sessionId, space, item),
            },
            signal,
          );
          outcomes.push({ text: item.text, space, receipt });
        } catch (error) {
          outcomes.push({ text: item.text, space, error: describeError(error) });
        }
      }
      const saved = outcomes.filter((outcome) => "receipt" in outcome).length;
      return { content: [{ type: "text", text: retainReport(outcomes) }], details: { saved }, isError: saved === 0 };
    },
  });

  pi.registerCommand("mcpbytes-memory", {
    description: "MCPBytes memory: status (spaces, counts, usage, prices), or `search <words>` (free word search)",
    handler: async (args, ctx) => {
      const state = await sessionState(ctx);
      const [subcommand, ...words] = args.trim().split(/\s+/);
      let text: string;
      if (state.api === null) text = state.off;
      else {
        try {
          if (subcommand === "search" && words.length) {
            text = searchReport(await state.api.search({ query: recallQuery(words.join(" ")), spaces: searchSpaces(state.space), mode: "words", limit: 8 }));
          } else {
            const [status, catalog] = await Promise.all([state.api.status(), state.api.catalog()]);
            const spaces = status.spaces
              .filter((space) => space.memories > 0)
              .map((space) => `${space.name} ${space.memories}${space.policy === "require_review" ? " (review)" : ""}`)
              .join(", ");
            // Prices come from the API, never from here: a price typed into this package would outlive a change.
            const prices = catalog.operations
              .filter((operation) => operation.credits)
              .map((operation) => `${operation.id.replace(/^memory_/, "")} ${operation.credits}`)
              .join(", ");
            text = [
              `MCPBytes memory: this project's space is ${state.space}${state.settings.autoRecall ? "" : " (automatic recall off)"}.`,
              `Memories: ${status.memories} of ${status.limits.max_memories}, in ${spaces || "no spaces yet"}.`,
              `Last 24 h: ${status.usage_last_24h.writes} writes, ${status.usage_last_24h.searches} searches. Due: ${status.intentions_due}. Waiting for review: ${status.pending_review}.`,
              `Prices in credits: ${prices || "none"}; a search is charged only when it returns a match by meaning, and the rest is free.`,
              "Review, edit or forget memories at https://console.mcpbytes.com/memory",
            ].join("\n");
          }
        } catch (error) {
          text = `MCPBytes memory: ${describeError(error)}`;
        }
      }
      pi.sendMessage({ customType: `${MESSAGE_TYPE}-status`, content: text, display: true, attribution: "user" }, { triggerTurn: false });
    },
  });
}
