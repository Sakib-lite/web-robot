# WebRobot


<img width="1200" height="779" alt="screen_recording_2_small" src="https://github.com/user-attachments/assets/c272e495-dab4-4c46-80cc-19de6a7be592" />

Autonomous browser agent for Chrome. Tell it a task in plain language — it opens pages, clicks, fills forms, extracts information, and reports back, deciding each next step on its own. Works in your real Chrome with your existing logins. Any OpenAI-compatible LLM can drive it.

## Structure

- `extension/` — Chrome extension (MV3): side panel agent loop, content-script page driver
- `backend/` — NestJS debug API: stores every run in Postgres (`web_robot` db) and serves the full trace per task
- `frontend/` — reserved (Next.js, if a web UI lands later)

## Development

```
pnpm install
pnpm backend    # NestJS telemetry API on :3010 (Postgres at PGHOST, db auto-created)
pnpm dev        # load extension/.output/chrome-mv3 as unpacked in Chrome
pnpm test       # all workspace tests
pnpm build
```

Every task run is recorded in Postgres when the backend is up (default `http://127.0.0.1:3010`, configurable in Settings → Debug backend). After a run, the panel shows a `trace:` id with a link to the debug JSON, or fetch it yourself:

```
curl http://127.0.0.1:3010/tasks/<task-id>/debug
curl "http://127.0.0.1:3010/tasks?limit=20"
```

The debug report contains the task summary, a chronological timeline (page observations with DOM elements, the exact LLM messages and responses, each action with args/result, user answers), and a `failures` list (failed actions, LLM errors, the final failure reason).

LLM access is configured per machine. Copy the env template and fill in your key before building — the value is inlined into the bundle at build time:

```
cp extension/.env.example extension/.env
# edit extension/.env
pnpm build
```

The `.env` file is gitignored. Alternatively, configure providers with API keys in the side panel Settings tab: any OpenAI-compatible endpoint works (base URL, API key, model). GLM endpoints get `thinking` and higher `max_tokens` automatically.

---

# Architecture

## The big picture

web-robot is a **four-layer pipeline**. The LLM never touches a browser directly — it returns JSON tool calls, and extension code executes them. The model is the decision maker; the extension is the hands and eyes.

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. USER + SIDE PANEL (React, long-lived)                            │
│    task input · run/stop · step timeline · provider settings        │
│    runs the agent loop:                                              │
│        observe → ask the LLM → act → verify → repeat                 │
└──────────────┬──────────────────────────────────────────────────────┘
               │ typed messages (chrome.runtime)
┌──────────────▼──────────────────────────────────────────────────────┐
│ 2. BACKGROUND SERVICE WORKER (router only)                           │
│    • tab list / active tab lookup                                    │
│    • browser-level actions: goto, new/switch/close tab               │
│    • injects the content script on demand (chrome.scripting)        │
│    • URL guard: only http/https/about:blank are navigable           │
└──────────────┬──────────────────────────────────────────────────────┘
               │ typed messages (chrome.tabs)
┌──────────────▼──────────────────────────────────────────────────────┐
│ 3. CONTENT SCRIPT (per tab, re-injected after navigation)           │
│    • snapshot: numbered interactive elements + main-content text    │
│    • actions: click, fill (native setter), select, press, scroll    │
│    • extract: returns the page's main content as data               │
└──────────────┬──────────────────────────────────────────────────────┘
               │ JSON over HTTPS (OpenAI-compatible /chat/completions)
