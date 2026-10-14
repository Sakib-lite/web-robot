# Web Robot: ZCode-Parity Audit and Roadmap

**Status:** architecture and code audit performed 2026-11-19  
**Scope:** all tracked production code in `extension/`, `backend/`, root scripts, package configuration, README, tests, and the failed PhD.com task #97.  
**Goal:** turn web-robot from a useful DOM-action prototype into a dependable, inspectable, resumable browser agent with capabilities comparable in *operating model* to ZCode browser MCP. This does not imply copying ZCode internals or bypassing browser/site security.

## Executive conclusion

The project already has valuable foundations: a typed action protocol, an extension that works in the user's logged-in Chrome, local-workspace tools, a queue, task telemetry, and unit tests. It is **not yet robust enough to promise autonomous completion of long, variable browser tasks**.

The main gap is not a single bad model. Reliability requires all of these layers to work together:

```text
Strong model + precise state + capable browser hands + workflow/recovery
  + durable memory/checkpoints + evaluation + safe controls + real-world tests
```

At present, state is lossy, the available browser tools are narrow, recovery can mistake normal reading for a loop, tasks run against whichever tab is active, and the test suite mostly tests isolated happy paths. A powerful model improves decisions, but cannot compensate for inaccessible information or missing tools.

## Evidence: why task #97 failed

Task #97 asked the agent to verify a default `New` filter, open every one of about 70 cards, collect universities, research each university, and write one Markdown file. It failed after 19 steps with:

```text
stalled: 6 consecutive chosen actions were all blocked no-ops
```

The trace establishes the following causal chain:

1. The initial observation exposed cards `e38`, `e42`, `e46`, etc.; the agent had enough evidence to click a card.
2. The filter control exposed its options but not its selected value. The model followed the prompt, attempted to inspect it through `extract`, and got only incidental text: `Select a position on the left`.
3. It reworded the same extraction several times, selected `New`, and retried instead of progressing to a card.
4. The runner groups *all* `extract` calls on an unchanged page under the same repeat key, even when their goals differ. After five calls, the extraction key is blocked; after six blocked calls, the whole task fails.
5. No row click, detail extraction, research navigation, or durable data collection occurred. The only produced file was a table header.

This was a product defect plus an unsuitable run configuration (`gemma4:26b`, low effort) for a 70-row multi-site research task—not an unavoidable site failure.

## Current architecture, accurately described

| Layer | Current implementation | Strength | Limitation |
| --- | --- | --- | --- |
| Browser residency | Chrome MV3 extension with side panel and content script | Uses existing Chrome sessions/logins | Execution target is the active tab, not a task-owned stable tab |
| Agent loop | `runTask`: observe → LLM tool call → action → observe | Typed schemas, telemetry, no arbitrary browser JS from model | One primitive action at a time; brittle loop detection; no structured state machine |
| Page observation | DOM interactive elements + first 4,000 chars of main text | Lightweight and fast | Lossy; no screenshots, bounds, selected select value, frames, shadow DOM, visual state, or structured regions |
| Page actions | Synthetic click/fill/select/key/scroll/extract | Covers simple HTML controls | No trusted input/CDP, hover, drag, upload, download, iframe targeting, clipboard write, or robust waits |
| Browser actions | navigate/new tab/switch/close | Basic navigation | `new_tab` reuses arbitrary matching existing tabs; current active tab can drift |
| Local tools | jailed HTTP filesystem + shell | Gives the agent a real deliverable workspace | Broad `exec` still needs stronger capability/scope/audit policy and task artifacts are not first-class data |
| Task backend | Postgres telemetry, queue, retry/reaper, message history | Good debug baseline | No event stream, explicit task state machine, checkpoints, leases, idempotency, artifact registry, or run evaluation |
| Planning | optional 8-step read-only planning pass | Good starting concept | Plan does not control execution; milestones are not executable/validated contracts |
| Provider layer | OpenAI-compatible / GLM / Ollama products | Flexible | No model capability negotiation, tool-call conformance checks, retry/fallback policy, or model routing by task |
| Tests | 178 extension + 42 backend tests pass | Unit coverage exists | No deterministic browser fixtures, E2E runs, benchmark suite, or regression for task #97 |

