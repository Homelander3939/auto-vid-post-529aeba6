# Local Agent Architecture for Reliable 27B Models

## Goal

Make browser operation, research, news generation, uploader control, and saved skills dependable with a local 27B-class model. The model should behave as a decision component inside a verified runtime, not as the runtime itself.

This design keeps the application local, preserves the existing SQLite data, accounts, schedules, browser profiles, uploaders, and TechNewsList/Codex primary publishing flow.

## Core principle

Small models fail when one prompt asks them to:

1. understand the whole application;
2. select from every tool;
3. remember a multi-step goal;
4. parse a large screenshot and DOM;
5. invent a plan;
6. execute it;
7. judge whether it worked; and
8. write the final answer.

The runtime must own steps 1-3 and 6-7. The model should usually do only one bounded transformation or choose one grounded next action.

## Target runtime

```text
User / Telegram / AI Chat
        |
        v
Deterministic request compiler
  - intent, entities, IDs, URL, permissions, expected output
  - read/write risk and completion contract
        |
        v
Capability router
  - exposes only 1-4 relevant tools
  - selects a saved skill or native workflow
        |
        +-------------------------------+
        |                               |
        v                               v
Browser state machine             Application workflow
  observe -> decide -> act          exact ID -> native tool
  -> verify -> checkpoint           -> refresh -> verify
        |                               |
        +---------------+---------------+
                        v
                 Evidence ledger
             exact page/source/state proof
                        |
                        v
                 Result verifier
             pass / retry / needs input
                        |
                        v
          AI Chat + Telegram + audit record
```

## Layer 1: request compiler

The compiler is deterministic code. It extracts:

- domain: browser, research, news, social, video, schedule, health, or conversation;
- operation: inspect, create, publish, retry, download, upload, or manage;
- exact entities: URL, schedule ID, job ID, post ID, platform, date, folder;
- permissions inferred from the user's explicit request;
- required outputs: exact link, email, phone, downloaded file, created record, image, article set, platform result;
- completion evidence required for each output.

The compiler never asks the model to choose an application subsystem when code can identify it.

## Layer 2: narrow tool router

Do not send the entire tool catalog to a 27B model.

Examples:

| Request | Tools exposed |
|---|---|
| Find a contact page | `run_local_browser`, `use_agent_skill` |
| Generate a social draft | `generate_social_post`, `get_fresh_app_state` |
| Retry a partial video | `retry_failed_job`, `process_pending_uploads`, `get_fresh_app_state` |
| Run a social campaign | `run_social_schedule_now`, `get_fresh_app_state` |
| Audit news fallback | `run_technewslist_fallback`, `get_fresh_app_state` |
| Ask a normal question | no tools |

Destructive tools are omitted unless the request explicitly asks for a destructive operation.

## Layer 3: browser state machine

### Observation

Every step receives:

- one fresh viewport screenshot;
- current URL and title;
- compact relevant body text;
- ranked page landmarks;
- the 20-40 controls most relevant to the current goal;
- exact discovered links;
- recent failures;
- persistent task milestones.

Controls use short references such as `E1` and links use `L1`. The model chooses a reference; code resolves the exact selector or href. A guessed selector or URL is rejected before execution.

### Decision

One model call chooses exactly one action:

`click`, `fill`, `select`, `press`, `hover`, `navigate`, `scroll`, `wait`, `upload_file`, `download`, `done`, or `failed`.

The model does not produce a long plan on every step. Milestones are stored by code and included in every turn.

### Action

Playwright executes the resolved action. Existing safety checks still control credentials, submissions, files, destructive changes, payments, account security, and human verification.

### Verification

Code compares before/after page state, handles new tabs, checks downloads, retains exact hrefs and public facts, and rejects ungrounded completion.

The next upgrade should add typed verifiers for:

- created calendar/event rows;
- submitted forms and confirmation notices;
- file upload completion;
- downloaded file existence and MIME;
- comparison tasks with evidence from every requested item;
- authenticated state without relying only on visible “logout” text.

## Layer 4: research and news evidence packets

Browser exploration and article writing must be separate workflows.

### Evidence packet schema

Each candidate story should become a durable JSON packet:

```json
{
  "topic_id": "stable-hash",
  "query": "exact research question",
  "anchor": { "title": "", "url": "", "publisher": "", "published_at": "" },
  "sources": [
    { "url": "", "domain": "", "title": "", "published_at": "", "readable_text": "", "role": "primary|independent|context" }
  ],
  "facts": [
    { "id": "F1", "claim": "", "source_urls": [""], "quote_or_span": "", "confidence": "high|medium", "time_sensitive": true }
  ],
  "images": [
    { "url": "", "source_url": "", "mime": "image/jpeg", "width": 1600, "height": 900, "score": 0 }
  ],
  "uncertainties": [],
  "quality": { "independent_domains": 2, "primary_source": true, "passed": true }
}
```

### Collector

The collector should use deterministic query templates and multiple retrieval paths. It should:

1. search for the primary announcement or original document;
2. search for current independent coverage;
3. deep-read the best pages;
4. normalize URLs and remove duplicates/tracking;
5. reject unreadable or stale sources;
6. extract claims with exact supporting spans;
7. locate contextual images and validate bytes, MIME, dimensions, and relevance;
8. save the packet before any prose generation.

PixelRAG or a similar visual index can be an optional observation adapter. It must not replace exact DOM hrefs, network responses, source text, or completion proof.

### Story selection

A deterministic selector chooses unique stories by category, recency, source quality, and normalized title. The model may rank already-qualified candidates but cannot invent candidates.

### Drafting with a 27B model

Do not ask for seven complete articles in one prompt.

For each story:

