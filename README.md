<p align="center">
  <img src="docs/screenshots/banner.png" alt="Interceptor — a Burp-style HTTP proxy that lives in your browser" width="820">
</p>

<p align="center">
  <b>See, edit, replay and auto-tamper the HTTP your web app sends — right inside your browser.</b><br>
  A lightweight, Burp-style proxy as a Chromium extension. No proxy setup, no certificates, no external app.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Manifest-V3-3fbf7f" alt="Manifest V3">
  <img src="https://img.shields.io/badge/browser-Brave%20%7C%20Chrome%20%7C%20Edge-ff7a1a" alt="Browsers">
  <img src="https://img.shields.io/badge/build-none-8b93a3" alt="No build step">
  <img src="https://img.shields.io/badge/license-MIT-5aa9ff" alt="MIT License">
</p>

---

## What is this?

**Interceptor** is a browser extension for web developers and security testers who want to inspect and manipulate their own app's traffic without leaving the browser. It's the everyday 20% of Burp Suite — intercept, history, and repeater — plus one thing Burp makes you do by hand: **Auto mode**, which rewrites chosen fields (like a payment `amount`) on every request automatically, so you can test server-side validation in seconds.

Because it's built on the Chrome DevTools Protocol, it can truly **pause, edit, forward, and drop** live requests and responses — something a normal `webRequest` extension cannot do.

