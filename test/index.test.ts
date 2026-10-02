import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// omp loads an installed plugin from its published files and serves only some host modules itself; a value import of
// an omp internal (`@oh-my-pi/pi-coding-agent/config`) made the extension fail to load in the installed omp.
test("the published files load as an omp extension without development dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcpbytes-install-"));
  try {
    await cp(join(import.meta.dir, "..", "src"), join(root, "src"), { recursive: true });
    await cp(join(import.meta.dir, "..", "package.json"), join(root, "package.json"));
    const entry = JSON.stringify(join(root, "src", "index.ts"));
    // --no-install: a missing package must fail here rather than be fetched from the registry.
    const child = Bun.spawn([process.execPath, "--no-install", "-e", `console.log(typeof (await import(${entry})).default)`], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), "function");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
