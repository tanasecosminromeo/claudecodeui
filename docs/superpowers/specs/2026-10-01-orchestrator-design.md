# Orchestrator: local-LLM tasks configured from CloudCLI

Date: 2026-10-01
Status: approved design, awaiting spec review

## Goal

A new **Orchestrator** settings tab, next to Voice, that configures CloudCLI's
connection to the local Gemma (llama.cpp, `llama-cpp:8090`) and a set of
**tasks** that use it. Two tasks ship first:

1. **Spoken summary**: the "Summarised" read-aloud text. Today its prompt and
   limits are hardcoded in `~/Work/llama.cpp/docker/tts/server.py`. They move
   into CloudCLI and are edited from the tab.
2. **Session title**: automatically names sessions `{emoji} {clear goal}`,
   where the emoji is the session's current phase (with a hover tooltip) and
   follows the session as it moves from planning to implementing to testing.

### Decisions made with the user

| Question | Decision |
|---|---|
| When to rename | Automatically after the first exchange, then re-evaluated every N turns. Never overwrite a name the user typed. |
| Where the summary runs | Moved into CloudCLI. The TTS container goes back to speech only. |
| Emoji categories | A fixed list in code, not editable in the UI. |
| Which sessions | All active sessions CloudCLI sees new turns in, across every provider, terminal-started ones included. Old idle sessions are left alone. |

### Not in scope

- Writing the generated name back to the provider transcript (for example a
  Claude `custom-title` line). The name lives in CloudCLI's database only.
- Per-user settings. There is one Gemma, so the settings apply to the whole
  server.
- Editing the category list from the UI.

## Architecture

A new server module, `server/modules/orchestrator/`, owns:

- **Settings**: one JSON document in the existing `app_config` table under
  key `orchestrator`, read and written through the module's REST routes.
  Missing fields fall back to the defaults below, so the stored document can
  be partial.
- **LLM client**: OpenAI-compatible `POST {baseUrl}/chat/completions` with
  `chat_template_kwargs: {enable_thinking: false}` (Gemma otherwise spends
  `max_tokens` on thinking before the answer starts).
- **Queue**: requests run one at a time, because Gemma has a single slot that
  nanobot shares. A session-title job for a session that already has a title
  job waiting is dropped, not queued twice.
- **Tasks**: one file per task (`summary.task.ts`, `session-title.task.ts`).
  Each holds its default prompt, builds its messages, and parses the reply.

Units and their dependencies:

| Unit | Does | Depends on |
|---|---|---|
| `orchestrator-settings.service` | Read and merge settings over defaults; validate and save | `app_config` repository |
| `llm-client` | One chat completion with timeout; normalised errors | `fetch` (injected) |
| `llm-queue` | Serialise calls; drop duplicate keyed jobs | nothing |
| `summary.task` | Word budget, prompt, call | settings, queue, client |
| `session-title.task` | Context selection, prompt, JSON parse, name formatting | settings, queue, client |
| `session-title.scheduler` | Decides when a session is due and runs the task | sessions repository, session-upsert events, task |
| `orchestrator.routes` | REST for settings, connection test, "Try it", manual rename | the above |

### Settings document

```jsonc
{
  "connection": {
    "baseUrl": "http://127.0.0.1:8090/v1", // default: ORCHESTRATOR_LLM_URL env, else this
    "model": "",                            // empty = server's loaded model
    "apiKey": "",
    "timeoutMs": 60000
  },
  "tasks": {
    "summary": {
      "enabled": true,
      "prompt": "<default below>",          // placeholder: {words}
      "maxWords": 120,
      "autoMinChars": 700,                  // read-aloud summarises replies longer than this
      "forceMinChars": 200,                 // "Summarised" returns the text as is below this
      "maxInputChars": 12000,
      "temperature": 0.3
    },
    "sessionTitle": {
      "enabled": true,
      "prompt": "<default below>",
      "reevaluateEveryTurns": 6,
      "maxInputChars": 8000,
      "temperature": 0.2
    }
  }
}
```

Validation on save: `baseUrl` must be http(s) and not link-local
(`169.254.*`), the same rule the voice module uses. Numbers are clamped to
sane ranges (for example `reevaluateEveryTurns` 1 to 100). A prompt must
not be empty. An empty prompt in the UI means "use the default", which
"Reset to default" sets.

`apiKey` is never returned by the GET route. The route returns
`apiKeySet: true|false` instead, and a save that omits `apiKey` keeps the
stored one.

## Task 1: spoken summary

### Default prompt

The current TTS prompt, with `{language}` replaced by an instruction to keep
the reply's language. The TTS container already picks the Romanian or English
Piper voice from the text it receives, so CloudCLI does not need to detect the
language.

