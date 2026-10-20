# Changelog

## 1.1.1 — 2026-10-20

### Added

- First-use/update disclosure of automatic local traffic and credential storage, with affirmative continuation and existing-workspace recovery.
- Installed Help/privacy guidance for capture, Auto scope, active requests, debugger access, local storage and backups.
- Bounded chunked JSON-lines backups with optional authenticated AES-256-GCM encryption, progress, integrity verification and legacy JSON compatibility.
- A design proposal for password-protected local storage; the current database remains unencrypted.

### Improved

- Removed redundant `tabs` permission after browser checks of tab selection, Auto mode, workbench focus and HTTP/HTTPS/file attachment.
- Restricted messages and ports to expected extension pages, validated temporary header rules and tracked dashboard ownership across closure/restart.
- Clearer API Builder authentication fields and compact editors that leave more space for response assertions.
- Updated title, summary, privacy/permission guidance, workflow screenshots and recommended 128px icon padding.
- Release packaging derives its version from the manifest and includes new local runtime helpers.

### Fixed

- Local-file history no longer prevents reopening or restoring a workspace; active API requests remain HTTP(S) only.
- Backups above the former 200 MB ceiling round-trip in the bounded format, including encryption overhead.
- Import reads cannot race; canceling prevents late previews, and passwords clear after success or failure.
- Missing/revoked disclosure acceptance disables saved Auto and prevents silent restart after acknowledgment.
- Backup chunks yield through queued tasks, avoiding Chrome’s background timer throttling.
- Rule cleanup preserves other dashboards' active rules and removes orphaned rules on restart.

## 1.1.0 — 2026-10-03

### Added

- Draggable, keyboard-accessible dividers across split tools, with separate wide/stacked sizes saved locally, full-backup support, and layout reset.
- Reproducible runtime-only ZIP and signed CRX packaging with signature, identity, payload and checksum verification.
- Site Map grouped by origin, method, and path with counts, statuses, average timings, query fields, History links, and endpoint export.
- Inspector for repeated query/form fields, exact JSON values, cookies, response headers, and cookie attributes.
- Payload Runner with sequential sends, delays, timeouts, stop/cancel, response-text checks, result comparison, replay, and CSV export.
- Collections with names, folders, notes, assertions, Interceptor/Postman import, export, and shared `{{variables}}`.
- API Builder with HTTP methods, JSON/form/raw bodies, Bearer/Basic/API key authentication, cURL export, and response assertions.
- Declarative status/header/JSON Pointer/body/timing/size assertions in Builder, Repeater, Collections, and Runner, plus boundary payload presets.
- Passive Security Review for transport, headers, CSP, framing, CORS, cookie flags, caching, URL credentials, and detailed error exposure; review/ignore status and report export.
- Same-origin GET/HEAD/OPTIONS comparison with and without credential headers, cancellation, and response diff.
- Passive WebSocket text/binary frame inspection, filtering, decoding, and export.
- Automatic local IndexedDB persistence for the complete workbench, named environments, recovered paused text, full backup/restore with preview and undo, and optional AES-GCM password encryption.
- GitHub feature issues linked to the v1.1 PR, a contribution guide, bug/feature issue forms, a PR template, and automated syntax/regression checks for contributions.
- cURL import, Repeater duplication, request timeouts, five response snapshots per tab, and compare-previous.
- Hex encode/decode, SHA-256/SHA-512 hashing, and a keyboard tool switcher (⌘/Ctrl+K).

- URL include/exclude safety scope for automatic field rewriting.
- HAR import and method, status, type, URL, header, and body filtering.
- Side-by-side response Comparer with JSON normalization and unified diff export.
- Local Decoder for JSON, URL encoding, Base64, HTML entities, and JWT inspection.
- Dependency-free Node tests for the HTTP engine and analysis helpers.

### Improved

- Shortcut hints, button tooltips, and accessible shortcut metadata use Command on macOS and Ctrl on Windows/Linux, detected from the browser platform.
- Refined dark and light themes, navigation, spacing, empty states, keyboard focus, and narrow-screen layouts.
- JSON display and Decoder formatting preserve large numeric values exactly.
- JSON and query rewrites preserve unrelated source formatting, encoding, and large numbers.
- Multipart rules skip file uploads and match form field names exactly.
- Repeater response reads and HTTP history now have bounded memory use.
- Workspace data is saved on the user’s PC by default, including history, response snapshots, tool drafts, and test results.
- Builder, Repeater, Runner, and credential-comparison sends also appear in HTTP History, keeping earlier API calls available after the response pane changes.
- Saved Repeater drafts from previous versions are preserved on upgrade.
- Tab-only Auto mode state expires with the browser session.

### Fixed

- Canceling Chrome's debugging banner disables Auto before releasing the tab.
- Unavailable captured upload bodies cannot be silently replayed; header-only response edits retain original CRLF bytes.
- Repeater follows redirects with accurate final URL, method, and sent-body history.
- API Builder raw bodies have no added newline when headers are empty; malformed headers block sending.
- Imported Postman and saved Builder forms retain environment variables with correct URL encoding.
- Assertions reject precision-losing numeric values, handle duplicate headers, and avoid false passes from incomplete response previews.
- Large Comparer/Inspector/Decoder data survives backup validation; backup export works after disk-save failures.
- Collection imports preflight environment capacity, Runner checks expanded request size, and malformed backup metadata is rejected before replacement.
- Runner waits for header-rule cleanup after each request, including cancellation and timeout.
- Missing variables and unsupported cURL options block sending/importing.
- Runner sends at most 50 payloads to one origin, with capped previews.
- Collection imports and Inspector inputs have size limits; collection exports omit workspace variables.
- Incomplete upload bodies are no longer treated as safe to rewrite.
- Custom HTTP methods are shell-quoted in copied cURL commands.
- Failed forwards remain in the intercept queue when they can be retried.
- Temporary Repeater header rules are awaited and cleaned when the dashboard closes.
- Backup imports validate all tool data before replacement; import sends no traffic, restores no live debugger handles, and leaves Auto mode off.