## Confirmed defects to fix first

### P0 — selected `<select>` value is absent from observations

- **Evidence:** `pageSnapshot.ts` tests whether `'value' in el`, but `valueFor()` handles inputs and textareas only; it omits `HTMLSelectElement`.
- **Effect:** the system prompt claims the selected choice is observable, but the model receives only options. In task #97, it could not verify `New`.
- **Files:** `extension/src/core/driver/pageSnapshot.ts`, `extension/src/core/driver/types.ts`, `extension/src/core/driver/pageSnapshot.test.ts`.
- **Fix:** return `el.value` for `HTMLSelectElement` and expose both selected value and selected label. Add `selectedOption` to `ElementInfo` rather than overloading `value` ambiguously.
- **Acceptance criteria:** snapshots of a select with a default-selected option contain its value and visible label; changing the select updates both; an agent can answer the selected option with no `extract` call.

### P0 — extraction loop guard is over-broad

- **Evidence:** `actionKey()` returns `extract|${state}` for every extraction, discarding `action.goal`.
- **Effect:** different reads on a static page are treated as repeated no-ops. The model is blocked even when it changes its question or reads a different section.
- **Files:** `extension/src/core/agent/loop.ts`, `extension/src/core/agent/loop.test.ts`.
- **Fix:** key extraction by normalized goal and a content/version hash, e.g. `extract|${normalizedGoal}|${stateHash}`. Do not equate a successful read with an action that must change the DOM. Block only genuinely identical reads with identical result text, and return the cached result instead of burning a turn.
- **Acceptance criteria:** two different extract goals on the same static page both run; identical goal/result is served from cache; an intentional repeat loop still terminates safely; task #97 reaches its first card click.

### P0 — the prompt promises capabilities that the snapshot does not provide

- **Evidence:** system rule 4 says a select's current choice is in the element list.
- **Effect:** the model is instructed to use missing data and wastes steps trying to recover it.
- **Files:** `extension/src/core/agent/prompts.ts`.
- **Fix:** correct the snapshot first, then rewrite the prompt to describe exact capabilities and recovery choices. Prompts must never claim unavailable tools/data.
- **Acceptance criteria:** prompt-tool-observation contract is covered by a contract test.

### P0 — action success is not semantic success

- **Evidence:** `click`, `select`, `fill`, `scroll`, and `press` return success after synthetic dispatch, without proving the intended page state occurred.
- **Effect:** the loop says it verifies effects, but it only takes another generic observation and leaves semantic comparison to the model.
- **Files:** `extension/src/core/driver/pageActions.ts`, `extension/src/core/agent/loop.ts`.
- **Fix:** attach before/after state fingerprints and action evidence (target state, URL, visible text delta, element mutation) to action results. Let actions declare expected effects where practical.
- **Acceptance criteria:** a click that does nothing is reported as `no_effect`; a card click records the selected-card/detail-panel change; model context states what changed.

### P0 — tasks are not bound to a stable tab/window

- **Evidence:** snapshot and actions call `activeTab()` on each turn. Any user focus change or app tab activation can redirect a running task.
- **Effect:** a long task may inspect one tab then act on another, potentially creating incorrect or unsafe actions.
- **Files:** `extension/src/core/background/router.ts`, `extension/src/core/driver/extensionDriver.ts`, `extension/src/core/driver/types.ts`.
- **Fix:** introduce a `BrowserSession`/task target with `tabId`, `windowId`, and navigation generation. All snapshot/action calls carry the target explicitly. User-owned tabs require an explicit attach confirmation; agent tabs are task-owned.
- **Acceptance criteria:** changing Chrome focus during a task does not change its target; closed/replaced tab errors are recoverable and visible; all telemetry records tab ID.

### P0 — task #97 has no fit-for-purpose workflow