```
You turn a chat reply into what a voice assistant says out loud.
Write in the same language as the reply. Write at most {words} words of plain
spoken sentences. Say what was done and what the result is, touching every
part of the reply briefly rather than only the first. Mention a step for the
listener only if the reply explicitly asks them to do it; never turn something
the reply says is already done into an instruction. Do not add facts.
Never read out file paths, URLs, commands, code, hashes or symbols: name the
thing instead ("the proxy script", "the test suite"). No lists, no markdown,
no headings, no preamble such as "Here is a summary".
```

### Word budget

Unchanged from today: `max(25, min(maxWords, wordCount(speechText) / 3))`,
where `speechText` is the reply with markdown stripped. `max_tokens` is
`words * 3`. The input is cut to `maxInputChars`.

### Call sites

- `POST /api/voice/summary`: calls the summary task, then returns the same
  response shape as today. Text shorter than `forceMinChars` is returned
  unchanged.
- `POST /api/voice/tts`: when the text is longer than `autoMinChars` and the
  task is enabled, it is summarised first and the summary is sent to the TTS
  backend.

### Failures

- `/summary` returns an error (502 with a readable message) and the UI shows it
  as it does today.
- `/tts` falls back to synthesising the full text. Reading the whole reply is
  better than reading nothing.
- Task disabled: `/summary` returns 409 "Summaries are turned off in
  Orchestrator settings"; `/tts` reads the full text.

### Changes in `~/Work/llama.cpp`

Remove `SUMMARY_PROMPT`, `summary_word_budget`, `llm_summarize`, the summary
paths and the automatic summary inside the speech endpoint from
`docker/tts/server.py`, and the summary passthrough from
`docker/stt-proxy/proxy.py`. Drop the `TTS_LLM_URL` and `TTS_SUMMARY_*`
environment variables from the compose file. Update its tests and
`CHANGELOG.md`, then run `docker compose restart tts stt`. That repo is never
committed by Claude.

This change ships **after** the CloudCLI side is deployed, so read-aloud never
loses its summary in between.

## Task 2: session title

### Categories (fixed)

| Key | Emoji | Tooltip label | Hint given to Gemma |
|---|---|---|---|
| `investigating` | 🔍 | Investigating | reading code or docs to understand something |
| `debugging` | 🐛 | Debugging | finding the cause of a bug or failure |
| `planning` | 📋 | Planning | designing, writing specs or plans, choosing an approach |
| `implementing` | 🔨 | Implementing | writing or changing code for a feature or fix |
| `testing` | 🧪 | Testing | writing or running tests, verifying behaviour |
| `refactoring` | ♻️ | Refactoring | restructuring code without changing behaviour |
| `docs` | 📝 | Docs | writing documentation, READMEs, notes |
| `deploying` | 🚀 | Deploying | releases, deploys, infrastructure, CI |
| `discussing` | 💬 | Discussing | questions, explanations, conversation without changes |

The list lives in a shared module (`src/shared/sessionCategories.ts`) used by
both the server (prompt, parsing) and the client (tooltip).

### Name format

`{emoji} {title}`, for example `🔨 Add Orchestrator settings tab`. The emoji is
part of `custom_name`, so it shows wherever the name shows, search included.
The title is trimmed, has no trailing period, has no surrounding quotes, and is
at most 60 characters (cut at a word boundary).

### Default prompt

```
You name coding-assistant sessions. Read the conversation and reply with JSON
only: {"category": "<key>", "title": "<title>"}.
category is the phase the session is in NOW, judged mostly by the latest
messages. One of:
{categories}
title states the session's goal in 3 to 8 words, imperative, specific
("Add Orchestrator settings tab", not "Working on settings"). No emoji, no
trailing period, no quotes. Use the conversation's language.
```

`{categories}` expands to one `- key: hint` line per category.

### Context sent to Gemma

The first user message, then as many of the most recent messages as fit in
`maxInputChars`, oldest first, each as `User:` / `Assistant:` text. Tool calls
and tool output are left out; only the text of each message is kept.

### Parsing

The reply must parse as JSON with a known `category` and a non-empty `title`.
Code fences around the JSON are stripped first. Anything else is discarded and
the session's name is left as it was. There is no retry; the next due turn
tries again.

### Who owns the name

A new column, `sessions.name_source TEXT NULL`:

| Value | Set when | Auto-rename may overwrite |
|---|---|---|
| `user` | Renamed in the CloudCLI UI (`PUT /api/providers/sessions/:id`), or the transcript has a `custom-title` entry (a terminal `/rename`) | No |
| `auto` | Written by the session-title task | Yes |
| `provider` | Name taken from the provider during sync (Claude `ai-title`, last prompt, Codex or other provider titles) | Yes |
| `NULL` | Rows that existed before this change | No (treated as `user`) |

Synchronizers set `provider` when they create or rename a row from provider
data. They set `user` when the Claude transcript's chosen title came from
`custom-title`. They never change a row whose source is `user` or `auto`.

