# Contributing to Interceptor

Interceptor is a local, dependency-free browser workbench for developers and
security testers. Bug reports, request-handling fixes, accessible UI improvements,
documentation, and useful browser testing tools are welcome.

Read [README.md](README.md), [PRIVACY.md](PRIVACY.md), and
[AGENTS.md](AGENTS.md) before changing the extension.

## From an issue to a pull request

1. Search the [issues](https://github.com/user-github-me/interceptor/issues)
   and [open pull requests](https://github.com/user-github-me/interceptor/pulls).
   Add evidence to an existing issue when it covers the same problem.
2. Open a bug report or feature request. Include a reproducible problem or a
   concrete user need, a proposed scope, and observable acceptance criteria.
   For larger changes, discuss the scope before investing in implementation.
3. Reference the issue when proposing to work on it. Maintainers can mark a
   scoped task `help wanted` or `good first issue`; an issue linked to an active
   PR may already have an implementation awaiting review.
4. Fork the repository and create a topic branch, such as
   `fix/123-request-timeout` or `feat/123-response-checks`. Keep the change focused
   on the issue and preserve unrelated work.
5. Implement the change, update relevant documentation, and verify the behavior.
6. Open a PR against `main`. Include `Closes #123` for an issue the PR resolves,
   or `Refs #123` when more work will remain. Describe the change and the checks
   actually performed. Maintainer review and merge complete the issue.

Do not push directly to `main`. Do not merge, tag a release, or publish to the
Chrome Web Store as part of a contribution. The pending upgrade stays at
**1.1.0** until it is published; follow the release version instructions in
[AGENTS.md](AGENTS.md).

## Local setup

Use Node.js **22 or later**. There are no runtime or test dependencies to install.

```bash
git clone https://github.com/YOUR-USERNAME/interceptor.git
cd interceptor
git switch -c fix/123-request-timeout
npm run check
npm test
```

Open `chrome://extensions` in a Chromium browser, enable Developer mode, and
select **Load unpacked** with this repository directory. See the
[README installation instructions](README.md#install-from-source) for details.

Keep development browser profiles, builds, screenshots for release preparation,
and private working notes under ignored `local/`. Do not commit captured
credentials, signing keys, real user traffic, or personal browser profiles.

## Verification

Every code PR should run:

```bash
npm run check
npm test
git diff --check
```

GitHub Actions runs the syntax checks and Node regression suite on pull requests.
It does not run the browser integration test automatically.

For request, interception, permission, storage, or backup changes, verify the
behavior in a browser using an isolated profile and local test data. The
integration harness starts its own HTTP and WebSocket fixtures:

```bash
node tests/browser-integration.mjs http://127.0.0.1:9226
```

First launch an isolated Chromium browser with the unpacked extension loaded and
`--remote-debugging-port=9226`. An example on macOS with Brave:

```bash
mkdir -p local
'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' \
  --headless=new \
  --remote-debugging-port=9226 \
  --user-data-dir="$PWD/local/browser-test-profile" \
  --disable-extensions-except="$PWD" \
  --load-extension="$PWD" \
  --no-first-run \
  --no-default-browser-check about:blank
```

Run the harness from another terminal after the browser starts. The test uses and
closes the extension dashboard in that profile, including an already open one,
and creates/closes a fixture tab. Use a profile with no personal workspace data.
Some Chromium distributions disable command-line
extension loading. If the harness reports that Interceptor is not loaded, load it
manually in the isolated browser profile. State the browser/version and results
in the PR. For UI changes, include relevant screenshots and check keyboard access,
light/dark themes, and narrow layouts.

Add regressions for changed request or storage behavior. Prefer checks of
observable behavior, including error/cancel paths. Small documentation or styling
changes do not need implementation-mirroring tests.

## Design constraints

- Keep runtime local and compatible with Manifest V3, without remote code,
  telemetry, cloud sync, or new runtime dependencies.
- Explain any proposed permission changes in the issue and PR.
- Preserve raw request bytes where the workflow promises lossless handling.
  Label incomplete, binary, and capped data clearly.
- Keep passive analysis passive. Active tools should state what traffic they
  send and provide appropriate limits and cancellation.
- Treat security findings as evidence needing context and manual verification.
- Update privacy documentation when persistence or data access changes.
- Release ZIPs contain runtime files and icons only, with `manifest.json` at root.

## Reporting problems

Bug reports should include the extension/browser versions, reproduction steps,
expected and actual behavior, and a small local fixture when possible. Use
synthetic or redacted requests, logs, screenshots, and backups. For feature
requests, describe who benefits and how a reviewer could verify the result.

Issues #2–#8 track the current v1.1 feature groups; #9 tracks this contribution
workflow. They are linked to [PR #1](https://github.com/user-github-me/interceptor/pull/1)
and stay open while the implementation is under review. Open separate issues for
follow-up work so contributors can find a clear, unclaimed task.
