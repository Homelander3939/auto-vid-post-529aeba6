
# Social Post Scheduling — full rewrite to match Video Upload scheduler

## Goal
A social-post schedule should behave exactly like a folder-watched video upload schedule:
- Pick **how often** it fires (every 5/10/15/30 min, hourly, daily, weekly).
- Pick **how many posts per run** (batch size).
- Optionally point it at a **local folder**; the worker pairs text files with images (like `folderWatcher.js` does for videos/captions) and publishes them.
- Each post goes through the **exact same pipeline as “Publish now”** in the Social Posts page — same uploaders (`x.js`, `linkedin.js`, `facebook.js`), same Telegram success/failure messages.

## UI — `src/components/GenerationScheduler.tsx`
Add new fields to the existing schedule card (keeps AI-prompt mode working too):

1. **Frequency tab "Interval"** (new, in addition to Hourly/Daily/Weekly):
   - Dropdown: every 5 / 10 / 15 / 20 / 30 minutes, every 1 / 2 / 3 / 6 / 12 hours.
   - Generates the appropriate cron (`*/5 * * * *`, etc.).
2. **Posts per run** numeric input (1–20, default 1).
3. **Source mode** toggle: `AI-generated` (current behaviour) vs `Local folder`.
   - When `Local folder`: folder path input + "Browse" (same control used in `FolderPostScheduler`). Helper text: "Worker will pair `.txt` captions with sibling images (.jpg/.png/.webp) using filename stems, exactly like video folders."
4. Existing Auto-publish toggle stays. For folder mode it is forced ON (no AI draft step).

## Data — Supabase
Add columns to `social_post_schedules`:
- `interval_minutes int null` (when set, scheduler ignores cron and uses N-minute polling).
- `posts_per_run int not null default 1`.
- `source_mode text not null default 'ai'` — `'ai'` | `'folder'`.
- `folder_path text null`.
- `processed_files jsonb not null default '[]'::jsonb` (folder mode: filenames already published, so we don't repost).

Migration includes GRANTs preserved from existing table.

## Backend — local worker (`server/`)
The recurring scheduler currently lives in the **edge function** `run-due-generations`, which calls `generate-social-post`. That path can't see local folders and doesn't share the publish pipeline. Move folder/interval execution to the **local worker** where the manual "Publish now" already runs:

1. **`server/socialScheduler.js`** (new) — polls `social_post_schedules` every 30 s:
   - If `source_mode='folder'` OR `interval_minutes` is set → handled locally.
   - Otherwise leave to the existing edge cron (AI-only schedules unchanged).
2. For each due schedule:
   - **Folder mode**: reuse the same pair-detection logic as `folderWatcher.scanAllFiles` but for `.txt + image` (jpg/png/webp). Take next N unprocessed pairs (N = `posts_per_run`). For each pair, build a `social_posts` row with `content = text`, `image_url = uploaded image` (upload to Supabase storage so uploaders get a URL), `target_platforms = schedule.target_platforms`, `account_selections = schedule.account_selections`, status `pending`, then call the existing `processSocialPost(postId)` used by manual publish. Append filename to `processed_files`.
   - **AI mode + interval**: call `generate-social-post` N times then immediately publish each (same as auto-publish today).
3. Telegram success/failure for every post via the existing helper used by `socialPostProcessor` — single notification per post, matching the manual-publish format.

## Backend — edge function tweak
`run-due-generations`:
- Skip schedules where `source_mode='folder'` or `interval_minutes is not null` (the local worker owns them). Keeps existing cloud cron working for pure-AI cron schedules so nothing regresses for users without a running local worker.

## Telegram parity
The local worker already calls `notifyTelegram` after manual publish. Reuse that exact function from the new scheduler so the message format is identical (✅/❌ + permalink + platform breakdown).

## Out of scope
- No new uploaders. No changes to `facebook.js` (per your prior instruction).
- No UI rewrite of the Social Posts page — only the scheduler card gets new fields.

## Files touched
- `src/components/GenerationScheduler.tsx` (UI fields)
- `src/lib/socialPosts.ts` (type + save mapping)
- `supabase/migrations/<new>.sql` (columns + GRANTs)
- `supabase/functions/run-due-generations/index.ts` (skip local-owned schedules)
- `server/socialScheduler.js` (new)
- `server/index.js` (start the new scheduler alongside the existing one)

## Confirm before I build
1. **Image upload for folder mode**: upload images to Lovable Cloud storage so uploaders fetch via URL (cleanest), vs. pass local file paths directly to uploaders (faster but only works on the local worker). Default: **Supabase storage** unless you say otherwise.
2. **"Posts per run" with folder mode**: if folder has fewer unprocessed pairs than N, publish what's available and wait for next tick — OK?
3. **Interval minimum**: 5 minutes (any lower risks rate-limits & double-runs). OK?