- **Evidence:** its scope combines list enumeration, 70 card interactions, deduplication, web research, source evaluation, and report writing in one undifferentiated loop.
- **Effect:** a local model must infer batching and checkpointing itself; partial work is nearly useless.
- **Fix:** add a first-class `collection/research/report` workflow with durable item queues and checkpoints. See the workflow section below.
- **Acceptance criteria:** after interruption, a rerun resumes at the next unprocessed university without duplicating rows or losing completed research.

## Browser observation: required upgrades

### 1. Make the snapshot a structured accessibility tree, not a flat list

The current first-80 interactive-elements list loses containment. A model cannot reliably tell whether a checkbox, tiny button, and row title belong together.

- Add stable node IDs, parent/child relationships, role, accessible name, text/value/checked/selected/disabled/expanded state, bounding box, and visibility/enabled metadata.
- Preserve semantic regions: header, nav, main, dialog, list, list item, table, row, grid, form, detail pane.
- Include relationships such as `labelledby`, `describedby`, form ownership, list position, and item count where available.
- Give row containers an actionable representation even when the actual click listener sits on a non-semantic `div`.
- Add a targetable `inspect_element(ref)` that returns relevant subtree text, attributes, and descendants without flooding the model context.
- Add `find_elements({role, name, text, selector-safe pattern})` with deterministic results and no arbitrary page script.

### 2. Improve page text and targeted extraction

- Replace the current keyword-neighbor extractor with selectable scopes: `main`, `visible`, `element subtree`, `selector/role query`, `article`, `table`, `dialog`, and `page`.
- Return source node references with extracted text, so a model can act on the text it read.
- Include text after interaction even when it appears beyond the first 4,000 characters.
- Support pagination/windowing of text, not only interactive elements.
- Support table/list extraction into structured rows and columns.
- Cache reads by scope + node/content hash, not merely page state.
- Detect virtualized lists and expose logical item counts, scroll ranges, and currently rendered range.

### 3. Add visual grounding

- Add screenshot capture of the viewport and element crops, with an optional vision model path.
- Send screenshots only when DOM state is insufficient or the site is canvas-heavy; control cost with explicit budgets.
- Include target bounding boxes and screenshot coordinates.
- Add OCR fallback for image-only/canvas content.
- Support “compare before/after screenshot” for actions whose DOM does not change visibly in accessible text.

### 4. Cover real web topology

- Enumerate and target same-origin and permitted cross-origin iframes with `frameId`/frame path.
- Traverse open shadow roots; report inaccessible closed roots explicitly.
- Surface dialogs, popovers, toast messages, loading spinners, cookie banners, and permissions prompts as state.
- Detect common anti-automation/login/CAPTCHA states and call `ask_user` with a precise handoff, rather than retrying.
- Handle SPA route transitions and hydration; wait for stability rather than fixed sleeps.

## Browser control: required upgrades

### 1. Expand the primitive tool set

Add typed, validated tools rather than relying on text prompts to simulate them:

- `click`, `double_click`, `right_click`, `hover`, `focus`, `blur`.
- `type` with keystrokes, `clear`, `select_all`, keyboard shortcuts, and key chords.
- `check`/`uncheck`, radio selection, date picker support, slider/select support.
- `scroll_into_view`, element/container scroll, `drag_and_drop`.
- `wait_for({url, text, element, network_idle, dom_stable, download, timeout})`.
- `open_url`, `search_web`, `open_search_result`; do not force the model to fabricate search-engine URLs.
- `upload_file` only through explicit user-approved local paths; `download` with metadata and user-visible destination.
- `read_clipboard`/`write_clipboard` with explicit permissions and audit.
- `save_page`, `print_to_pdf`, and structured data export where appropriate.

### 2. Improve interaction fidelity

Synthetic DOM events work for basic forms but are not trusted browser input. Add an optional, explicit “power mode” using `chrome.debugger`/CDP where Chrome policy permits it.

- Use CDP for trusted pointer/keyboard events, file chooser workflows, downloads, network/page lifecycle events, and screenshots.
- Keep the current content-script driver as safe default.
- Make power mode user-visible and permission-gated.
- Fall back cleanly when a site or browser policy prevents debugger attachment.
- Never implement hidden anti-bot evasion; report site restrictions honestly.

