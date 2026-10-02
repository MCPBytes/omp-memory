import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zod } from "@oh-my-pi/pi-coding-agent";
import { PLUGIN, resolveSettings } from "../src/core.ts";
import { setupHistory, type HistorySetupHost } from "../src/history-setup.ts";

async function fixture(choices: (number | undefined)[], inputs: (string | undefined)[] = []) {
  const cwd = await mkdtemp(join(tmpdir(), "mcpbytes-history-setup-"));
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, "test"));
  const path = join(cwd, ".omp", "plugin-overrides.json");
  const state = { approved: true, warnings: 0, beforeConfirm: async () => {} };
  const host: HistorySetupHost = {
    cwd,
    hasUI: true,
    agent: { kind: "main" },
    waitForIdle: async () => {},
    ui: {
      async select(_title, options) {
        const selected = choices.shift();
        const option = selected === undefined ? undefined : options[selected];
        return typeof option === "string" ? option : option?.label;
      },
      input: async () => inputs.shift(),
      confirm: async () => {
        await state.beforeConfirm();
        return state.approved;
      },
      notify: () => {
        state.warnings++;
      },
    },
  };
  return { cwd, path, state, host, settings: resolveSettings({}, {}) };
}

const documentSchema = zod
  .object({
    disabled: zod.array(zod.string()).optional(),
    settings: zod.record(zod.string(), zod.record(zod.string(), zod.unknown())),
  })
  .passthrough();

