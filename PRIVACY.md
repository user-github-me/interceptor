# Privacy Policy — Interceptor

_Last updated: 2026-10-03_

Interceptor is a browser extension for inspecting and modifying the HTTP traffic
of web pages you are testing. This policy explains what it does with data.

## Short version

**Interceptor does not collect, store remotely, sell, or send your data to the
developer. Traffic analysis happens locally in your browser.** Repeater and Runner
send requests to the target you choose when you click Send or Start run.

## What the extension accesses

To do its job, Interceptor can read and modify the network requests and responses
of the tab you attach it to (or, in Auto mode, the tab or tabs you enable). This
can include URLs, headers (such as cookies), and request/response bodies. This
information is processed **in memory, on your device**, only to:

- display traffic in the extension's own panel (HTTP history, intercept, repeater),
- apply the modifications you explicitly make or the Auto-mode rules you configure.

## What is stored

The extension stores the following **locally** using the browser's
`chrome.storage.local` API, on your own computer:

- your settings and Auto-mode rules,
- your Repeater tabs only when you enable **Remember tabs locally** (off by default).
- Collections, request notes, and workspace variables only when you enable
  **Remember workspace locally** (off by default).

Existing saved Repeater tabs are preserved when upgrading from earlier versions.
You can disable **Remember tabs locally** to remove those saved drafts.

Captured or imported HTTP history, response snapshots, Inspector data, Runner
results, Comparer inputs, decoded values, and Auto logs
exist only in memory while the panel is open and are discarded when you close it
or clear them. Nothing is written to any remote server.

Exporting a collection, HAR, or Runner CSV creates a file at your request.
Collection exports omit workspace variables, but raw requests can still contain
cookies or tokens. Imported cURL commands are parsed as text and never executed.

## What is NOT done

- No data is sent to the developer, advertisers, or analytics services.
- No analytics, tracking, or telemetry of any kind.
- No accounts, and no remote code is loaded or executed.

## Your control

You choose which tab(s) the extension attaches to. Detaching, turning Auto mode
off, and stopping Runner end those operations. Disable either persistence option
to clear its saved data; current workspace data remains in memory until closed.
Locally stored settings are
removed when you uninstall the extension.

## Contact

Questions or concerns: open an issue at
https://github.com/user-github-me/interceptor/issues