> ⚠️ **Use it on apps you own or are authorized to test.** See [Responsible use](#responsible-use).

## Features

- 🧲 **Intercept** — pause requests (and responses) and edit the raw method, path, query, headers or body before they continue. Forward, drop, or forward-and-catch-the-response.
- 📜 **HTTP History** — a live table of every request from the target tab, with full headers (including `Cookie`/`Set-Cookie`), bodies, timing and size. Filter by text/regex, pretty-print JSON, copy as cURL, export **HAR**.
- 🔁 **Repeater** — hand-craft a raw request and fire it as many times as you like. What you type is exactly what goes on the wire — including `Cookie`, `Origin`, `User-Agent` and `Sec-*` headers.
- ⚡ **Auto mode** — force one or more fields to a fixed value on **every** request, automatically. Purpose-built for **price-tampering / server-validation tests**. Toggle it for **this tab** or **all tabs** from the toolbar popup — no manual attach step.
- 🧩 Works in **Brave, Chrome and Edge**. Pure JavaScript, **no build step**, no dependencies, no data leaves your machine.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/popup.png" alt="Toolbar popup with Auto mode"><br><sub><b>Toolbar popup</b> — flip Auto mode on for this tab or all tabs.</sub></td>
    <td width="50%"><img src="docs/screenshots/intercept.png" alt="Intercept panel"><br><sub><b>Intercept</b> — a paused request, with the Auto-mode rewrite pre-applied.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/history.png" alt="HTTP history"><br><sub><b>HTTP History</b> — full request/response, copy as cURL, export HAR.</sub></td>
    <td width="50%"><img src="docs/screenshots/repeater.png" alt="Repeater"><br><sub><b>Repeater</b> — edit a raw request and replay it.</sub></td>
  </tr>
</table>

## Install (from source)

There's no store listing yet — load it unpacked in about a minute:

1. **Download** this repo (`git clone` or *Code → Download ZIP* and extract).
2. Open your browser's extensions page:
   - Brave: `brave://extensions`
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder.
5. Pin **Interceptor** to the toolbar. Done.

```bash
git clone https://github.com/<your-username>/interceptor.git
# then "Load unpacked" → select the interceptor/ folder
```

## Quick start

### Test a payment flow in 15 seconds (Auto mode)

1. Click the **Interceptor** toolbar icon.
2. Choose **All tabs** (or **This tab**). The default rule already forces the common payment fields to `1`.
3. Use your app's checkout. Every `amount`, `payableAmount`, `totalAmount`, … goes out as `1`.
4. Check your server: did it re-price server-side, or did it trust the client? If the order total drops, your validation is bypassable.

Every rewrite is recorded in the panel's **Auto log** and **HTTP History**, so you always have a record of what changed.

### Inspect & tamper by hand (Intercept)

1. Open the panel (**Open panel →** in the popup) and pick your app's tab under **Target tab**, then **Attach**. Your browser shows an *"Interceptor started debugging this browser"* banner — that's expected; it's how the extension gets low-level access.
2. Click **Intercept is OFF** to turn it **ON**.
3. Use your app. Requests pause in the queue — edit anything and **Forward** (⌘/Ctrl+Enter), or **Drop** them.

## How it works

Interceptor is built on the **Chrome DevTools Protocol (CDP)** via the `chrome.debugger` API — the only way an extension can genuinely pause and mutate live traffic (the `webRequest` API can observe and block, but not rewrite bodies or edit responses).

```
┌───────────────────────────┐        ┌──────────────────────────────┐
│  Toolbar popup (popup.js)  │        │  Dashboard page (dashboard.js)│
│  • Auto mode on/off        │        │  • Intercept queue + editor   │
│  • scope: this tab / all   │        │  • HTTP history + HAR         │
│  • field → value rules     │        │  • Repeater                   │
└─────────────┬─────────────┘        └───────────────┬──────────────┘
              │ chrome.storage                        │ CDP: Fetch + Network
              ▼                                        ▼  (its own debuggee)
┌─────────────────────────────────────────────────────────────────────┐
│  Background service worker (background.js)                            │
│  • Owns Auto mode: attaches the debugger to the target tab(s)         │
│    automatically and rewrites fields via CDP "Fetch.requestPaused"    │
│  • Survives service-worker idle (debugger sessions persist)           │
│  • Hands a tab off to the dashboard when you attach manually          │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                    http.js — dependency-free engine:
                    raw HTTP parse/serialize, cURL/HAR,
                    and the field-rewrite rules (query, form,
                    nested JSON, multipart; type-preserving)
```

- **Auto mode** runs entirely in the background service worker, so it needs no open panel and can cover every tab. Attaching the debugger from the worker keeps working even after the worker goes idle.
- **Manual intercept/history/repeater** run in the dashboard page, which holds its own debugger session. When you attach it to a tab, it "claims" that tab and the worker steps aside — coordinated through a single serialized queue so the two never fight over one tab.
- **`http.js`** has zero DOM/`chrome.*` usage, so the whole request-rewriting engine is unit-tested in plain Node.

### Auto mode rules

Each rule is a list of **field names** (comma-separated) plus one **value**. A field is rewritten wherever it appears in:

| Location | Example |
|---|---|
| Query string | `?amount=4999` → `?amount=1` |
| Form body (`x-www-form-urlencoded`) | `amount=4999` → `amount=1` |
| JSON body (including deeply nested) | `{"order":{"amount":4999}}` → `{"order":{"amount":1}}` |
| Multipart form fields | `name="amount"` part value → `1` |

Matching is **case-insensitive on the whole field name** (`AmountToPay` matches `amountToPay`), a field you didn't list (like `quantity`) is left untouched, and JSON types are preserved (a numeric field stays a number). The default rule covers the usual suspects: `amount, payableAmount, payingAmount, amountToPay, paymentAmount, totalAmount, grandTotal, orderTotal, subtotal, price, unitPrice, amountDue, netAmount, finalAmount, chargeAmount, billAmount, totalPrice, payment` — add your app's own field names in the popup.

## Permissions

| Permission | Why |
|---|---|
| `debugger` | The core: pause, edit, forward and drop live requests/responses via CDP. |
| `tabs` | List tabs to target and coordinate attach/detach. |
| `storage` | Remember your rules, settings and Repeater tabs. |
| `webRequest` | Show the *"Actual request sent"* view in Repeater. |
| `declarativeNetRequestWithHostAccess` | Let Repeater send otherwise-forbidden headers (`Cookie`, `Origin`, `User-Agent`, …) exactly as typed. |
| `<all_urls>` | You decide which of *your* sites to test; traffic never leaves your machine. |

Nothing is sent anywhere. There are no analytics, no network calls of the extension's own — everything runs locally.

## Limitations

- One **manually-attached** tab at a time for the deep intercept/history/repeater workflow (Auto mode can cover all tabs).
- WebSockets and Server-Sent Events aren't intercepted.
- Bodies are edited as UTF-8 text; for binary bodies (file uploads) leave the body untouched and the original bytes are sent.
- Browsers can't send a body with `GET`/`HEAD`, so Repeater can't either.
- Traffic from other-process iframes and some service workers may not be captured.
- For a self-signed HTTPS dev cert, open the URL in a tab and accept it once before using Repeater.

## Development & tests

Pure JS, no build. The request/response engine in `http.js` is covered by Node unit tests, and the extension is verified end-to-end by driving a real Brave instance over CDP (intercept edit/drop, response tampering, history capture, repeater header handling, and Auto mode across query/JSON/form/multipart and both scopes).

```
manifest.json      MV3 manifest
background.js      service worker — Auto mode engine + tab coordination
popup.html/.js/.css  toolbar popup — Auto mode scopes & rules
dashboard.html/.js/.css  the panel — intercept, history, repeater
http.js            dependency-free HTTP + rewrite engine (unit-tested)
icons/             extension icons
docs/screenshots/  images used in this README
```

## Responsible use

This is a tool for testing **your own** applications, or ones you have **explicit permission** to test. Intercepting or tampering with traffic to services you don't control may be illegal and is not the intent of this project. You are responsible for how you use it.

## Contributing

Issues and PRs are welcome — bug reports, new default field names, and UI polish especially. Keep it dependency-free and match the existing style. If you change the rewrite engine, add a unit test in the same spirit as the existing ones.

## License

[MIT](LICENSE) — do what you like, no warranty.
