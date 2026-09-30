/**
 * The MCPBytes Memory REST routes this plugin uses (`/v1/memory`). Memory answers synchronously; every call is bounded,
 * and failures carry the API's error code, never the key.
 */
import pkg from "../package.json" with { type: "json" };
import type { Memory, Receipt, SearchResult, Settings } from "./core.ts";

const TIMEOUT_MS = 8_000;
const USER_AGENT = `mcpbytes-omp-memory/${pkg.version}`;

export class MemoryApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** `GET /v1/memory`: answers for every valid key, whether or not its account has Memory. */
export interface Catalog {
  served: boolean;
  /** Credits per call; null for an operation that is not released. */
  operations: { id: string; credits: number | null }[];
}

export interface SearchRequest {
  query: string;
  spaces: string[];
  mode?: "auto" | "words";
  limit?: number;
}

export interface RememberRequest {
  space: string;
  kind: string;
  text: string;
  source?: string;
  due_at?: string;
  request_key: string;
}

export interface Status {
  spaces: { name: string; policy: string; memories: number }[];
  memories: number;
  limits: { max_memories: number; max_spaces: number; writes_per_day: number };
  usage_last_24h: { writes: number; searches: number };
  pending_review: number;
  intentions_due: number;
  change: number;
}

export interface MemoryApi {
  catalog(signal?: AbortSignal): Promise<Catalog>;
  search(body: SearchRequest, signal?: AbortSignal): Promise<SearchResult>;
  remember(body: RememberRequest, signal?: AbortSignal): Promise<Receipt>;
  due(spaces: string[], signal?: AbortSignal): Promise<{ intentions: Memory[] }>;
  status(signal?: AbortSignal): Promise<Status>;
}

/** The plugin is on with a client, or off with the reason it tells the user and the model. */
export type Access = { api: MemoryApi; off: null } | { api: null; off: string };

/** `code: message` of a failure, safe to show the model and the user. */
export function describeError(error: unknown): string {
  if (error instanceof MemoryApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout: MCPBytes did not answer in time";
  return `network_error: ${error instanceof Error ? error.message : String(error)}`;
}

export function memoryApi(settings: Pick<Settings, "apiKey" | "apiUrl">, fetchImpl: typeof fetch = fetch): MemoryApi {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(settings.apiUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "User-Agent": USER_AGENT,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const payload = (await response.json().catch(() => null)) as { error?: string | { code?: string; message?: string }; error_description?: string } | null;
    if (!response.ok) {
      // Two shapes: the API's { error: { code, message } }, and the sign-in layer's { error, error_description } for a
      // key it refuses.
      const error = payload?.error;
      const code = typeof error === "string" ? error : error?.code;
      const message = typeof error === "string" ? payload?.error_description : error?.message;
      throw new MemoryApiError(response.status, code ?? `http_${response.status}`, message ?? response.statusText);
    }
    return payload as T;
  }
  return {
    catalog: (signal) => call("GET", "/v1/memory", undefined, signal),
    search: (body, signal) => call("POST", "/v1/memory/search", body, signal),
    remember: (body, signal) => call("POST", "/v1/memory/remember", body, signal),
    due: (spaces, signal) => call("GET", `/v1/memory/due?space=${encodeURIComponent(spaces.join(","))}`, undefined, signal),
    status: (signal) => call("GET", "/v1/memory/status", undefined, signal),
  };
}

/** Off when the key is refused or its account does not have Memory. On when that cannot be told (the API is out of
 *  reach): the calls that follow then report their own errors, and memory comes back with the network. */
export async function checkAccess(api: MemoryApi): Promise<Access> {
  try {
    const catalog = await api.catalog();
    return catalog.served ? { api, off: null } : { api: null, off: "MCPBytes memory is off: Memory is not available to this account yet." };
  } catch (error) {
    if (error instanceof MemoryApiError && (error.status === 401 || error.status === 403)) {
      return { api: null, off: `MCPBytes memory is off: the API key was refused (${describeError(error)}).` };
    }
    return { api, off: null };
  }
}
