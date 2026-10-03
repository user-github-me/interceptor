# Privacy Policy — Interceptor

_Last updated: 2026-10-03_

Interceptor is a browser extension for inspecting and modifying the HTTP traffic
of web pages you are testing. This policy explains what it does with data.

## Short version

**Interceptor does not collect, store remotely, sell, or send your data to the
developer. Traffic analysis happens locally in your browser.** Repeater, API
Builder, Runner, and credential comparisons send requests to the target you choose
when you start them. Security Review and imports send no requests.

## What the extension accesses

To do its job, Interceptor can read and modify the network requests and responses
of the tab you attach it to (or, in Auto mode, the tab or tabs you enable). This
can include URLs, headers (such as cookies), and request/response bodies. This
information is processed **on your device**, only to:

- display traffic in the extension's own panel (HTTP history, intercept, repeater),
- apply the modifications you explicitly make or the Auto-mode rules you configure.
- inspect WebSocket frames, run response assertions, and review captured security evidence.

## What is stored

The extension automatically saves the workbench **locally on your own computer**,
in the browser profile’s IndexedDB database (`interceptor-workspace`). This covers:

- captured/imported HTTP history and bounded request/response bodies;
- Repeater drafts, responses, five snapshots per tab, and assertions;
- Collections, notes, shared variables, and named environments;
- API Builder drafts and authentication fields, response previews, and test results;
- Runner plans/results, Comparer inputs, Decoder and Inspector drafts;
- Auto logs, security observations and review status, WebSocket frame previews;
- recoverable text from paused edits, without restarting those paused sessions.

Settings and Auto-mode rules also use `chrome.storage.local`; session tab IDs and
temporary header rule IDs use `chrome.storage.session`. Earlier saved drafts and
Collections are migrated when the workbench opens. No workspace data uses browser
sync or a remote server. Local records are protected by your computer/browser
profile access controls; the extension does not separately encrypt its database.

The Workspace page downloads a full JSON backup and imports it after validation
and a restore preview. Backups include stored credentials. An optional password
encrypts backups with AES-256-GCM and a PBKDF2-SHA-256 key (200,000 iterations,
random salt and IV); backup passwords are never saved. Without a password, the
backup is readable JSON. Restoring replaces the current workspace, keeps a local
undo copy, leaves Auto mode off, and does not send traffic or attach a tab.

Exporting a collection, HAR, or Runner CSV creates a file at your request.
Collection exports omit workspace variables, but raw requests can still contain
cookies or tokens. cURL and Postman imports are parsed as data; shell commands and
Postman scripts are never executed. Security reports hide known credential query
fields and cookie values in observation evidence. Captured raw traffic remains
available locally and is included in full backups.

## What is NOT done

- No data is sent to the developer, advertisers, or analytics services.
- No analytics, tracking, or telemetry of any kind.
- No accounts, and no remote code is loaded or executed.

## Your control

You choose which tab(s) the extension attaches to. Detaching, turning Auto mode
off, and stopping Runner or a request end those operations. Clearing history,
deleting requests/environments, and clearing results/frames removes those items
from the current workspace and its next local save. The previous-restore undo copy
and downloaded files are separate copies. Uninstalling the extension or deleting
its browser profile removes extension storage; backup files you downloaded remain
where you saved them.

## Contact

Questions or concerns: open an issue at
https://github.com/user-github-me/interceptor/issues
