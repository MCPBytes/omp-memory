import { HISTORY_EVIDENCE_BYTES } from "./history-types.ts";

/**
 * Best-effort redaction applied before history is stored locally or indexed in the cloud.
 * It removes sensitive fields and recognizable credential shapes; it cannot detect every secret.
 */
export interface SanitizedHistory {
  text: string;
  redacted: boolean;
  truncated: boolean;
}

export const REDACTED = "[REDACTED]";
const SNAPSHOT_OMITTED = "[file snapshot omitted]";
const REASONING_OMITTED = "[hidden reasoning omitted]";
const MAX_DEPTH = 24;

/** Field names whose values are whole-file snapshots or hidden reasoning/system content, never retained. */
const SNAPSHOT_KEYS: Record<string, true> = { oldtext: true, newtext: true };
const HIDDEN_KEYS: Record<string, true> = {
  thinking: true,
  thinkingsignature: true,
  thoughtsignature: true,
  reasoning: true,
  reasoningcontent: true,
  encryptedcontent: true,
  systemprompt: true,
  system: true,
};
const HIDDEN_BLOCK_TYPES: Record<string, true> = { thinking: true, redactedThinking: true, reasoning: true };

function isHiddenBlock(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    Object.hasOwn(HIDDEN_BLOCK_TYPES, value.type)
  );
}

/** A field name that names a credential. Only non-numeric values are redacted (maxTokens stays readable). */
const SENSITIVE_KEY =
  /(?:^|_)(?:pass(?:word|wd|phrase)?|pwd|secrets?|tokens?|api_?keys?|auth|authorization|cookies?|set_cookie|credentials?|private_?keys?|access_?keys?|secret_?keys?|client_?secret|bearer|signature|otp)$/;

export const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_KEY.test(
    key
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .toLowerCase()
      .replace(/^_+|_+$/g, ""),
  );

/** Paths whose contents are credentials by convention; reads of them are never retained. */
const SENSITIVE_PATH =
  /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.netrc|_netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|\.dockercfg|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml)|[^\\/]+\.(?:pem|key|p12|pfx|jks|keystore|kdbx))$|(?:^|[\\/])(?:\.ssh|\.aws|\.gnupg|\.docker)[\\/]/i;

export const isSensitivePath = (path: string): boolean => {
  // Reader selectors and URL query strings do not make a credential file safe to retain.
  const trimmed = path
    .trim()
    .split(/[?#]/, 1)[0]!
    .replace(/:[^\\/]*$/, "");
  if (/\.env\.(?:example|sample|template)$/i.test(trimmed)) return false;
  return SENSITIVE_PATH.test(trimmed);
};

type Rule = [RegExp, string | ((...match: string[]) => string)];

/** Credential shapes; order matters (blocks and URLs before generic assignments). */
const RULES: Rule[] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, `${REDACTED} private key block`],
  [
    /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(bearer|basic|token|digest|negotiate)\s+)?[^\s"',;\\]+/gi,
    (_m, head, scheme) => `${head}${scheme ? `${scheme} ` : ""}${REDACTED}`,
  ],
  [/\b((?:set-)?cookie["']?\s*:\s*["']?)[^\r\n"'\\]+/gi, `$1${REDACTED}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]+:[^\s/@"'<>]+@/gi, `$1${REDACTED}@`],
  [
    /([?&#](?:access_token|refresh_token|id_token|token|api_key|apikey|key|sig|signature|secret|client_secret|password|pwd|auth|code|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)[^&\s"'#<>]+/gi,
    `$1${REDACTED}`,
  ],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bmcpb_[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, `https://hooks.slack.com/services/${REDACTED}`],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9+/=]{20,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, REDACTED],
  [/\bhf_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bpypi-[A-Za-z0-9_-]{50,}/g, REDACTED],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bdop_v1_[a-f0-9]{64}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [
    /\b([A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential)s?[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)(?!\[REDACTED\])(?!\d+\b)(?!true\b|false\b|null\b|undefined\b)([^\s"',;&]{4,})/gi,
    `$1$2$3${REDACTED}`,
  ],
];

function redactText(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement as string);
  }
  return { text: out, redacted: out !== text };
}

/** Removes fields that must never be stored and redacts sensitive field values. */
function scrub(value: unknown, state: { redacted: boolean }, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (seen.has(value)) return "[circular]";
  if (depth > MAX_DEPTH) return "[nested value omitted]";
  seen.add(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (isHiddenBlock(item)) {
        out.push(REASONING_OMITTED);
        continue;
      }
      out.push(scrub(item, state, seen, depth + 1));
    }
    return out;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return "[binary omitted]";
  if (isHiddenBlock(value)) return REASONING_OMITTED;
  if ("type" in value && value.type === "image" && "data" in value && typeof value.data === "string") {
    return "[image omitted]";
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined || typeof field === "function") continue;
    const lower = key.toLowerCase();
    if (Object.hasOwn(SNAPSHOT_KEYS, lower)) {
      out[key] = SNAPSHOT_OMITTED;
      continue;
    }
    if (Object.hasOwn(HIDDEN_KEYS, lower)) {
      out[key] = REASONING_OMITTED;
      continue;
    }
    if (isSensitiveKey(key) && field !== null && typeof field !== "number" && typeof field !== "boolean") {
      out[key] = REDACTED;
      state.redacted = true;
      continue;
    }
    out[key] = scrub(field, state, seen, depth + 1);
  }
  return out;
}

/** Cuts to at most `limit` UTF-8 bytes without splitting a code point; the marker is dropped when it cannot fit. */
export function truncateUtf8(text: string, limit: number): { text: string; truncated: boolean } {
  const max = Math.max(0, Math.floor(limit));
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { text, truncated: false };
  const marker = `\n[truncated: ${bytes.length} bytes total]`;
  const room = max - Buffer.byteLength(marker);
  const suffix = room >= 0 ? marker : "";
  let end = room >= 0 ? room : max;
  // bytes.length > max >= end, so bytes[end] exists; never start a cut inside a multi-byte sequence.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8") + suffix, truncated: true };
}

/**
 * Serializes, redacts and bounds a value for history. Strings are redacted by pattern; objects are first
 * scrubbed by field name, then serialized and redacted by pattern.
 */
export function sanitizeHistory(value: unknown, limitBytes: number = HISTORY_EVIDENCE_BYTES): SanitizedHistory {
  const state = { redacted: false };
  let text: string;
  if (value === undefined || value === null) text = "";
  else if (typeof value === "string") text = value;
  else if (typeof value === "object") {
    try {
      text = JSON.stringify(scrub(value, state, new WeakSet(), 0)) ?? "";
    } catch {
      text = "[unserializable value]";
    }
  } else text = String(value);
  const patterned = redactText(text);
  const bounded = truncateUtf8(patterned.text, Math.max(0, limitBytes));
  return { text: bounded.text, redacted: state.redacted || patterned.redacted, truncated: bounded.truncated };
}
