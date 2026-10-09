# /btw side panel

Date: 2026-10-09
Status: approved in conversation, awaiting spec review

## Problem

`/btw` answers a side question about the open session without touching it,
but the answer arrives in a modal (`CommandResultModal`). While it is open the
main chat cannot be used, the answer is gone once the modal closes, and there
is no way to take a useful answer further.

## Goals

1. `/btw` questions and answers live in a panel on the right that can be
   toggled, and the main chat stays fully usable while it is open or while an
   answer is pending.
2. The panel keeps every earlier `/btw` of the session, across reloads,
   server restarts and devices.
3. Any answer can start a new session: a new chat in the same project whose
   composer holds the question, the answer, and where it came from, ready for
   the user to add an instruction and send.

## Non-goals

- Providers other than Claude (`/btw` is Claude-only today; unchanged).
- Forking the main conversation into the new session. The new session starts
  fresh; it is told where the original transcript is and reads it if needed.
- Linking the started session back to the entry in the UI.
- Editing or deleting individual entries.

## Design

### Storage

New table, created in `schema.ts` and added by a migration in `migrations.ts`:

```sql
CREATE TABLE IF NOT EXISTS side_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,          -- app-facing session id
    question TEXT NOT NULL,
    answer TEXT,                       -- NULL until answered
    status TEXT NOT NULL,              -- 'pending' | 'answered' | 'failed'
    source TEXT,                       -- 'live' | 'fork' once answered
    error TEXT,                        -- message when failed
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    answered_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_side_questions_session ON side_questions(session_id, id);
```

Repository `server/modules/database/repositories/side-questions.db.ts`:
`create`, `markAnswered`, `markFailed`, `listBySession`,
`failPending(reason)`, `deleteBySession`.

No foreign key to `sessions`: `/btw` also works on a provider-native id the
indexer has not stored yet, and that insert must not fail. The session delete
path calls `deleteBySession` instead.

On server start, any row still `pending` is marked `failed` with
"Interrupted by a server restart" — its answer can never arrive.

Outcomes that are not questions asked (`empty_question`, `no_context`,
`unsupported`) are not stored; they come back to the composer as today's
inline messages.

### Server flow

`sideQuestionService.ask` (`server/modules/commands/side-question.service.ts`)
gains a repository dependency:

1. Validate as today (`empty_question`, `no_context`, `unsupported`).
2. Insert a `pending` row and return its id to the caller **immediately**.
3. Ask the provider in the background (live `askSideQuestion` on the running
   process, else the one-shot fork — unchanged), then `markAnswered` /
   `markFailed`.
4. Broadcast `{ type: 'side-question-updated', sessionId, entry }` on the
   websocket to the owning user for steps 2 and 3, so every open tab updates
   without polling.

The `/btw` built-in handler returns `{ action: 'btw', data: { entry } }`
right away instead of waiting for the answer.

New route: `GET /api/sessions/:sessionId/side-questions` → entries, oldest
first. Same auth as the other session routes.

### Client

New module `src/modules/side-questions/`:

- `useSideQuestions(sessionId)` — loads the list, applies websocket updates,
  exposes `ask(question)` (calls the existing `/api/commands/execute` with
  `/btw`, so both entry points share one path).
- `SideQuestionsPanel` — header with title and close; entries oldest to
  newest; each entry shows the question, then "Answering…", the answer
  rendered as markdown, or the error; Copy and Start session buttons on
  answered entries; an input box at the bottom (Enter sends, Shift+Enter
  newline). Scrolls to the newest entry when one is added.
- Open/closed state persisted per user in local storage (like the quick
  settings pin).

Layout: the panel docks to the right of the main chat region inside
`ProjectWorkspaceShell`, the same way the pinned Quick Settings panel does,
with a fixed default width. On mobile it is a full-screen sheet with a close
button.

Toggle: a button in the chat header with the number of entries for the
session; shown only for Claude sessions.

`/btw <question>` typed in the main composer:
- still runs immediately, even mid-turn (unchanged);
- opens the panel if it is closed, and the entry appears there as pending;
- no longer opens `CommandResultModal`. The modal's `btw` branch and
  `SideQuestionContent` are removed, along with the Escape-key exception in
  `ChatInterface.tsx` that existed only for that modal.

Switching sessions switches the panel's list to that session; a new chat with
no session id shows an empty panel whose input explains that the first
message has to be sent before `/btw` works.

### Start session

Clicking Start session on an answered entry:

1. Calls the existing new-session flow for the entry's project
   (`handleNewSession` in `useProjectsState.ts`).
2. Writes the seed into that project's new-chat draft (scope
   `project:<projectId>`, via the existing drafts API). If that draft already
   has text, the seed goes first and the existing text is kept below it.
3. Focuses the composer with the caret at the end. Nothing is sent.

Seed text:

```
Started from a side question in session "<session title>" (<session id>).
Its transcript is at <jsonl path> — read it if you need more context.

Question: <question>

Answer:
<answer>
```

The transcript path is the session row's `jsonl_path`; the list endpoint
returns it alongside the entries so the client does not need a second call.
If the session has no transcript path yet, that line is left out.

## Error handling

- Provider failure → entry `failed` with the provider's message; a Retry
  button on failed entries asks the same question again as a new entry.
- Server restart mid-answer → `failed`, "Interrupted by a server restart".
- Websocket missed (tab asleep) → the list is refetched when the panel opens,
  when the session changes and when the socket reconnects.
- Deleting a session deletes its entries (`deleteBySession` in the session
  delete path).

## Testing

Unit:
- repository: create/answer/fail/list order, `failPending`,
  `deleteBySession`;
- service: returns the pending entry before the provider resolves, marks
  answered/failed, broadcasts both, does not store `empty_question` /
  `no_context` / `unsupported`;
- route: list shape includes the transcript path;
- client: panel renders pending/answered/failed, websocket update replaces a
  pending entry, `/btw` in the composer opens the panel and no modal, Start
  session builds the seed and keeps an existing draft below it.

E2E (custom/e2e/scenarios, Haiku):
- ask `/btw` while a turn is running, type and send in the main composer
  while the answer is pending, then see the answer in the panel and the main
  turn's reply intact (replaces the current `/btw` modal scenario);
- reload: the panel still lists the entries;
- Start session: lands in a new chat whose composer holds the seed with the
  original session id and transcript path.
