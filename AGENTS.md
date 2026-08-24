# Repository publication contract

After completing user-approved application code changes in this repository:

1. Run the relevant tests and production build.
2. Review the staged file list and scan it for credentials.
3. Commit the source changes to the current branch.
4. Push the commit to `origin` before reporting completion.

Never commit `.env` files, API keys, access tokens, SQLite databases, browser
profiles, account sessions, logs, generated media, backups, or files under
`server/data`. Never store a GitHub token in a remote URL or launcher. Git and
package update operations must remain outside application startup scripts.