### 3. Make navigation deterministic

- Every browser action must be scoped to the task’s `BrowserSession`, never the incidental active tab.
- Do not reuse an arbitrary existing tab simply because its URL matches; reuse only a tab owned by the same task or explicitly attached by the user.
- Wait for navigation completion (`tabs.onUpdated` / document ready + stable state) instead of fixed 600/1500ms sleeps.
- Track navigation ID/document generation so stale refs are rejected precisely.
- Implement safe back/forward/reload tools with a reason and state checkpoint.
- Maintain an owned-tab graph and preserve/release tabs according to a user-configurable policy.

## Agent runtime: required upgrades

### 1. Replace generic repeat counting with action-aware recovery

Not all successful actions must mutate the page. Reads, notes, wait-for, and file writes are valid on a static page.

- Classify actions: **read**, **navigation**, **interaction**, **filesystem**, **terminal**, **control**.
- Define no-op per class: e.g. a read is a no-op only if same request returns same data and the agent had no new plan; an interaction is a no-op if target/effect fingerprint is unchanged.
- Include full normalized action arguments in the repeat key, including extract goal and scope.
- Let the model receive a concise “why blocked + available alternatives” recovery card.
- After a configurable number of failures, run a dedicated recovery policy/model prompt rather than immediately failing the entire task.
- Preserve partial results and return `done` with blockers whenever feasible.

### 2. Turn plans into executable state machines

The optional planner currently proposes prose milestones; the runner does not enforce or validate them.

- Model plans should produce typed milestones with inputs, expected outputs, completion predicates, risks, and retry policy.
- Persist plan status, item progress, tool evidence, and artifacts after every milestone.
- Permit subtask decomposition: enumerate → normalize/dedupe → enrich → validate → render report.
- Only expose tools needed for the current milestone (tool narrowing reduces wrong actions).
- Require the agent to checkpoint before crossing a site, navigation, or destructive boundary.
- Add an explicit policy for scope changes: ask user if research scale, cost, or external effect exceeds the original request.

### 3. Add robust memory and artifacts

Current notes are plain prompt text capped at 30 entries; they are not a queryable task database.

- Store observations, extracted facts, sources, entities, item states, errors, and report sections as typed task artifacts.
- Give facts provenance: source URL, timestamp, screenshot/DOM node, confidence, extraction method, and item ID.
- Use an entity store for normalized universities, programs, countries, deadlines, English requirements, and duplicates.
- Use content hashes and idempotency keys to make retries safe.
- Produce files incrementally but treat them as rendered output, not the only source of truth.
- Allow agent searches over task memory: `list_items`, `get_item`, `query_facts`, `mark_item_done`, `record_source`.
- Persist a compact resumable state snapshot so a reaper/retry does not depend on re-reading a giant `PLAN.md`.

### 4. Add model routing and tool-call quality gates

- Maintain model capability profiles: structured tool calling, vision, long context, browser reliability, cost, latency, and reasoning support.
- Run provider-specific tool-call conformance tests, not merely a single round-trip.
- Do not assume an Ollama model honors `reasoning_effort`; expose it as best-effort and record actual support.
- Route simple extraction to a fast model and long planning/recovery to a strong reasoning model.
- Add fallback: malformed tools, repeated empty replies, or low-confidence plans can escalate to another configured model after user-approved policy.
- Record model/version/provider settings per step so failures are reproducible.
- Use structured tool-call repair once for malformed JSON, then fail clearly; do not silently reinterpret unsafe actions.

### 5. Give the agent bounded parallelism

Do not open 70 research tabs at once. Use a scheduler with bounded concurrency.

- Enumerate and dedupe items first.
- Research 3–5 items concurrently only when sources are independent and tab/session policy allows it.
- Keep one main application tab separate from research tabs.
- Merge facts deterministically by item ID.
- Use a global time/token/request budget and show forecast before expensive runs.

