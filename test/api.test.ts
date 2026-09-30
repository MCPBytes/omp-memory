import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAccess, memoryApi } from "../src/api.ts";

const client = (fetchImpl: () => Promise<Response>) => memoryApi({ apiKey: "k", apiUrl: "https://api.example" }, fetchImpl as typeof fetch);
const respond = (status: number, body: unknown) => async () => Response.json(body, { status });

test("a refused key or an account without Memory turns the plugin off; an unreachable API does not", async () => {
  const on = await checkAccess(client(respond(200, { served: true, operations: [] })));
  assert.equal(on.off, null);
  assert.ok(on.api);

  const noMemory = await checkAccess(client(respond(200, { served: false, operations: [] })));
  assert.equal(noMemory.api, null);
  assert.match(noMemory.off ?? "", /not available to this account/);

  // The sign-in layer's error shape, as the live API sends it for an unknown key.
  const refused = await checkAccess(client(respond(401, { error: "invalid_token", error_description: "Invalid access token" })));
  assert.equal(refused.api, null);
  assert.match(refused.off ?? "", /refused \(invalid_token: Invalid access token\)/);

  // Offline or failing: memory stays on, and each later call reports its own error.
  for (const failing of [async () => Promise.reject(new TypeError("fetch failed")), respond(503, { error: { code: "unavailable", message: "try again" } })]) {
    const unknown = await checkAccess(client(failing));
    assert.equal(unknown.off, null);
    assert.ok(unknown.api);
  }
});
