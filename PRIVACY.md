# Privacy Policy — Interceptor

_Last updated: 2026-10-20_

Interceptor is a browser workbench for inspecting, reproducing, and testing HTTP
and WebSocket traffic for applications you own or are authorized to test. This
policy explains the data it handles and the controls you have over that data.

## What happens to your testing data

**The developer does not receive your testing data.** The extension collects
selected traffic for your testing workflow, processes it on your device, and
saves your work in your browser profile. There is no account, analytics,
telemetry, cloud synchronization, or developer-operated collection service.

Repeater, API Builder, Runner, and credential comparisons send the requests you
start to the target servers you choose. Intercepted or automatically rewritten
page requests continue to their intended servers when you forward them or enable
Auto mode. Those servers receive the request data and may retain it under their
own policies. Passive Security Review, decoding, comparisons of existing text,
and file imports do not send testing requests. Restoring a backup sends no
requests and does not attach the debugger.

## First use and help

Before new testing begins, Interceptor displays a local-data notice that explains
automatic saving, credentials, target requests, and backup controls. Continuing
acknowledges that notice; it does not send a request or attach a tab. The Help
entry lets you revisit these explanations and this privacy policy. Existing work
is preserved when the notice appears. A pre-acceptance recovery download preserves
the saved record for recovery; if that record is damaged, the download does not
guarantee it can be restored without repair. It is unencrypted and can contain
credentials.

## Information the extension accesses and uses

You select which tab to attach for inspection, or which tab(s) Auto mode may
operate on. The tab selector uses open-tab titles and URLs so you can identify a
testing target. The extension can read and modify the selected traffic’s URLs,
headers, cookies, request and response bodies, and WebSocket frames. Local file
inspection can include file paths when browser file access is enabled. Authentication
fields, shared variables, and environments you enter can include usernames,
passwords, access tokens, API keys, and session cookies.

Traffic, files, and drafts may contain personal information, website content,
form data, or other sensitive information depending on the applications you
choose to test and the data you enter or import. You decide which applications
and datasets to inspect. The extension does not use these data for advertising,
profiling, selling, or purposes unrelated to its debugging and testing tools.

Data is used to display and search captured traffic, edit or reproduce requests,
apply your Auto-mode rules, run response assertions, inspect fields and frames,
compare results, review security evidence, and save or restore your testing work.
Security observations guide manual testing and do not establish a vulnerability.

## Local storage

The extension automatically saves the workbench in the browser profile’s local
IndexedDB database (`interceptor-workspace`). This includes:

- captured and imported HTTP history with bounded request and response bodies;
- Repeater drafts, responses, up to five snapshots per tab, and assertions;
- Collections, request notes, shared variables, and named environments;
- API Builder drafts and authentication fields, response previews, and tests;
- Runner plans and results, Comparer inputs, Decoder and Inspector drafts;
- Auto logs, security observations and review status, WebSocket frame previews;
- recoverable text from paused edits, without restarting paused sessions.

Settings, Auto-mode rules, and pane-size preferences use `chrome.storage.local`.
Pane sizes are included in full backups. Session tab IDs and temporary request
header rule IDs use `chrome.storage.session`. Earlier saved drafts and collections
are migrated when the workbench opens. No testing workspace uses browser sync or
a remote database.

The local database is **not separately encrypted by the extension**. Its records
rely on your computer and browser-profile access controls. Other people or software
with access to that profile may be able to read stored traffic and credentials.
Optional backup encryption protects the downloaded backup file, not the local
database or requests sent to testing targets.

Requests use the transport of the target URL you choose. HTTPS encrypts the
connection to the target; HTTP does not. Use HTTPS for sensitive testing data and
keep intentional HTTP testing limited to appropriate test environments.

## Backups, imports, and exports

Workspace backups include the saved traffic, drafts, variables, authentication
fields, results, and preferences. Without a password, a full backup is readable
JSON lines with unencrypted encoded data that can expose stored credentials to
anyone who can access the file. The format processes 1 MiB chunks, with a 1 GB
workspace-JSON budget and a 1.4 GB file limit. Older plaintext JSON files remain
importable within the 1 GB budget; older encrypted envelopes have a 200 MB
compatibility limit. Device memory and browser quotas can impose lower practical
limits. Rejected imports do not replace your saved work.

A password encrypts each downloaded backup chunk with AES-256-GCM and a
PBKDF2-SHA-256 key (200,000 iterations, random salt and per-chunk IV). Backup
passwords are never saved.
The same password is required to import an encrypted file.

Imports are validated and previewed before replacement. Restoring replaces the
current workspace, keeps one local undo copy, leaves Auto mode off, and sends no
requests or debugger attachments. Restored drafts may still contain credentials.

Collection, HAR, Runner CSV, security report, and WebSocket exports create files
when you request them. Collection exports omit workspace variables, but raw
requests can still include cookies and tokens. Security reports hide known
credential query fields and cookie values in observation evidence; this is not a
guarantee that all sensitive information is removed from every export. Full
backups and raw captured traffic retain the data you inspected.

cURL and Postman imports are parsed as data. Shell commands and Postman scripts
are not executed. No remotely hosted code is loaded or executed by the extension.

## Retention and deletion

Saved testing work remains in your browser profile until you remove it, replace
it through a restore, uninstall the extension, or delete the browser profile.
Capture and preview limits may also remove older entries or truncate large
bodies and frames.

Detach or disable Auto mode to stop those operations. Stop or cancel an active
request or Runner run to end it. Clear history, delete requests/environments, and
clear results or frames to remove those items from the current workspace and its
next local save. The previous-restore undo copy is a separate retained copy.
Downloaded files are also separate; deleting data inside the extension or
uninstalling it does not delete files you downloaded. Manage or delete those
files using your computer’s file controls.

## Limited Use

Interceptor’s use of information received from Chrome extension APIs adheres to
the Chrome Web Store User Data Policy, including its Limited Use requirements.
Testing data is used only for the extension’s disclosed debugging and API/security
inspection features. The developer does not receive it, use it for advertising,
sell it, or use it to determine creditworthiness or for lending. User-started
requests are sent to the testing targets you choose to provide these features.

## Contact

Questions or concerns: open an issue at
https://github.com/user-github-me/interceptor/issues

Please remove credentials and personal data from screenshots, logs, requests,
backups, or other files before posting them publicly in an issue.
