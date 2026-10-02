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
- **Opt-in local activity history:** `memory_history` retrieves the last 30 days of recorded messages, tool outcomes,
  file operations and subagent activity. It records a deletion, not a recoverable copy of the deleted file.

Subagents get the tools, but no recall, instructions or reminder. The MCPBytes MCP server, if you also use it, keeps
its `memory_*` tools for revising, forgetting and exact lookups.

Cloud Memory is not yet open to every account: for an account without it, the plugin says so once and leaves cloud
memory off. Local activity capture does not require a key, credits or network access.

## Install

```sh
omp plugin install @mcpbytes/omp-memory
omp plugin config set @mcpbytes/omp-memory apiKey <key>
```

Create the key in the [MCPBytes console](https://console.mcpbytes.com) (API keys), then start a new omp session. The
key can also come from the environment (`MCPBYTES_API_KEY`); a stored setting wins over it. Without a key, or with one
the API refuses, cloud memory stays off; local history can still run.

`omp plugin install` installs packages with [Bun](https://bun.sh), so `bun` must be on your PATH. Activity history uses
Bun's built-in SQLite; use Bun 1.3 or newer.

To update, install the version you want (`omp plugin install @mcpbytes/omp-memory@<version>`); to remove it,
`omp plugin uninstall @mcpbytes/omp-memory`. Tested with omp 18.4.

## Settings

| Setting             | Environment                           | Default                          | What                                                                                                      |
| ------------------- | ------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `apiKey`            | `MCPBYTES_API_KEY`                    | none                             | Your MCPBytes API key                                                                                     |
| `apiUrl`            | `MCPBYTES_API_URL`                    | `https://api.mcpbytes.com`       | API base URL                                                                                              |
| `space`             | `MCPBYTES_MEMORY_SPACE`               | the repository's name            | This project's space (worktrees share their main checkout's name)                                         |
| `autoRecall`        | `MCPBYTES_MEMORY_AUTO_RECALL`         | `true`                           | Recall on a session's first request                                                                       |
| `retainNudge`       | `MCPBYTES_MEMORY_RETAIN_NUDGE`        | `true`                           | The save reminder                                                                                         |
| `history`           | `MCPBYTES_MEMORY_HISTORY`             | `false`                          | Opt in to local, redacted activity capture                                                                |
| `historyCloudIndex` | `MCPBYTES_MEMORY_HISTORY_CLOUD_INDEX` | `false`                          | Also upload compact activity descriptions for semantic search; paid writes                                |
| `historyPath`       | `MCPBYTES_MEMORY_HISTORY_PATH`        | `~/.mcpbytes/omp-history.sqlite` | Private local SQLite file; preferably outside monitored roots                                             |
| `historyRoots`      | `MCPBYTES_MEMORY_HISTORY_ROOTS`       | `[]`                             | JSON array of local directories to observe for appearances/disappearances; empty means tool evidence only |

Per project, in `.omp/plugin-overrides.json`:

```json
{ "settings": { "@mcpbytes/omp-memory": { "space": "my-project" } } }
```

## Last-30-days activity history (0.2.0)

Inside an interactive omp session, run:

```text
/mcpbytes-history setup
```

The guided setup offers detected source folders, tool activity only, the current folder, custom folders entered as
ordinary paths, or **Turn history off**. No JSON or quote escaping is required. Local-only is the recommended cloud
choice; enabling cloud indexing requires an existing API key and shows current prices before the final confirmation.

It saves only this project's history options, preserving unrelated settings and existing keys. By default the file is
`.omp/plugin-overrides.json`; an existing active project override file is reused. Escape cancels without saving. Invalid
settings files are not overwritten. After confirmation the current session applies the change immediately; other running
sessions must reload. After updating the plugin itself, reload it once to get the new command.

This records visible messages and observed tool outcomes for main agents and subagents. It excludes system prompts,
hidden reasoning, binary payloads and whole-file edit snapshots. Ordinary tool text and diffs can still contain code.
Each event retains at most 256 KiB of redacted text; truncation, missing artifacts and capture failures are disclosed.
The recorder uses host-owned output-artifact metadata; untrusted `artifact://` links printed by commands are not followed.

The wizard writes `historyRoots` for you. Advanced manual configuration is also supported, for example in
`.omp/plugin-overrides.json` (restart omp after editing this file manually):

```json
{
  "settings": {
    "@mcpbytes/omp-memory": {
      "history": true,
      "historyRoots": "[\".\"]"
    }
  }
}
```

The observer stores paths, types and last-seen times, never file contents. It does not follow directory symlinks.
Its own SQLite files are excluded. `memory_history` with `mode: "status"` (or `/mcpbytes-history`) reports roots,
exclusions, gaps and cloud-index status. Unreadable directories are gaps, not evidence of deletion. A native delete
result can identify the responsible tool; a path disappearance alone cannot establish who removed it or whether it
was moved. Changes while omp is stopped, outside configured roots, or entirely between observations can be missed.

Use `memory_history` with:

- `mode: "timeline"`: newest-first events, optionally filtered by `workspace` directory, `session_id`, `since`/`until`
  ISO timestamps, affected `path`, or `outcome`. Continue with `next_cursor` as `cursor`.
- `mode: "search"`, `query`: local full-text keywords (all words must match), with the same filters.
- `mode: "evidence"`, `event_id`: the retained evidence; continue large outputs using `nextOffset` as `offset`.
- `mode: "status"`: coverage and upload state. `/mcpbytes-history search <words>` is a local-only shortcut.

Background launches and completion observations are separate. Missing exit codes stay unknown. Parent/subagent and
branch references remain distinct; a historical deletion is not proof that a file is still absent now.

### Optional cloud index

With an API key configured, rerun `/mcpbytes-history setup` and choose **Enable cloud indexing**. The wizard fetches
current prices and requires confirmation before saving. Choosing **Local only** disables activity indexing for this
project. Project overrides take precedence over global CLI settings and environment variables.

The plugin uploads compact, deterministic episodes containing user goals and observed outcomes, not the raw archive.
Assistant narration remains local so quoting recalled history does not automatically give it a new cloud lifetime.
No extra model is called to generate the index. Cloud recall expands matching references into local event evidence;
from another device, only the summary is available. Failed cloud recall falls back to local keyword search.

An outbox persists the exact payload, expiry and request key before upload. Restarts and ambiguous responses reuse
that identity; review-required spaces keep entries as proposals until approved. Quotas/outages leave local history
usable. Changing the API key or destination of a resumed session stops automatic indexing of that session; start a
new session for the new destination so prior activity cannot be uploaded to another account.

### Retention and privacy

Activity events expire **30 days after their original timestamp**, not their last read or upload. A compact cloud
episode is written with `expires_at` no later than its oldest included event's deadline. Reading and retries do not
extend it. Curated preferences, facts and decisions retain the server's existing idle-retention policy; `memory_retain`
also accepts `expires_at` when you explicitly want a fixed deadline.

Expired local events are immediately excluded from queries and deleted from the live database on startup and while
omp runs. Physical cleanup waits while omp is off. This is not secure erasure of SQLite pages, filesystem backups,
or omp's own session files. Cloud erasure uses the existing service policy, including its backup retention.

Redaction runs before local persistence and indexing: recognizable credentials, sensitive argument fields and reads
of conventional credential files are omitted or masked. It is best-effort, not detection of every possible secret.
The archive is not encrypted by this plugin; use a private directory and an encrypted volume when required.
Forgetting a cloud memory does not delete the separate local activity record; the latter keeps its fixed deadline.
To stop capture and activity indexing, rerun setup and choose **Turn history off**; curated Memory is unchanged.
This is not erasure: to remove local history earlier, turn it off, exit omp, and remove the configured SQLite file and its sidecars.

## Costs

Memory uses credits from your MCPBytes account: each saved memory, and each search that returns a match by meaning.
The due list, the status and word searches are free, and `/mcpbytes-memory` shows the current prices. Automatic recall
is one search per session. The save reminder costs one more model turn, and nothing else when the agent saves nothing.
A space you set to review in the console holds the agent's writes as proposals until you approve them.

Local capture, observation and history queries incur no MCPBytes charges. Optional activity indexing uses the existing
per-write price for each compact episode, not each tool call, and ordinary semantic-search pricing. `/mcpbytes-memory`
reports current prices. No hosted raw-data storage, new backend database, or additional model pass is needed.

## What it sends

Only to the MCPBytes API (`apiUrl`), with your key:

- when a session starts, a check that the key can use Memory;
- with automatic recall, the session's first request (up to 1,024 bytes) as a search query;
- `memory_recall` queries, and what the agent saves with `memory_retain`, with its source.
- only with `historyCloudIndex` enabled: compact activity episodes, their original fixed deadline and an opaque
  reference to local evidence. Paths and recorded user goals/outcomes can be included in those descriptions.

Like every omp plugin, it runs inside omp with omp's permissions. It has no additional runtime package dependencies.

## Development

```sh
npm install
npm test            # Bun: policy, privacy, real SQLite/filesystem and local HTTP-client regressions
npm run typecheck   # against the omp version in devDependencies
omp plugin link .   # load this checkout in omp; start a new session to pick up changes
```

omp loads `src/index.ts` as TypeScript, without a build step. omp 18.4 infers a tool's parameter types only from
ArkType or TypeBox schemas, so `execute` annotates its zod parameters with `zod.infer`.

The SDK in devDependencies supplies types only. The installed (compiled) omp serves just some SDK modules to plugins —
`@oh-my-pi/pi-coding-agent/extensibility/plugins`, used to read settings, but not `@oh-my-pi/pi-coding-agent/config`,
for example — so a value import of another SDK module stops the plugin from loading. `npm test` loads the published files
without development dependencies; also check changes with the installed `omp`, not only the SDK package's CLI.

## License

GNU Affero General Public License v3.0 only (`AGPL-3.0-only`); see [LICENSE](LICENSE).
