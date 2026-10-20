# Local workspace encryption design

Design proposal for [issue #18](https://github.com/user-github-me/interceptor/issues/18).
This document does not change the current storage format or claim that the local
database is encrypted. Implementing the proposal requires a separate reviewed PR.

## Current behavior

Interceptor saves complete workbench snapshots in the browser profile's
`interceptor-workspace` IndexedDB database. `current` holds the active workspace;
`before-restore` holds the restore undo copy. Settings and older migrated drafts
also exist in `chrome.storage.local`. Requests, history, authentication fields,
variables, response snapshots, and frame previews can contain credentials or
personal information. The computer and browser profile provide the current
access controls. Optional AES-GCM encryption protects downloaded full backups,
using a password that Interceptor does not save.

The first-use disclosure describes this storage before capture starts. It is
consent to local handling, rather than a cryptographic protection.

## What an encrypted workspace should protect

The goal is to prevent someone reading a copied browser profile or a closed,
locked workspace database from recovering saved testing traffic without the
workspace password. Protect the active snapshot, undo snapshot, migrated drafts,
and every future persistent artifact that contains testing data. Do not claim
that encryption protects against malware running as the user, a compromised
browser/extension, OS swap or crash dumps, traffic already sent to a target, or
data copied/downloaded separately. Data and keys are accessible while unlocked.

No password, derived key, raw credential, or plaintext testing snapshot may be
stored in `chrome.storage.local`, `chrome.storage.session`, or IndexedDB in the
encrypted mode. Persist only harmless display settings, the versioned disclosure
choice, encrypted records, and bounded format parameters outside the ciphertext.
Keep encryption local and dependency-free with Web Crypto. No account, remote
recovery service, or embedded recovery secret is introduced.

## Proposed user flow

1. **Workspace → Protect saved work:** Explain which local records are protected,
   the limitations above, and that a forgotten password cannot be recovered by
   the developer. Ask for a password and confirmation. Encourage a long unique
   passphrase. The final minimum and derivation cost must be justified by measured
   supported-browser performance; do not inherit the backup's eight-character
   minimum without review.
2. **Before migration:** Detach all dashboards, disable Auto, finish or cancel
   every active request/run, and offer an encrypted recovery backup. Other
   dashboards receive the same lock/migration state and stop writing. Explain
   that older downloaded files and OS/browser backups remain separate copies.
3. **Enable protection:** Encrypt the complete validated workspace and undo copy,
   verify decrypting the new records reproduces both, then atomically replace the
   old records. Remove plaintext migrated keys only after the transaction and
   verification succeed. Show protection enabled only after cleanup is complete.
4. **Opening again:** Show a locked screen with Unlock, Import encrypted backup,
   Download encrypted saved records, and Delete saved workspace. Do not load
   decrypted data, attach a tab, restore Auto, or resume requests before an
   explicit unlock. Wrong password/corruption receives a clear error without
   replacing any records. A fresh empty workspace must be an explicit choice.
5. **Lock now:** Stop capture and background Auto, cancel request/run operations,
   flush the final encrypted save, release debugger ownership, clear pending
   editors/results and keys, and show the locked screen. If the final save fails,
   keep work available for an encrypted recovery export and explain the failure
   before discarding it. Lock cannot be advertised as secure while another
   dashboard still displays decrypted data.
6. **Password changes or disable protection:** Require an unlocked workspace and
   current-password verification. Re-encrypt or explicitly write the complete
   plaintext workspace through the same verified atomic migration. Explain the
   resulting protection before the user confirms. Never save the old password as
   an undo path.

## Session and Auto-mode coordination

Choose a single authoritative workspace owner. A candidate is one dashboard
holding a non-exportable `CryptoKey` in its JavaScript memory and serving all
workspace operations through validated extension-only messages. Other dashboards
must either participate in that session or be prevented from opening concurrently.
Do not place the key in a storage area to keep a service worker alive. Dashboard
close, worker restart, browser restart, and owner disconnect must fail closed.

Auto mode currently works without an open dashboard. For encrypted workspaces,
the default proposal is to allow Auto only while an unlocked owner remains open;
lock/owner disconnect disables it. Clearly explain this behavior. A separate
background key holder could be evaluated, but it must not persist keys and must
document worker lifecycle and lock propagation. Avoid a hidden automatic unlock.

An idle timer is optional and requires a precise definition of activity across
all dashboards. Provide a visible Lock control regardless. OS screen-lock APIs
and browser idle detection are not a substitute for explicit browser lifecycle
and key removal rules. Request another permission only if its benefit is proven.

## Versioned storage envelope

Use an explicit format version with an allowlisted algorithm and a bounded KDF
configuration. PBKDF2-SHA-256 is available without dependencies; benchmark its
cost on the slowest supported platforms and document the rationale. Derive a
256-bit AES-GCM key from a fresh cryptographic salt. Use a fresh random 96-bit IV
for every encrypted record or chunk. Never reuse a key/IV pair. Authenticate the
format version, workspace identifier, record kind, generation, chunk index/count,
and KDF parameters as associated data to prevent reordering or substituting data.

The persistent envelope should reveal only what is necessary to unlock: format
version, algorithm/KDF identifiers, bounded salt/iteration settings, generation,
record/chunk identifiers, IVs and ciphertext. Put counts, URLs, names, and tool
draft metadata inside ciphertext. Reject unknown versions, unsupported algorithms,
invalid lengths, excessive iterations, duplicate/missing chunks, and malformed
records before allocating large buffers or running expensive cryptography.

Use the shared workspace budgets and bounded record/chunk processing adopted for
backup handling. Avoid simultaneously allocating plaintext JSON, ciphertext and
Base64 copies of the entire workspace. Keep the previous committed generation
until a transaction commits the full new generation and manifest. A failed save
must leave the old encrypted workspace decryptable. Treat lock and generation
coordination as correctness requirements, not UI preferences.

## Migration and recovery requirements

- Inventory all current/legacy plaintext storage keys and browser-resident copies
  before migration; include `before-restore` and pending autosave state.
- Validate the old workspace with legacy format support before converting it.
  Preserve malformed records for a deliberate recovery export; do not silently
  replace them with an empty snapshot.
- Make concurrent writes impossible during migration. Atomically commit a
  versioned encrypted generation; clean up legacy keys afterward with a resumable
  cleanup marker containing no plaintext. Browser interruption must leave either
  the old complete snapshot or the new complete encrypted generation available.
- Keep downloaded backups compatible. Importing readable JSON into protected
  storage still requires unlock and encrypts it before saving. Importing another
  password-protected backup must not silently change the workspace password.
- An encrypted recovery download while locked contains the original ciphertext
  and enough bounded metadata to restore it. It cannot promise compatibility with
  existing full-backup files until a restore reader is implemented and tested.
- Forgotten passwords have no bypass. Offer deletion with an explicit confirmation
  and an encrypted recovery download beforehand. Describe secure deletion honestly:
  the extension can delete its records but cannot erase previous OS/browser
  backups, filesystem remnants, copied values, or downloaded files.

## Required review and verification before shipping

| Area | Observable evidence |
| --- | --- |
| Stored data | Inspect IndexedDB and local/session storage after enable, save, restore, lock and restart; synthetic secrets occur only in authenticated ciphertext. |
| Cryptography | Known Web Crypto round trips; unique salts/IVs; altered ciphertext, headers, reordered chunks, wrong password and hostile KDF parameters rejected without state replacement. |
| Lifecycle | Closing the owner, worker termination/restart, all-tab Auto, concurrent dashboards and lock during an in-flight save/send all stop new handling and preserve the last committed generation. |
| Migration | Empty/normal/maximum/legacy/corrupt workspaces, quota failures and interrupted commits retain a recoverable copy; plaintext undo/draft keys removed only after successful conversion. |
| Recovery | Locked export, password changes, plaintext/encrypted backup imports, undo and forgotten-password deletion behave as described without leaking keys or executing traffic. |
| Performance | Measure latency and peak memory for realistic large workspaces on supported Chromium versions and macOS/Windows/Linux; publish actual results and supported limits. |
| User understanding | Keyboard-accessible enable/unlock/lock flows explain lost-password consequences, Auto restrictions, separate copies and current protection accurately. |

An independent review of cryptography, lifecycle, migration and recovery is a
release gate. The public privacy policy and Chrome Web Store disclosures must
describe the implemented behavior and its actual defaults. Issue #18 should stay
open until the implementation and those gates are complete.