1. create a title/dek/angle from the packet;
2. draft one section at a time using only fact IDs;
3. run a structural validator;
4. run a claim-to-fact validator;
5. repair only failed sections;
6. insert verified images with source metadata;
7. generate social variants from the same packet;
8. translate only after the English article passes;
9. publish only after the exact-session proof gate passes.

The model never sees unrelated stories, account state, schedules, or browser controls while drafting.

### Quality gates

No article or social draft should be saved when:

- fewer than two independent readable domains support the central claim;
- no primary/authoritative source exists when one should exist;
- a number, date, name, or URL lacks a fact reference;
- title/topic duplicates an existing same-session story;
- required sections or images are missing;
- image bytes, MIME, size, dimensions, or contextual relevance fail;
- the generated copy contains placeholders or invented citations.

## Layer 5: skills

Skills should be recipes, not unrestricted prompt injections.

Each executable skill needs:

- exact trigger examples;
- typed required inputs;
- one allowlisted native tool or workflow;
- risk classification;
- expected output schema;
- completion verifier;
- retry policy;
- version and regression scenario.

Imported text skills remain guidance until explicitly mapped to an allowlisted local tool. At startup, the agent receives a compact index, not the full text of every skill. Full instructions are loaded only for the selected skill.

## Layer 6: model adaptation

Use one local LLM at a time. Maintain a small capability record discovered from LM Studio:

- loaded model ID;
- vision support;
- native tool-call support;
- reliable context length;
- JSON conformance rate;
- average tokens/second;
- recent timeout/error rate.

Runtime behavior adapts automatically:

- vision model: screenshot plus compact DOM;
- text-only model: DOM/accessibility observation only;
- unreliable tool parser: strict JSON fallback;
- slow model: fewer controls, smaller source packets, deterministic fast paths;
- context pressure: retrieve only relevant app state and selected skill text.

Do not load a second LLM while the first is resident.

## Layer 7: journals, recovery, and self-improvement

Every run stores:

- compiled request contract;
- selected tools/skill;
- redacted observations;
- actions and before/after hashes;
- exact evidence;
- verifier results;
- failure class;
- retry strategy;
- final delivery IDs.

The agent should learn only from verified successful runs. Repeated page-specific recoveries can be proposed as versioned skills, but they are not auto-enabled as executable code.

## Evaluation suite

A fixed local benchmark is required before claiming Codex-like usefulness:

1. extract an exact live link without reconstructing it;
2. find public contact data without returning login accounts;
3. navigate a changed menu and recover from a stale selector;
4. fill a multi-field form and verify the saved record;
5. handle a new tab, lazy content, cookie modal, and download;
6. pause correctly for CAPTCHA/OTP;
7. generate a source-grounded post with a verified image;
8. produce one complete news evidence packet;
9. draft and validate one article from that packet;
10. run a schedule by exact ID without altering its configuration;
11. retry only failed upload platforms;
12. survive backend restart from a non-secret checkpoint.

Metrics:

- task success rate;
- grounded fact/link precision;
- average model calls per completed task;
- repeated/stalled action rate;
- median wall time;
- false-success rate (must approach zero);
- user-intervention rate;
- context tokens per step.

## Delivery phases

### Phase A — completed in framework v3

- deterministic request compiler;
- narrow per-request tool routing;
- code-owned browser milestones;
- ranked compact page observations;
- E#/L# reference resolution;
- rejection of invented selectors and URLs;
- existing screenshot, state-change, exact-link, contact-fact, and safety checks retained.

### Phase B — completed in framework v3

- typed completion verifiers for forms, records, uploads, downloads, and comparisons;
- checkpoint/resume without persisting credentials;
- deterministic cookie/modal and exact-control fast paths;
- UI display of contract, current milestone, evidence, and verifier result.

### Phase C — manual research convergence completed

- shared evidence-packet module used by manual Social Posts and AI Chat/Telegram research;
- exact source-span fact ledger with name and number preservation;
- shared verified image pipeline with honest Telegram photo-delivery status;
- replayable packet fixtures for regression tests;
- the separate TechNewsList Plan B keeps its existing proof-gated publisher path and can adopt this packet contract later without changing the Codex-primary lock.

### Phase D — news state machine

- seven category candidates -> qualified unique selection -> one bounded article at a time;
- section-level drafting/repair;
- English proof gate -> translations -> social -> recap video;
- exact-session idempotency and existing Codex-primary lock preserved.

### Phase E — benchmark and adaptive runtime

- 12-scenario offline contract benchmark implemented and passing 12/12;
- isolated live-model benchmark implemented and passing 3/3 against a temporary loopback site (exact link, public contact, and verified form completion);
- Qwen 3.8 capability/context discovery records its 32,256-token loaded context without loading a second chat model;
- automatic observation sizing now expands only after stalls, rejected completions, or complex tasks and contracts again for focused work;
- per-run planner calls, action attempts, stalled actions, rejected completions, and elapsed time are recorded for verified quality reporting;
- machine-readable reports are written under `server/data/benchmarks`; a weekly aggregate can consume only verified benchmark and run records.

Verified on 2026-08-24:

- offline report: `server/data/benchmarks/local-agent-offline-contract-2026-08-24T15-53-29-608Z.json`;
- live report: `server/data/benchmarks/local-agent-live-model-2026-08-24T15-51-09-401Z.json`;
- live elapsed time: exact link 12,338 ms, public contact 10,798 ms, form completion 35,208 ms.

## Non-negotiable invariants

- local-only inference and browser execution;
- one loaded LLM at a time;
- no Git pull or package mutation at launcher startup;
- no changes to existing accounts, schedules, folders, or successful platform results;
- no duplicate publication or upload;
- no success without exact evidence;
- no browser-generated URL, identifier, date, number, or contact fact;
- Codex remains the primary TechNewsList publisher while available; Plan B activates only through its existing lock/proof gates.
