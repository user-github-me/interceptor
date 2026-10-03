# Changelog

## 1.1.0 — 2026-10-03

### Added

- Site Map grouped by origin, method, and path with counts, statuses, average timings, query fields, History links, and endpoint export.
- Inspector for repeated query/form fields, exact JSON values, cookies, response headers, and cookie attributes.
- Payload Runner with sequential sends, delays, timeouts, stop/cancel, response-text checks, result comparison, replay, and CSV export.
- Collections with names, folders, notes, import/export, shared `{{variables}}`, and opt-in local persistence.
- cURL import, Repeater duplication, request timeouts, five response snapshots per tab, and compare-previous.
- Hex encode/decode, SHA-256/SHA-512 hashing, and a keyboard tool switcher (⌘/Ctrl+K).

- URL include/exclude safety scope for automatic field rewriting.
- HAR import and method, status, type, URL, header, and body filtering.
- Side-by-side response Comparer with JSON normalization and unified diff export.
- Local Decoder for JSON, URL encoding, Base64, HTML entities, and JWT inspection.
- Dependency-free Node tests for the HTTP engine and analysis helpers.

### Improved

- Refined dark and light themes, navigation, spacing, empty states, keyboard focus, and narrow-screen layouts.
- JSON display and Decoder formatting preserve large numeric values exactly.
- JSON and query rewrites preserve unrelated source formatting, encoding, and large numbers.
- Multipart rules skip file uploads and match form field names exactly.
- Repeater response reads and HTTP history now have bounded memory use.
- Repeater tabs are kept in memory unless the user explicitly enables local persistence.
- Saved Repeater drafts from previous versions are preserved on upgrade.
- Tab-only Auto mode state expires with the browser session.

### Fixed

- Runner waits for header-rule cleanup after each request, including cancellation and timeout.
- Missing variables and unsupported cURL options block sending/importing.
- Runner sends at most 50 payloads to one origin, with capped previews.
- Collection imports and Inspector inputs have size limits; collection exports omit workspace variables.
- Incomplete upload bodies are no longer treated as safe to rewrite.
- Custom HTTP methods are shell-quoted in copied cURL commands.
- Failed forwards remain in the intercept queue when they can be retried.
- Temporary Repeater header rules are awaited and cleaned when the dashboard closes.
