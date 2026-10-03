# Repository workflow

- Read the source and project documentation before changing the extension.
- Work on a feature branch and create a pull request for each update.
- Track feature and bug work in GitHub issues before implementation. Reference
  the issue in the PR, and keep it open until the implementing PR merges. Follow
  CONTRIBUTING.md for scope, templates, and validation.
- Never push changes directly to `main`; do not merge or publish without the
  user's instruction.
- Unpublished work for this upgrade stays in version `1.1.0`. Bump the version
  for a subsequent release after this update is published.
- Keep the extension local, dependency-free, and compatible with Manifest V3.
- Package runtime files and icons only, with `manifest.json` at the ZIP root.
- Keep builds, store assets, signing keys, and private notes under ignored `local/`.
- Never read, print, export, or search for API keys or signing-key contents.
- Verify changed request behavior with meaningful regressions and browser checks.