## Research and data-quality system

The PhD task is a data-collection workflow, not merely a browser-clicking task. It requires a research subsystem.

- Add `search_web(query, domains?, recency?)` backed by a deliberate provider/API or controlled browser search; results must include title, URL, snippet, and source rank.
- Prefer official university/graduate-school/program pages; distinguish department/program/university policy pages.
- Define a schema per research item: university, campus, program, degree, intake/term, application deadline, English requirements/test-specific thresholds, funding notes, source URLs, date accessed, and `unknown/not found` states.
- Separate position-specific deadlines from general admission deadlines; never merge them without a label.
- Resolve duplicates/aliases (`ISTA`, Institute of Science and Technology Austria) before research.
- Capture publication/applicability date and term. Deadlines are time-sensitive facts.
- Require one or more attributable source URLs for every asserted datum. Never fill gaps with model memory.
- Flag ambiguity for user decision instead of guessing which program or degree applies.
- Add a final validator that finds missing fields, conflicting dates, stale sources, and duplicate universities.
- Render a Markdown/CSV/JSON report from the structured store, with a source column and a “not verified” status.

## Task lifecycle, queue, and backend upgrades

### 1. Implement a real task state machine

Current statuses are free-form strings across UI/backend/queue. Define and validate transitions:

```text
created → queued → claimed → planning → running → waiting_for_user
                                      ↘ checkpointing ↗
running → recovering → running
running → completed | completed_partial | failed | cancelled | expired
```

- Enforce transitions transactionally in the backend.
- Add a lease ID and lease expiry to claims. Heartbeats must renew the lease, not only update an in-memory map.
- Make queue claims durable across backend restarts and multiple backend instances; do not rely on the in-memory `queue` array as the source of truth.
- Persist worker identity, browser capability set, task target session, and recovery attempt count.
- Make `continue`, `retry`, `kill`, and reaping idempotent and race-safe.

### 2. Replace polling-only coordination where helpful

- Keep polling as fallback, but provide SSE/WebSocket task event streaming to side panel/CLI.
- Display structured live events: observation, decision, action, effect, checkpoint, artifact, warning, ask-user.
- Keep full raw debug trace for engineers, but create a concise causal failure report for users.
- Add event sampling/redaction/retention limits so telemetry does not store needless sensitive page text indefinitely.

### 3. Make recovery real

README claims an auto re-investigation/resume behavior that is not evident in the current `runTask` implementation. Treat documentation and implementation as a contract.

- On failure, run a bounded diagnostic phase: identify failed milestone, last state, artifacts, and alternative actions.
- Resume only from a durable checkpoint and only when preconditions still hold.
- Give the recovery agent reduced scope and exact evidence; do not restart from the original giant prompt.
- After recovery budget is exhausted, produce a partial report, artifact links, and a specific next user action.
- Add task replay/simulation from saved observations for regression debugging.

## Safety, privacy, and permissions

The project has good beginnings—danger-word confirmation and a jailed workspace—but a serious browser agent needs policy beyond button-name matching.

- Replace regex-only danger detection with action risk classes based on element role, form semantics, destination/domain, upload/download, permission prompts, payment/account changes, publication, deletion, and irreversibility.
- Require explicit confirmation with a structured preview for sending/posting/submitting, purchasing, deleting, granting permissions, uploading local data, and changing security/account settings.
- Add domain allowlists/denylists and per-task domain scopes; the user should see when the task expands to a new domain.
- Default research tabs to read-only behavior; separate “browse” capability from “act” capability.
- Redact passwords, session tokens, API keys, personal identifiers, and sensitive page fields before prompts and telemetry. Current page text and full LLM messages can capture private material.
- Encrypt secrets at rest where possible; avoid passing API keys through broad backend telemetry paths.
- Add audit entries for all external side effects and workspace writes, including before/after hashes.
- Implement artifact download scanning/confirmation and file-extension policy.
- Provide a prominent emergency stop that cancels the run and revokes task-owned tab control immediately.
- Document that web-site terms, CAPTCHAs, and anti-bot policies are not bypassed.

