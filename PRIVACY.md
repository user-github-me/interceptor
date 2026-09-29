# Privacy Policy — Interceptor

_Last updated: 2026-09-29_

Interceptor is a browser extension for inspecting and modifying the HTTP traffic
of web pages you are testing. This policy explains what it does with data.

## Short version

**Interceptor does not collect, store remotely, sell, or transmit any of your
data. Everything happens locally in your browser.**

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
- your Repeater tabs (the raw requests you save).

Captured HTTP history exists only in memory while the panel is open and is
discarded when you close it or clear it. Nothing is written to any remote server.

## What is NOT done

- No data is sent to the developer or to any third party.
- No analytics, tracking, or telemetry of any kind.
- No accounts, and no remote code is loaded or executed.

## Your control

You choose which tab(s) the extension attaches to. Detaching, turning Auto mode
off, or removing the extension stops all processing. Locally stored settings are
removed when you uninstall the extension.

## Contact

Questions or concerns: open an issue at
https://github.com/user-github-me/interceptor/issues