┌──────────────▼──────────────────────────────────────────────────────┐
│ 4. LLM PROVIDER (any OpenAI-compatible endpoint)                     │
│    GLM (Z.ai coding / BigModel), OpenRouter, OpenAI, …               │
│    sees: task + step history + latest observation                    │
│    returns: exactly one tool call per turn                           │
└─────────────────────────────────────────────────────────────────────┘
```

### Key design decisions (the "why")

| Decision | Rationale |
|---|---|
| Extension, not a desktop app driving Chrome over CDP | Chrome 136+ ignores remote-debugging flags on the default profile, so external tools cannot drive your real logged-in Chrome. An extension lives inside it and uses your real sessions. |
| Agent loop in the side panel, not the service worker | The service worker is ephemeral (killed when idle). A visible side panel keeps the run alive and gives the user live steps, a stop button, and result output. |
| Model returns JSON actions, never code | No `eval`, no remote code (MV3 forbids it anyway). Every action is validated by a Zod schema before it executes — a hallucinated tool call fails safely. |
| One action per cycle, then re-observe | The classic agent failure mode is acting twice on stale state. After every action the loop takes a fresh observation, and the next decision is made from evidence. |
| Snapshot-first, text from `<main>` | The model needs the page's actual content, not the surrounding nav noise. Elements come from the DOM; page text comes from `main`/`[role=main]`/`article` first, so a 4000-char budget contains real content. |
| Short op budget + loop detection | Fail fast, then re-observe and rebuild — never retry the same thing blindly. URLs are normalized (`?a=1&b=2` ≡ `?b=2&a=1`) so pagination ping-pong is caught within repeats, not after 15 steps. |
| Danger gate in code, not prompt | Clicks on submit/pay/delete-style buttons pause for user confirmation. A page that tries to talk the model into submitting cannot bypass it — the gate is enforced by the loop, outside the model's reach. |

## The agent loop

Each turn, the LLM receives: the **task**, a **one-line summary of every step so far**, any **user answers**, the accumulated **extracted content** (latest in full, older as snippets), and the **current observation** — never old snapshots (stale and huge; this is the biggest cost/quality lever).

The observation looks like:

```
CURRENT PAGE:
url: https://github.com/Sakib-lite?tab=repositories
title: Sakib-lite (Sakibul Anwar) · GitHub
tabs:
* [7] Repositories https://github.com/…
elements:
[e1] link "Sakib-lite"
[e3] button "Next"
[e5] textbox "Search"
page text (truncated):
Repositories 27 … web-robot Autonomous browser agent…
```

Tools the model can call:

```
goto(url)  new_tab(url?)  switch_tab(id)  close_tab(id)  tabs()
click(ref)  fill(ref, text)  select(ref, option)  press(key)
scroll(dir, amount?)  extract(goal)  wait(ms ≤ 5000)  snapshot()
ask_user(question)  done(summary, data?)  fail(reason)
```

Plus, when the backend workspace is enabled, local-hands tools (see below):

```
list_dir(path?)  read_file(path, offset?, limit?)  write_file(path, content)
edit_file(path, old_string, new_string, replace_all?)  append_file(path, text)
delete_path(path)  mkdir(path)  exec(cmd, timeout_ms?)
```

Loop rules enforced in code:

1. **Refs are only valid in the latest observation.** `e3` after another action means nothing — the model must use the fresh ids.
2. **Effect-based verification.** A click "worked" iff the expected state change appears in the next observation — never inferred from the absence of errors.
3. **Step limit** (default 40) — then `fail` with the partial step log.
4. **Loop detection**: the same action on an unchanged page nudges at 3 repeats ("choose a different approach"), fails at 5.
5. **Extract accumulates.** Listing tasks collect each page's content; the model reports the whole set in `done`.
6. **Escalation ladder**: retry → different path → `ask_user` (the panel shows a prompt dialog) — never silent spinning.
7. **Untrusted page content.** Text from pages is data for locating things, never instructions. Only the user's task directs the agent.
8. **Danger gate**: submit/pay/delete/post-style clicks require an explicit user yes before executing.
9. **Read-before-edit** (workspace files): `edit_file` and overwriting an existing file are refused until the model has `read_file`d it — blind edits are impossible by construction.

## Local workspace (the agent's hands outside the browser)

The extension is sandboxed, so local file/command access rides on the backend: a workspace module jails every fs op and shell command to one root folder (`WEB_ROBOT_WORKSPACE`, default `~/robots`). The extension talks to it through a `LocalPlane` interface (`extension/src/core/local/`) — an HTTP transport today, native messaging later if the backend dependency is ever unwanted.

- **Path jail**: all paths are workspace-relative (`research/notes.md`); `..` escapes, absolute paths, and symlink escapes are rejected server-side.
- **exec**: `bash --noprofile --norc` with cwd pinned inside the workspace, per-command timeout, output capped head+tail (8 KB), and a deny-list for the catastrophic classics (`sudo`, `curl | sh`, `rm -rf /`, `~/.ssh`, …). Everything else runs without permission prompts — that is the point.
- **Token discipline**: reads are paginated numbered lines ("lines 12–111 of 3,412"), edits return the changed line instead of the file, and only the latest read/exec result stays in context. Append, don't rewrite.
- **Kill switch**: `node scripts/run-task.mjs --ws on|off` (or Settings → Workspace tools) disables the whole plane server-side; the file tools vanish from the model's toolset on the next run.
- **Audit**: every fs/exec call lands in the existing `actions` table with full args — visible in `/tasks/:id/debug`.

### Resilience, milestones, skills, tabs (built on top of the workspace)

- **Milestone plans**: multi-step runs keep a `PLAN.md` (`.web-robot/tasks/<id>/`) — milestones the model maintains via `update_plan`, findings auto-appended from every `note`. Written by loop code, not extra LLM turns.
- **Failure re-investigation**: before any run is accepted as failed (model give-up, step limit, stall, LLM error), one verdict call can `resume` it with a concrete next instruction and a fresh 25-step budget (max 2 rounds). Partial beats failing.
- **Zombie reaper + resume-on-reclaim**: workers heartbeat `busy` + `currentTask` during runs; a running task whose runner stops heartbeating is requeued after ~90s (3 interruptions → failed with the reason) and the next claim **resumes from PLAN.md** instead of restarting. `POST /tasks/:id/retry` requeues any failed/stopped task with its plan.
- **Single-flight**: claims are marked busy the instant a task is handed out, so the service worker and panel never run two tasks in parallel.
- **Skills**: `skills/<slug>/SKILL.md` in the workspace (frontmatter: `name`, `description`, optional `model`/`effort`/`maxSteps`) — picked from a dropdown next to the task input (or `/slug` inline); the body is injected as the run's preamble. The agent can author skills itself with `write_file`.
- **Tab ownership**: agent-opened tabs are marked `(agent)` in observations, capped at 6 (oldest closed automatically), and closed when the task ends.

Design details and the roadmap are in `docs/rnd-local-agentic-worker.md`.

## Page access layer

The content script is the eyes and hands inside the tab:

- **Snapshot** — walks the DOM for interactive elements (`a, button, input, select, textarea, summary, [contenteditable], [role], [onclick]`), filters to visible ones, caps at 80, numbers them `e1…eN` in DOM order. Each entry carries kind (link/button/textbox/select/checkbox/radio), an accessible name (aria-label → label element → text → placeholder → title), current value (passwords masked), and select options.
- **`fill` uses the native value setter** (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`) followed by synthetic `input` + `change` events — the only sequence React/Vue-controlled inputs actually observe.
- **`press` dispatches key events**, and Enter inside a form calls `requestSubmit()` — matching what a real browser does.
- **`extract` returns the text of the main content region** (up to 6000 chars) — real data flows back into the model context instead of "observation taken".
- Re-injection: the script is registered for all URLs at `document_idle`, and the background re-injects it on demand for tabs that were already open before it loaded.

