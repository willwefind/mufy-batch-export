# Mufy Batch Export

[简体中文](README.zh-CN.md) · [Full Chinese Guide](README.zh-CN.full.md)

An open-source, privacy-conscious toolkit for **exporting, preserving, reading, and migrating your own Mufy data**.

It started as a userscript for batch-exporting conversations and has grown into a practical archive toolkit: Markdown/JSON backups, EPUB books, SillyTavern-compatible JSONL, persona and character-card export, archive recovery tools, and a local reader.

> **Unofficial project.** This repository is not affiliated with Mufy. It reads data available to your own logged-in account through the same web APIs used by the site. Site-side API changes may break the tool.
>
> **Privacy:** processing is local in your browser. Your exported conversations are not uploaded to this project's servers.
>
> 🔞 **For adult users. Please do not distribute this tool or the target site's address to minors.**

## Why this exists

Mufy's built-in export flow is designed around individual archives. That becomes painful when you have many characters, many saved sessions, or conversations you want to preserve outside a platform account.

This project is built around a simple principle: **if the data belongs to your own account, you should be able to keep a durable copy of it in ordinary, portable formats.**

It also tries hard not to create false confidence. Real user reports have uncovered cases where:

- a character disappears after being made private while its conversation data still exists;
- a character card is removed but past conversations remain exportable;
- very large sessions hit browser memory or string-size limits;
- a service-side migration leaves fewer messages than an API-reported total;
- mobile browsers silently block later downloads in a batch;
- an apparently successful partial export is actually incomplete.

When the tool can detect one of those cases, it reports it instead of silently pretending the backup is complete.

## What it can do

| Feature | What you get |
|---|---|
| **Batch conversation export** | Export one character or many characters at once |
| **Portable backups** | Markdown + raw JSON, with an index and the character greeting |
| **EPUB export** | One readable ebook per character, generated directly in the browser |
| **SillyTavern migration** | Conversation `.jsonl` files for importing past chats |
| **Persona export** | Export your persona/mask library as readable text + raw data |
| **Own character-card export** | Human-readable fields, raw JSON, avatar/cover images, and regex entries |
| **Archive health check** | Check whether cards still resolve and whether conversation records are still present |
| **Recovery helpers** | Recover conversations whose character card disappeared when you still have the relevant conversation keys |
| **Huge-session split export** | Stream extremely large sessions into smaller files instead of loading the entire session into memory |
| **Cross-device use** | Desktop, iPhone/iPad, and Android workflows are documented and have been exercised by real users |

### Output formats

- **ZIP / Markdown + raw JSON** — the archival format; best when preservation matters.
- **Merged Markdown** — one long readable file per character.
- **EPUB** — the reading format; convenient for Apple Books, WeRead, Moon+ Reader, etc.
- **SillyTavern JSONL** — for migrating conversation history into compatible frontends.

## Reader: Our Dialogues

For reading exported archives, the recommended reader is now **[Our Dialogues](https://github.com/willwefind/our-dialogues)** — a separate, more complete local-first conversation library.

**Online version:** https://willwefind.github.io/our-dialogues/

It can keep Mufy exports together with official ChatGPT and Claude exports, and includes local library storage, full-text search, bookmarks, annotations, reading progress, favorites/tags, and EPUB/Markdown/single-file HTML export.

The original lightweight Mufy reader is still available and will remain supported for people who prefer it:

https://willwefind.github.io/mufy-batch-export/mufy-reader.html

Both readers are front-end only: your archive stays on your device.

## Quick start

### Desktop: Chrome / Edge + Tampermonkey

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. On recent Chromium browsers, make sure **Allow user scripts** is enabled for Tampermonkey in the extension details page.
3. Install the userscript:

   https://raw.githubusercontent.com/willwefind/mufy-batch-export/main/mufy-batch-export.user.js

4. Open Mufy while logged in and enter any character chat page.
5. Click **⬇ Batch Export** in the lower-left corner.
6. Choose what to export and the output format.

For iPhone/iPad, Android, troubleshooting, recovery, huge archives, and detailed explanations of every option, see the **[full Chinese guide](README.zh-CN.full.md)**. It is intentionally much more detailed and written for non-technical users.

## Privacy & security model

The userscript needs access to the authentication state already present in your browser; otherwise it could not read your own account data.

The important boundary is where that credential goes:

- it is used only for requests to Mufy's own APIs;
- this project has no analytics backend for your archive;
- exported conversations are generated locally;
- no third-party runtime library is required for the core ZIP exporter;
- source code is public so the behavior can be independently inspected.

Do not trust a userscript merely because its author says it is safe. Review the source yourself, or have someone you trust review it before running it in an authenticated browser session.

## Reliability philosophy

This project is maintained from **real user failures, not only happy-path demos**.

Changes are commonly driven by reports from iOS, Android, desktop browsers, unusually large archives, deleted/private cards, and incomplete historical records. Fixes are tested against real accounts where possible and backed by regression checks for cases such as pagination, duplicate detection, export integrity, filename collisions, large-session behavior, and privacy-sensitive output.

The commit history deliberately records wrong assumptions and reversals as well as fixes. If evidence contradicts an earlier explanation, the documentation is corrected rather than preserving a cleaner-looking story.

## Project status

- Public since **August 6, 2026**.
- Reached **181 GitHub stars in its first 24 days**.
- Actively maintained from real user feedback.
- Current userscript series: **v1.52** at the time this README was introduced.
- Licensed under **AGPL-3.0**.

The repository is still young and the target site's APIs are not under this project's control. Breakage after site updates is possible; reports that include the visible error and the affected workflow are especially useful.

## Repository map

| File | Purpose |
|---|---|
| `mufy-batch-export.user.js` | Public userscript |
| `mufy-reader.html` | Original lightweight local reader |
| `make-epub.py` | Convert previously exported ZIP archives to EPUB |
| `find-keys-in-history.py` | Local helper for finding conversation keys in browser history |
| `find-keys-in-history.md` | Beginner-friendly guide for the history helper |
| `README.zh-CN.md` | Chinese project overview with the recommended reader first |
| `README.zh-CN.full.md` | Full Chinese documentation and troubleshooting guide |
| `LICENSE` | AGPL-3.0 license text |

## Contributing / reporting problems

Bug reports are most useful when they describe:

- device + browser;
- userscript version shown in the export panel;
- what export scope/output mode you selected;
- the exact visible error or final log message;
- whether the same content is still visible on Mufy's own UI.

**Please do not post private conversation text, session IDs, login tokens, or other account secrets in public issues.** Redact them first.

## License

GNU Affero General Public License v3.0 — see [`LICENSE`](LICENSE).
