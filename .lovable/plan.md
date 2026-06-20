## Plan

1. **Fix X composer reliability**
   - Stop treating visible media previews as “still uploading” when the Post button is already usable.
   - Scope Post-button detection to the active composer/dialog so it does not grab the wrong hidden/disabled button.
   - Add a fallback click path for the exact visible bottom-right Post button shown in your screenshot.
   - Keep X text strictly below the limit before uploading media, so long generated text cannot block posting.

2. **Fix X final link capture**
   - Start listening for the CreateTweet network response before clicking Post.
   - Wait for that response long enough after the click, instead of racing it for only 100ms.
   - If the response does not contain a link, scan the logged-in profile for the matching fresh post and return only an exact `/status/...` URL.

3. **Fix Facebook success/link logic**
   - Treat “composer closed” as a possible successful post, not enough by itself.
   - Improve permalink extraction from Facebook GraphQL/network payloads, article time links, copy-link menus, and profile/page scan.
   - If Facebook posted but the link cannot be found, report that honestly as “posted but link not found” and keep files for retry instead of pretending full success.

4. **Fix cleanup truthfulness**
   - Change source-file cleanup reporting so it only says files were removed when `unlink` actually deleted them.
   - Include missing-file and failed-delete counts in Telegram summaries.
   - Keep source files whenever any selected platform fails or any confirmed post link is missing.

5. **Add diagnostic evidence for future failures**
   - On X/Facebook failure, log the current URL, visible composer text, button states, preview/busy counts, and a short page message.
   - This gives exact proof next time instead of vague “could not find button/link”.

## Technical notes

- Main files to update: `server/uploaders/x.js`, `server/uploaders/facebook.js`, `server/socialPostProcessor.js`.
- No database/backend schema changes are needed.
- The fix will keep the existing local Playwright profile architecture and will not use official platform APIs.