## Workspace / local execution hardening

- Keep the path jail, symlink checks, output limits, and read-before-edit behavior.
- Make filesystem permissions capability-scoped per task: read-only, write-report-only, or terminal-enabled—not a global on/off toggle.
- Allowlist command families or use isolated task containers for `exec`; a deny list cannot cover all destructive/network exfiltration combinations.
- Set CPU, memory, process-count, disk, network, and wall-time limits for terminal commands.
- Capture exit code, stdout/stderr separately, working directory, file changes, and content hashes.
- Make delete a confirmation-gated capability except inside an explicitly disposable task scratch directory.
- Add explicit atomic write / journaled artifact output to prevent partial Markdown reports after crash.
- Treat skills and contexts as untrusted prompt input; identify their provenance/version and require user approval for newly created skills before automatic use.

## UI/UX needed for dependable autonomy

- Let a user choose the target tab/window before run and show a locked target badge while running.
- Display current milestone, item progress (`17/64 universities`), current website, recent evidence, budget, and next intended action.
- Show screenshots/DOM target highlight before high-risk actions.
- Distinguish: completed, completed with gaps, blocked awaiting user, recoverable failure, and terminal failure.
- Add review/edit of an execution plan with scope/budget estimates before launch.
- Offer “collect only”, “research only”, and “report only” run modes for long workflows.
- Let users pause/resume safely at checkpoints rather than only stop/restart.
- Show generated artifacts in-panel with links, versions, and a download/export action.
- Make ask-user contextual: show page screenshot, failing field, and safe answer choices rather than a bare browser `window.prompt`.
- Add a failure inspector that highlights the failed action, observation diff, LLM decision, and suggested retry strategy.

## Testing, evaluation, and observability

Green unit tests are necessary but insufficient. `pnpm test` currently passes (178 extension tests and 42 backend tests at audit time); it does not demonstrate real-agent reliability.

### Required test layers

1. **Contract tests**
   - Tool schema ↔ protocol ↔ driver ↔ prompt contract.
   - Every field mentioned in a prompt must be observable/tool-accessible.
   - Snapshot tests for select, checkbox, radio, disabled state, dialogs, rows, virtual lists, iframes, and SPA transitions.

2. **Driver fixture tests**
   - Local fixture pages for list/detail layouts, React controlled forms, virtualized lists, lazy loading, modals, shadow DOM, iframe content, downloads, and route changes.
   - Test semantic success/no-effect detection, not only dispatched event success.

3. **End-to-end extension tests**
   - Run a packaged extension in a controlled Chrome profile against fixture sites.
   - Verify task-bound tabs, crash/reload recovery, workspace artifacts, confirmation gates, and target isolation.

4. **Agent benchmark suite**
   - Create named tasks with gold artifacts: collect 20 list items, filter verification, multi-page extraction, form draft without submission, research with citations, interruption/resume, and misleading-page prompt injection.
   - Track completion, partial completion, harmful actions, tool errors, retries, step count, latency, cost, and citation accuracy by model/provider/version.

5. **Regression cases**
   - Task #97 must become a fixture and benchmark.
   - Add a test for the exact sequence: default selected `New` → enumerate rows → click card → detail panel → append checkpoint → duplicate university normalization.

6. **Production observability**
   - Correlation IDs across task, run, worker, tab session, model request, action, and artifact.
   - Metrics for action effect rate, stale-ref rate, repeated-action blocks, task completion/partial completion, recovery success, unsafe-action prompts, cost, and queue latency.
   - Privacy-preserving trace sampling and an engineer-only redacted replay viewer.

## Documentation corrections

Update `README.md` so it matches actual code and product guarantees.

- It says the default step limit is 40; `loop.ts` currently sets 400.
- It describes effect-based verification more strongly than the implementation provides.
- It lists `tabs()` as an agent tool, but the model is given tab data in observation rather than a `tabs` tool definition.
- It claims milestone `PLAN.md` maintenance and automatic failure re-investigation/resume; verify/implement before claiming them.
- It claims task directory/skill behavior that needs contract tests and explicit backend evidence.
- Document current limitations: active-tab targeting, DOM-only interaction, synthetic events, no vision/CDP/iframe support, and model-dependent function calling.