`chrome.debugger` (full CDP: trusted input events, file uploads, downloads) is a planned optional power mode behind the same driver interface — not needed for the current tool set.

## LLM provider layer

Ported from a proven multi-provider pattern: a provider registry with exactly one **active** row, stored in `chrome.storage.local`:

```
{ id, name, baseUrl, apiKey, model, visionModel?, active }
```

- Any OpenAI-compatible `/chat/completions` endpoint works.
- **Model slots** (`main`, `fast`, `vision`) let callers speak in generic GLM slot names; under a foreign provider those names refill with that provider's own model, so every call site works unchanged after switching.
- **GLM quirks are sniffed** from URL/model: GLM endpoints get the `thinking` parameter and the full `max_tokens` budget; OpenAI-style endpoints omit `thinking` and clamp `max_tokens` to 16384 (they hard-reject higher values).
- **Precedence**: a build-time `.env`-seeded provider (gitignored, inlined by Vite) wins while set; otherwise the active stored provider; otherwise none.
- The Settings tab has a **test button** that runs a real tool-call round-trip against the configured provider — connection + function calling verified in one click.

## Repository layout

```
extension/src/
  core/
    llm/         providers, model slots, glm quirks, chat client, env seed
    agent/       tool schemas (Zod), prompts, the decision loop
    driver/      snapshot builder, page actions, driver interface
    messaging/   typed panel ↔ background ↔ content protocol
    storage/     chrome.storage wrapper with in-memory test double
  entrypoints/
    background.ts      service worker router
    content.ts         per-tab snapshot + actions
    sidepanel/         React UI (task runner, provider settings)
```

Every layer is unit-tested with fakes (85 tests): the loop runs against a scripted LLM and an in-memory driver; the snapshot/action code runs against a DOM implementation; the router runs against fake `chrome.tabs`/`chrome.scripting`. `pnpm test` covers all of it.
