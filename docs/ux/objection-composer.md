# Objection composer — design doc (#84)

**Status:** Decision ready · **Owner:** Avinash · **Parent:** #50

## TL;DR

Adopt **Approach 1: single response with collapsible reasoning**. Ship it behind a feature flag so the current panel remains the fallback during the migration. Streaming (Approach 3) is a follow-up epic once the LLM client supports it. Tabs (Approach 2) are rejected — they add navigation, which is the thing we're trying to remove mid-call.

---

## Premise check (issue body is partly stale)

The issue body says the Objection flow shows a "three-agent council (retrieval / drafting / validation) in three columns." That's **not what ships today**:

- `objection-council.ts` is a **2-agent** pipeline: `retrievalAgent` → `respondAgent`. No `validation` agent runs (it exists in the `AgentName` union for the email council).
- `ObjectionPanel.tsx` already renders a **single** "Grounded response" card. There is no 3-column layout in the current sidebar.
- The 3-column UI the issue describes lives in the **email council** (`useEmailCouncil` / 4-agent flow with retrieval → ICP → brand → validation), not in the objection flow.

So the real problem to solve is narrower than the issue framing implied:

1. The response is already one-shot, **but** the reasoning (which KB sources were chosen, why) is invisible — reps either trust it blind or paste-and-pray.
2. Citations live in a **separate card** below the response, which forces a second read mid-call.
3. Confidence is a tiny stat with no breakdown.
4. There's no streaming — the rep sits on a spinner while the model thinks.

## Current state (ground truth)

**Code:**
- `extension/src/sidebar/components/ObjectionPanel.tsx` — input form → renders `lastObjection` as 3 stacked cards (objection recap, grounded response + confidence, citations).
- `extension/src/sidebar/hooks/useObjection.ts` — drives the council, sets `lastObjection` in `app-store`.
- `extension/src/shared/agents/objection-council.ts` — yields `stage` / `agent` / `done` / `error` events.
- `extension/src/shared/types/index.ts:420` — `ObjectionResponse = { summary, response, citations[], confidence }`.

**Live output shape (one panel):**

```
┌─ Objection ───────────────────────────────┐
│ "Cast.ai already does this. Why pay again?"│
└────────────────────────────────────────────┘
┌─ Grounded response · conf 87% ─────────────┐
│ <60–120 word reply text>                  │
└────────────────────────────────────────────┘
┌─ Citations (3) ────────────────────────────┐
│ battlecard_01: "quote..."                  │
│ case_study_acme: "quote..."                │
│ security_compliance: "quote..."            │
└────────────────────────────────────────────┘
[ Copy response ]
```

Already one-shot. The redesign decisions below are about **what reasoning/trust signal to layer on top**, not about merging 3 columns into 1.

---

## The three approaches

### Approach 1 — Single response with collapsible reasoning ★ recommended

**What changes:**
- Merge citation markers **inline** into the response text: `Cast.ai's automation is opinionated [1], but our council-of-agents catches off-policy drafts [2] before they reach the rep.`
- Inline marker `[1]` is a hover/tap target showing the cited quote + source name in a tooltip.
- Below the response: a single `▾ Why this answer` disclosure that expands to show retrieval picks (which 3 KB entries the retrieval agent chose, and why each was relevant).
- Confidence stays as a small chip next to the response header. Tap to see the per-citation coverage breakdown.

**Result panel (collapsed, default mid-call state):**

```
┌─ "Cast.ai already does this..." ──────────┐
└────────────────────────────────────────────┘
┌─ Reply · 87% conf ────────────────────────┐
│ Cast.ai's automation is opinionated [1],  │
│ but our council-of-agents catches off-    │
│ policy drafts [2] before they reach...    │
│                                            │
│ ▾ Why this answer (3 sources)             │
└────────────────────────────────────────────┘
[ Copy reply ]
```

**Expanded state (post-call review):**

```
│ ▴ Why this answer                          │
│ Retrieval picked:                          │
│ • battlecard_01 — direct Cast.ai compare   │
│ • case_study_acme — proves council ROI     │
│ • security_compliance — addresses re-buy   │
│ Coverage: 3/3 claims cited.                │
```

**Pros:**
- Zero new navigation. Mid-call rep reads one block.
- Inline `[1]` chips give per-claim accountability without forcing the rep to cross-reference a separate citations card.
- The disclosure is **post-call** behavior — exactly the moment when "did the AI hallucinate?" review matters.
- Data shape stays compatible with `ObjectionResponse` — only the renderer changes. No agent contract change.
- Sets the stage for streaming (Approach 3) — the inline-marker render is identical; only the source becomes a stream.

**Cons:**
- Requires the response agent to emit citation markers **inline in the response text**, not as a parallel array. Need a deterministic format the renderer can parse (e.g., `[1]` `[2]` where the number indexes `citations[]`).
- LLMs sometimes hallucinate markers or drop them. Need a renderer that gracefully degrades to "no inline chips, show citations as a flat list" when parse fails.

**Effort:** ~1–2 days. Renderer + prompt update + parse-fail fallback + flag.

---

### Approach 2 — Tabbed result (Reply / Trace)

**What changes:**
- After the response lands, the panel becomes a 2-tab view:
  - **Tab 1 — Reply:** Just the response text + copy button. No citations, no confidence drilldown.
  - **Tab 2 — Trace:** Retrieval picks, full citations with quotes, confidence breakdown.
- Default tab = Reply.