## Recommended implementation order

### Phase 0 — stop known bad failures (1–3 days)

1. Fix select selected-value capture.
2. Fix extraction repeat keys and read caching.
3. Bind a run to a selected tab ID; record it in telemetry.
4. Add semantic action/effect fingerprints and deterministic waits.
5. Create the task #97 fixture/regression test.
6. Correct README claims to match implemented behavior.

**Exit bar:** agent can reliably operate the list/detail fixture, preserve partial data, and cannot drift onto a user-changed active tab.

### Phase 1 — reliable workflows (1–2 weeks)

1. Typed task state machine, leases, durable queue claims, checkpoints, and resume.
2. Structured task artifact/entity store and incremental report renderer.
3. Executable milestone planner and tool narrowing.
4. Collection/research/report workflow with dedupe and bounded concurrency.
5. Model capability profiles, conformance tests, high-quality default model routing, and fallback/recovery.
6. UI for target tab, progress, pause, evidence, and partial completion.

**Exit bar:** a 70-item collection task can survive reload/interruption, resume without duplicate work, and produce a sourced partial report if a subset fails.

### Phase 2 — browser MCP depth (2–4 weeks)

1. Accessibility-tree/subtree inspection, text/list/table scopes, frames, shadow roots, virtual-list handling.
2. Wait conditions, hover/drag/container scroll, upload/download policy.
3. Optional screenshot/vision path and element screenshots.
4. Optional CDP power mode with explicit consent and fallback.
5. Search provider and source-quality/citation system.

**Exit bar:** common modern SPAs, detail panes, paginated/virtualized lists, and research tasks work with evidence and controlled recovery.

### Phase 3 — production hardening (continuous)

1. E2E Chrome tests and benchmark gating in CI.
2. Risk-policy engine, redaction, domain scopes, and side-effect audit.
3. Command isolation/capability scoping.
4. Streaming events, replay, metrics, and operational dashboards.
5. Cost/time budgets and user-visible forecasts.

**Exit bar:** releases are measured against benchmark regression budgets, failures are explainable, and the user retains control over sensitive actions.

## Exact workflow for the original PhD task after Phase 1

```text
Milestone 1: Attach to the PhD tab; observe filter state and set New only if needed.
Milestone 2: Enumerate all 70 rows; click each card; record university/campus/position evidence.
Milestone 3: Normalize and deduplicate universities; write a checkpointed `universities.json`.
Milestone 4: For each unique university/program, search official sources; record cited admission facts.
Milestone 5: Validate missing/ambiguous/conflicting facts; mark unknowns explicitly.
Milestone 6: Render `phd-admissions.md` and `phd-admissions.csv` with source URLs and coverage.
```

Run it in two user-visible passes by default:

1. **Collect and deduplicate only** — complete the list before leaving PhD.com.
2. **Research and report** — bounded batches, citations, resumable checkpoints.

The user should choose whether general university admissions information is sufficient or each position/program must be researched; those are materially different scopes.

## Definition of done for “works like ZCode browser MCP”

Web-robot should only make that claim when it can demonstrate all of the following:

- Stable task-owned browser session, not incidental active-tab control.
- Reliable structured observation plus visual fallback.
- Rich, typed, effect-verified browser tools with correct waits.
- Durable plans, artifacts, checkpoints, resume, and safe partial completion.
- Strong-model routing with verified tool-call behavior and recovery/fallback.
- Search/research workflows with provenance and data validation.
- Explicit policy and confirmation for external side effects and sensitive data.
- Chrome E2E and benchmark evidence showing reliability on representative real workflows.
- Trace/replay tooling that explains failure in terms a user can act on.

Until then, position it accurately as an **experimental autonomous Chrome extension for supervised, bounded browser tasks**, not an all-purpose ZCode-equivalent agent.
