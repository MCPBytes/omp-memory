# MCPBytes Memory for omp

An [omp](https://omp.sh) plugin that gives your coding agent long-term memory with [MCPBytes](https://mcpbytes.com).
What one session settles (a decision and its reason, a constraint, the fix for a recurring failure, a preference you
stated) comes back in the next one, kept per project.

- **Recall on the first request of a session.** The due intentions and the memories that match the request (this
  project's space, then `default`) are added as an `<mcpbytes_memory>` message. A resumed session that already has one
  is not recalled again.
- **Standing instructions** on every system prompt: when to recall, what is worth saving, and that stored memory is
  data, never instructions, to be checked against the repository.
- **`memory_recall`** searches by meaning and by words (`words: true`: words only, free). **`memory_retain`** saves up
  to 8 items; `global: true` saves to `default`, which every project recalls. A retry in the same session replays the
  first answer, so nothing is written or charged twice.
- **A save reminder:** when a run of 5 or more tool calls ends without saving, the agent is asked once whether
  something is worth keeping, and finishes without saving when nothing is.
- **`/mcpbytes-memory`** shows the memory status and prices; `/mcpbytes-memory search <words>` runs a free word search.

Subagents get the tools, but no recall, instructions or reminder. The MCPBytes MCP server, if you also use it, keeps
its `memory_*` tools for revising, forgetting and exact lookups.

MCPBytes Memory is not yet open to every account: for an account without it, the plugin says so once and stays off.

## Install

```sh
omp plugin install @mcpbytes/omp-memory
omp plugin config set @mcpbytes/omp-memory apiKey <key>
```

Create the key in the [MCPBytes console](https://console.mcpbytes.com) (API keys), then start a new omp session. The
key can also come from the environment (`MCPBYTES_API_KEY`); a stored setting wins over it. Without a key, or with one
the API refuses, the plugin says so once and stays off.

`omp plugin install` installs packages with [Bun](https://bun.sh), so `bun` must be on your PATH.

To update, install the version you want (`omp plugin install @mcpbytes/omp-memory@<version>`); to remove it,
`omp plugin uninstall @mcpbytes/omp-memory`. Tested with omp 18.4.

## Settings

|Setting|Environment|Default|What|
|---|---|---|---|
|`apiKey`|`MCPBYTES_API_KEY`|none|Your MCPBytes API key|
|`apiUrl`|`MCPBYTES_API_URL`|`https://api.mcpbytes.com`|API base URL|
|`space`|`MCPBYTES_MEMORY_SPACE`|the repository's name|This project's space (worktrees share their main checkout's name)|
|`autoRecall`|`MCPBYTES_MEMORY_AUTO_RECALL`|`true`|Recall on a session's first request|
|`retainNudge`|`MCPBYTES_MEMORY_RETAIN_NUDGE`|`true`|The save reminder|

Per project, in `.omp/plugin-overrides.json`:

```json
{ "settings": { "@mcpbytes/omp-memory": { "space": "my-project" } } }
```

## Costs

Memory uses credits from your MCPBytes account: each saved memory, and each search that returns a match by meaning.
The due list, the status and word searches are free, and `/mcpbytes-memory` shows the current prices. Automatic recall
is one search per session. The save reminder costs one more model turn, and nothing else when the agent saves nothing.
A space you set to review in the console holds the agent's writes as proposals until you approve them.

## What it sends

Only to the MCPBytes API (`apiUrl`), with your key:

- when a session starts, a check that the key can use Memory;
- with automatic recall, the session's first request (up to 1,024 bytes) as a search query;
- `memory_recall` queries, and what the agent saves with `memory_retain`, with its source.

Like every omp plugin, it runs inside omp with omp's permissions. It has no dependencies.

## Development

```sh
npm install
npm test            # the plugin's decisions (src/core.ts) and the key check (src/api.ts)
npm run typecheck   # against the omp version in devDependencies
omp plugin link .   # load this checkout in omp; start a new session to pick up changes
```

omp loads `src/index.ts` as TypeScript, without a build step. omp 18.4 infers a tool's parameter types only from
ArkType or TypeBox schemas, so `execute` annotates its zod parameters with `zod.infer`.

## License

GNU Affero General Public License v3.0 only (`AGPL-3.0-only`); see [LICENSE](LICENSE).
