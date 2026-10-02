import assert from "node:assert/strict";
import { test } from "node:test";
import { isSensitivePath, sanitizeHistory } from "../src/history-privacy.ts";

const SECRETS = [
  "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  "mcpb_AbCdEfGhIjKlMnOpQrStUvWx",
  "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123",
  "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
  "AKIAABCDEFGHIJKLMNOP",
  "AIzaSyA-1234567890abcdefghijklmnopqrstu",
  "xoxb-1234567890-abcdefghij",
  "glpat-abcdefghij0123456789",
  "sk_live_abcdefghijklmnop1234",
  "npm_abcdefghijklmnopqrstuvwxyz0123456789",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
];

test("recognizable provider credentials are redacted from free text", () => {
  for (const secret of SECRETS) {
    const out = sanitizeHistory(`ran with key ${secret} ok`);
    assert.ok(!out.text.includes(secret), secret);
    assert.ok(out.text.includes("[REDACTED]"));
    assert.ok(out.text.includes("ran with key") && out.text.includes("ok"));
    assert.equal(out.redacted, true);
  }
});

test("auth headers, cookies, credential URLs and signed query parameters are redacted", () => {
  const out = sanitizeHistory(
    [
      "curl -H 'Authorization: Bearer abcdef1234567890' https://api.example.com",
      "Cookie: session=abc123; theme=dark",
      "git clone https://alice:hunter2pass@github.com/acme/repo.git",
      "fetch https://bucket.s3.amazonaws.com/x?X-Amz-Signature=deadbeef&foo=bar",
      "postgres://admin:s3cr3t@db.internal:5432/app",
    ].join("\n"),
  );
  for (const leaked of ["abcdef1234567890", "session=abc123", "hunter2pass", "deadbeef", "s3cr3t"]) {
    assert.ok(!out.text.includes(leaked), leaked);
  }
  assert.ok(out.text.includes("github.com/acme/repo.git"), "non-secret URL parts stay readable");
  assert.ok(out.text.includes("foo=bar"));
  assert.equal(out.redacted, true);
});

test("private key blocks and secret assignments are redacted", () => {
  const out = sanitizeHistory(
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----\n" +
      "export DB_PASSWORD=correct-horse\nAPI_KEY: 'zzzz9999'\nmax_tokens: 4096",
  );
  assert.ok(!out.text.includes("b3BlbnNzaC1rZXktdjEAAAA"));
  assert.ok(!out.text.includes("correct-horse"));
  assert.ok(!out.text.includes("zzzz9999"));
  assert.ok(out.text.includes("max_tokens: 4096"), "numeric settings are not secrets");
});

test("structured fields: sensitive keys redacted, snapshots and hidden reasoning omitted", () => {
  const out = sanitizeHistory({
    command: "deploy",
    apiKey: "opaque-value-without-known-shape",
    headers: { Authorization: "Basic dXNlcjpwYXNz" },
    password: "pw",
    maxTokens: 100,
    oldText: "WHOLE OLD FILE CONTENT",
    newText: "WHOLE NEW FILE CONTENT",
    content: [
      { type: "thinking", thinking: "private chain of thought" },
      { type: "redactedThinking", data: "opaque-reasoning" },
      { type: "text", text: "visible answer" },
    ],
    systemPrompt: "You are a secret system prompt",
  });
  for (const hidden of [
    "opaque-value-without-known-shape",
    "dXNlcjpwYXNz",
    "WHOLE OLD",
    "WHOLE NEW",
    "chain of thought",
    "opaque-reasoning",
    "secret system prompt",
  ]) {
    assert.ok(!out.text.includes(hidden), hidden);
  }
  assert.ok(out.text.includes("visible answer"));
  assert.ok(out.text.includes("deploy"));
  assert.ok(out.text.includes('"maxTokens":100'));
  assert.equal(out.redacted, true);
});

test("ordinary text is unchanged and not marked redacted", () => {
  const out = sanitizeHistory("Deleted src/legacy.ts; tokens used: 1200; the password reset page was renamed");
  assert.equal(out.redacted, false);
  assert.equal(out.text, "Deleted src/legacy.ts; tokens used: 1200; the password reset page was renamed");
});

test("bounds are UTF-8 safe and disclosed", () => {
  const out = sanitizeHistory("é".repeat(5000), 1001);
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(out.text) <= 1001);
  assert.ok(!out.text.includes("\uFFFD"));
  assert.match(out.text, /\[truncated: 10000 bytes total\]$/);
  assert.equal(sanitizeHistory("short", 1001).truncated, false);
  for (const limit of [0, 1, 5, 20]) {
    const tiny = sanitizeHistory("€".repeat(100), limit);
    assert.equal(tiny.truncated, true);
    assert.ok(Buffer.byteLength(tiny.text) <= limit, `limit ${limit}`);
    assert.ok(!tiny.text.includes("\uFFFD"));
  }
});

test("credential files are sensitive; examples are not", () => {
  for (const path of [
    ".env",
    "app/.env.production",
    "app/.env:2-40",
    "app/.env.production:raw:1-5",
    "certs/server.pem?download=1",
    "/home/u/.ssh/config",
    "C:\\Users\\u\\.aws\\credentials",
    "certs/server.pem",
    "id_ed25519",
  ]) {
    assert.equal(isSensitivePath(path), true, path);
  }
  for (const path of [".env.example", "src/environment.ts", "docs/keys.md"]) {
    assert.equal(isSensitivePath(path), false, path);
  }
});