async function document(path: string) {
  return documentSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

test("guided source-folder setup preserves unrelated settings and never copies credentials from the environment", async () => {
  const f = await fixture([0]);
  try {
    await mkdir(join(f.cwd, ".omp"));
    await writeFile(
      f.path,
      JSON.stringify({
        disabled: ["unrelated-plugin"],
        features: { other: ["x"] },
        settings: { [PLUGIN]: { space: "original-space", autoRecall: false }, other: { enabled: true } },
      }),
    );
    const saved = await setupHistory(f.host, f.settings, zod);
    assert.deepEqual(saved?.roots, ["src", "test"]);
    const after = await document(f.path);
    assert.deepEqual(after.disabled, ["unrelated-plugin"]);
    assert.deepEqual(after.features, { other: ["x"] });
    assert.deepEqual(after.settings.other, { enabled: true });
    assert.deepEqual(after.settings[PLUGIN], {
      space: "original-space",
      autoRecall: false,
      history: true,
      historyRoots: '["src","test"]',
      historyCloudIndex: false,
    });
    assert.equal(Object.hasOwn(after.settings[PLUGIN], "apiKey"), false);
    assert.deepEqual(await readdir(join(f.cwd, ".omp")), ["plugin-overrides.json"]);
  } finally {
    await rm(f.cwd, { recursive: true, force: true });
  }
});

test("canceling either selection or confirmation leaves the project untouched", async () => {
  for (const atConfirmation of [false, true]) {
    const f = await fixture(atConfirmation ? [0] : [undefined]);
    f.state.approved = false;
    try {
      assert.equal(await setupHistory(f.host, f.settings, zod), null);
      assert.equal(await Bun.file(f.path).exists(), false);
      assert.ok(!(await readdir(f.cwd)).includes(".omp"));
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  }
});

test("custom folders accept spaces, reject nonexistent paths, and deduplicate equivalent directory paths", async () => {
  const f = await fixture([3], ["does-not-exist", "src", "src/../source folder", "source folder", ""]);
  try {
    await mkdir(join(f.cwd, "source folder"));
    const saved = await setupHistory(f.host, f.settings, zod);
    assert.deepEqual(saved?.roots, ["src", "source folder"]);
    assert.equal(f.state.warnings, 1);
    assert.equal((await document(f.path)).settings[PLUGIN].historyRoots, '["src","source folder"]');
  } finally {
    await rm(f.cwd, { recursive: true, force: true });
  }
});

test("setup updates the existing active project override and preserves edits made while its dialog was open", async () => {
  const f = await fixture([1]);
  const alternate = join(f.cwd, ".claude", "plugin-overrides.json");
  try {
    await mkdir(join(f.cwd, ".claude"));
    await writeFile(alternate, JSON.stringify({ settings: { [PLUGIN]: { space: "before" }, other: { value: 1 } } }));
    f.state.beforeConfirm = async () => {
      await writeFile(
        alternate,
        JSON.stringify({ settings: { [PLUGIN]: { space: "concurrent", apiKey: "existing-user-value" }, other: { value: 2 } } }),
      );
    };
    const saved = await setupHistory(f.host, f.settings, zod);
    assert.equal(saved?.path, alternate);
    assert.equal(await Bun.file(f.path).exists(), false);
    const after = await document(alternate);
    assert.equal(after.settings.other.value, 2);
    assert.equal(after.settings[PLUGIN].space, "concurrent");
    assert.equal(after.settings[PLUGIN].apiKey, "existing-user-value");
    assert.equal(after.settings[PLUGIN].historyRoots, "[]");
  } finally {
    await rm(f.cwd, { recursive: true, force: true });
  }
});

test("invalid existing settings are never replaced", async () => {
  const f = await fixture([0]);
  const invalid = '{"settings": this is not JSON';
  try {
    await mkdir(join(f.cwd, ".omp"));
    await writeFile(f.path, invalid);
    await assert.rejects(setupHistory(f.host, f.settings, zod), /invalid/);
    assert.equal(await readFile(f.path, "utf8"), invalid);
  } finally {
    await rm(f.cwd, { recursive: true, force: true });
  }
});

test("turning history off preserves roots and curated Memory settings without contacting the cloud", async () => {
  const f = await fixture([4]);
  f.settings.apiKey = "configured-fixture";
  f.settings.apiUrl = "http://127.0.0.1:9";
  try {
    await mkdir(join(f.cwd, ".omp"));
    await writeFile(
      f.path,
      JSON.stringify({
        settings: { [PLUGIN]: { history: true, historyCloudIndex: true, historyRoots: '["src"]', autoRecall: true, retainNudge: true } },
      }),
    );
    const saved = await setupHistory(f.host, f.settings, zod);
    assert.equal(saved?.enabled, false);
    assert.deepEqual((await document(f.path)).settings[PLUGIN], {
      history: false,
      historyCloudIndex: false,
      historyRoots: '["src"]',
      autoRecall: true,
      retainNudge: true,
    });
  } finally {
    await rm(f.cwd, { recursive: true, force: true });
  }
});

test("a changed settings location requires fresh consent instead of writing an unapproved file", async () => {
  const f = await fixture([0]);
  const alternate = join(f.cwd, ".claude", "plugin-overrides.json");
  const original = JSON.stringify({ settings: { other: { value: 1 } } });
  const concurrent = JSON.stringify({ settings: { other: { value: 2 } } });
  try {
    await mkdir(join(f.cwd, ".claude"));
    await writeFile(alternate, original);
    f.state.beforeConfirm = async () => {
      await mkdir(join(f.cwd, ".omp"));
      await writeFile(f.path, concurrent);
    };
    await assert.rejects(setupHistory(f.host, f.settings, zod), /settings file changed/);
    assert.equal(await readFile(alternate, "utf8"), original);
    assert.equal(await readFile(f.path, "utf8"), concurrent);
  } finally {
    await rm(f.cwd, { recursive: true, force: true });
  }
});

test("headless and subagent contexts cannot silently enable capture", async () => {
  for (const sub of [false, true]) {
    const f = await fixture([0]);
    f.host.hasUI = sub;
    f.host.agent.kind = sub ? "sub" : "main";
    try {
      await assert.rejects(setupHistory(f.host, f.settings, zod), /interactive main/);
      assert.equal(await Bun.file(f.path).exists(), false);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  }
});

test("cloud indexing requires available prices and explicit final consent; setup itself performs no paid write", async () => {
  let served = true;
  let paidWrites = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.method !== "GET") {
        paidWrites++;
        return new Response("unexpected write", { status: 400 });
      }
      return Response.json({
        served,
        operations: [
          { id: "memory_remember", credits: 2.5 },
          { id: "memory_search", credits: 0.75 },
        ],
      });
    },
  });
  try {
    for (const scenario of ["approved", "canceled", "unavailable"] as const) {
      const f = await fixture([1, 1]);
      f.settings.apiKey = "local-catalog-fixture";
      f.settings.apiUrl = `http://127.0.0.1:${server.port}`;
      f.state.approved = scenario !== "canceled";
      served = scenario !== "unavailable";
      try {
        if (!served) await assert.rejects(setupHistory(f.host, f.settings, zod), /unavailable/);
        else {
          const saved = await setupHistory(f.host, f.settings, zod);
          assert.equal(saved?.cloudIndex ?? false, scenario === "approved");
        }
        assert.equal(await Bun.file(f.path).exists(), scenario === "approved");
        if (scenario === "approved") {
          const after = await document(f.path);
          assert.equal(after.settings[PLUGIN].historyCloudIndex, true);
          assert.equal(after.settings[PLUGIN].apiKey, undefined);
        }
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    }
    assert.equal(paidWrites, 0);
  } finally {
    await server.stop(true);
  }
});