**Pros:**
- Very clean mid-call view (Tab 1 is just the response).
- Trust signal is one tap away.

**Cons:**
- **Adds navigation.** Mid-call the rep has zero willingness to click tabs to find a citation — they'll either trust blindly (bad) or paste-and-pray (also bad). The whole point of inline `[1]` chips is to keep accountability **in the response**, not behind a tab.
- Tab 2 becomes a hidden-by-default surface that won't get used until something goes wrong, at which point reps will reach for the chat transcript instead.
- Doesn't extend cleanly to streaming.

**Effort:** ~1 day. Smaller than Approach 1 because no inline marker work.

**Verdict:** **Rejected.** Solves the wrong problem — the issue isn't "the citations card is too tall," it's "the rep can't tell which claim came from which source."

---

### Approach 3 — Streamed single output with inline citations

**What changes:**
- `respondAgent` streams the response token-by-token. The renderer paints the text as it arrives.
- Inline `[1]` markers appear in-stream, identical to Approach 1.
- Below the response: same `▾ Why this answer` disclosure as Approach 1.

**Pros:**
- Best perceived performance. Rep sees text starting in ~500ms instead of waiting 4–8s for the full response.
- Subjectively reads as "Wingman is thinking *with* me" rather than "Wingman ran off and came back."
- Best UX, hands down.

**Cons:**
- **Blocked on LLM client work.** Today `client.call(system, user, maxTokens)` returns a complete string. Adding `client.stream(...)` requires per-provider streaming wiring (Anthropic SSE, Gemini SSE, Groq SSE, OpenRouter SSE, Custom OpenAI-compatible). Real work — not a UI change.
- JSON-extraction (`extractJson`) over a partial stream is non-trivial. The current prompt asks for `{summary, response, citations, confidence}` — to stream the `response` field while still emitting structured `summary` / `citations` / `confidence`, the agent contract has to change (e.g., separate prefix-marker for the prose, then a structured trailer, or two separate calls).
- The fallback story (non-streaming providers) means we still need Approach 1's renderer for parity. So Approach 3 is "Approach 1 + a streaming source," not a replacement.

**Effort:** ~5–7 days. Mostly the LLM client work; the renderer is a small delta on Approach 1.

**Verdict:** **Defer to a follow-up epic.** Worth doing, but it's not on the critical path for solving the trust/accountability problem today. Approach 1 ships first; streaming layers on top without re-doing the renderer.

---

## Pipeline contract decision

**Question from the issue:** does the council still produce 3 distinct outputs and the UI merges them, or does the council produce one merged output with internal sub-steps invisible to the UI?

**Decision:** The council already produces one merged output (`ObjectionResponse`). Keep it that way. The retrieval agent's `relevant_ids` are exposed via the existing `agent` event stream — the UI subscribes if it wants to render the retrieval picks in the disclosure. No new contract.

For inline citation markers, **extend the response agent's prompt** to inline `[N]` markers in the `response` field where N indexes `citations[N-1]`. Renderer parses on the way out. If parse fails (no markers found), fall back to the legacy citations-list rendering.

---

## Feature flag

Per the issue acceptance criteria: the original 3-card view must be feature-flag-toggleable during the migration.

- Flag: `OBJECTION_COMPOSER_V2` in `app-store` (default `true` once shipped).
- Quick Settings popover (#88) gets a developer-only toggle if needed for support. Not user-facing — reps don't need to choose UI variants.
- After 2 weeks of green telemetry (no spike in copy-then-edit, no spike in confidence-drilldown taps), remove the flag and the legacy renderer.

---

## Follow-up implementation issues (to file after approval)

1. **#84a — Prompt + parse: inline `[N]` markers** (~½ day)
   - Update `respondAgent` system prompt to require `[N]` markers in the `response` field tied to `citations[N-1]`.
   - Add a renderer-side parser that splits the response into text + marker tokens. Fallback to flat citations list on parse fail.

2. **#84b — Composer renderer + `Why this answer` disclosure** (~1 day)
   - Replace the 3-card layout with a single composer card.
   - Inline marker chips with hover/tap tooltip (quote + source name).
   - `▾ Why this answer` disclosure (retrieval picks + per-citation coverage).
   - **Must read** `~/Desktop/Personal/wingman-revamp/design-md/design-md/<active-skin>/DESIGN.md` before any chrome tokens or visual styling. The composer uses tokens from `sidebar/tokens.css` — no hardcoded slate-* classes.

3. **#84c — Feature flag + migration** (~½ day)
   - `OBJECTION_COMPOSER_V2` in `app-store`, defaults to `true`.
   - Keep legacy renderer behind the flag for 2 weeks.
   - Telemetry: copy-rate, disclosure-open-rate, time-to-copy.

4. **#84d — (Deferred epic) Streamed response** — separate ticket, blocked on LLM client `stream()` refactor across all 5 providers.

## Out of scope (explicit)

- Changing the underlying 2-agent objection pipeline shape.
- Voice / copy rewrites of objection strings (separate work; see `voice.md`).
- Adding a `validation` agent to the objection flow.
- Streaming (deferred to #84d).
- KB / objection panel chrome tokenization (already covered by #102).

## Acceptance (this issue)

- [x] Design doc committed at `docs/ux/objection-composer.md`.
- [ ] Approach 1 ratified by Avinash.
- [ ] Sub-issues #84a / #84b / #84c filed with concrete AC.
- [ ] #84 closed once sub-issues exist; implementation lives in those.