A second column, `sessions.titled_at_turn INTEGER NULL`, records the turn count
when the task last wrote the name.

### When it runs

The scheduler subscribes to the server-side session-upsert path, which fires
for both the on-disk watcher (terminal sessions) and the chat run registry
(web sessions). For each upsert it (re)starts a 20-second idle timer for that
session, so it never runs mid-turn. When the timer fires:

1. Skip if the task is disabled, the session is archived, or `name_source` is
   `user` or `NULL`.
2. Count turns. A turn is one user message followed by an assistant reply.
3. Run if `titled_at_turn` is NULL and turns ≥ 1, or if
   `turns - titled_at_turn ≥ reevaluateEveryTurns`.
4. On success, write `custom_name`, `name_source = 'auto'` and
   `titled_at_turn = turns`, then broadcast the session upsert so open
   sidebars update. Skip the write if the name is unchanged.

The scheduler's own broadcast must not restart the idle timer in a loop. Writes
it makes are ignored by the scheduler (the turn count did not change, so step 3
does not fire anyway, and the timer handler is a no-op).

Old idle sessions are never touched, because nothing upserts them.

### Manual rename

A "Rename with Gemma" item in the session menu calls
`POST /api/orchestrator/sessions/:sessionId/title`. It runs the task now,
whatever the `name_source`, and on success sets `name_source = 'auto'`. This is
how an existing session, or one the user named, opts in to auto-renaming. The
item is hidden when the task is disabled.

### Tooltip

The sidebar session row and the chat header render the name through a small
component, `SessionName`. If the name starts with an emoji from the category
list followed by a space, the emoji is wrapped in
`<span title="Implementing" aria-label="Implementing">🔨</span>`. Other names
render unchanged.

## REST API

All routes require the normal authenticated session.

| Method and path | Purpose |
|---|---|
| `GET /api/orchestrator/settings` | Merged settings, `apiKey` replaced by `apiKeySet`, plus `defaults` (default prompts and numbers) for "Reset to default" |
| `PUT /api/orchestrator/settings` | Validate and save; returns the merged settings |
| `POST /api/orchestrator/test` | One tiny completion; returns `{ok, model, latencyMs}` or the error |
| `POST /api/orchestrator/tasks/:task/try` | Run `summary` on `{text}` or `sessionTitle` on `{sessionId}`; returns the result without saving anything |
| `POST /api/orchestrator/sessions/:sessionId/title` | Manual rename (see above) |

## UI: Orchestrator tab

Added to the settings tab list after Voice, with the same layout conventions
and i18n keys under `settings.orchestrator.*` (English strings only; other
locales fall back).

- **Connection** card: base URL, model, API key (password field, placeholder
  shows when one is set), timeout, and a **Test** button that shows the model
  name and latency, or the error.
- **Spoken summary** card: enable switch, prompt textarea with **Reset to
  default**, the five numeric fields, and **Try it** (a textarea of sample
  text, then shows the summary).
- **Session title** card: enable switch, prompt textarea with **Reset to
  default**, "Re-evaluate every N turns", max input chars, temperature, the
  category list shown read-only, and **Try it** (pick a recent session, shows
  the name it would get).

Saves happen on an explicit **Save** button per card. Unsaved changes are
marked.

## Testing

Unit tests (Node test runner, matching the existing `server/modules/*/tests`):

- settings: merge over defaults, validation and clamping, `apiKey` hidden and
  preserved.
- queue: one at a time, duplicate keyed job dropped, a failing job does not
  block the next.
- summary task: word budget values, prompt contents, short-text passthrough.
- session-title task: context selection under `maxInputChars`, JSON parsing
  (fenced, invalid, unknown category, empty title), name formatting and the
  60-character cut.
- scheduler: due-turn rule, each `name_source` value, archived and disabled
  skips, idle timer reset, no loop on its own broadcast.
- voice routes: `/summary` and `/tts` use the task; `/tts` falls back to full
  text on failure.

E2E scenarios with the real Gemma (`make e2e`):

- The Orchestrator tab saves settings, and they survive a reload.
- A new session gets an emoji name after its first exchange, and hovering the
  emoji shows the category label.
- A session renamed by the user keeps its name after more turns.
- "Rename with Gemma" renames a session on demand.
- Existing scenarios 21 (Romanian read-aloud) and 22 (spoken summary) still
  pass after the summary moves.

## Dependency on uncommitted work

The `/api/voice/summary` route and `summarizeSpeech` service this design
changes are, as of 2026-10-02, staged but not committed on `main`
(`server/modules/voice/voice.routes.ts`, `voice.service.ts` and their test).
This branch starts from `main`'s last commit, so that work must be committed
to `main` and merged into this branch before the summary part is implemented.
The session-title part does not depend on it.
