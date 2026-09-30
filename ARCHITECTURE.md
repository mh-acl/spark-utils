# Spark Utils -- Architecture

Standalone Electron app for the makerspace's loaner-laptop maintenance
tools, split out of Print Catalog's Tools menu so that app can stay
focused on cataloging/browsing. macOS only (same OCLP-patched
MacBooks as Print Catalog itself), same "guest account always logs
into `/Users/user`" assumption as the tools ported from there.

## Launcher window (the whole UI)

There's no menubar Tools menu here -- every tool is a button in the
single launcher window (`src/renderer/index.html`/`renderer.js`/
`styles.css`), so a person just opens the app and clicks the tool they
want. `main.js`'s `buildToolRegistry()` combines two kinds of tool:

- **confirm-run** -- tools.js's `TOOLS` array ("Cleanup profile" and
  "Unquarantine Applications"): click -> confirm dialog -> `run()` ->
  result dialog, identical to Print Catalog's own Tools-menu
  `runTool()` flow, ported here as `main.js`'s `runConfirmTask()`.
- **window** -- a tool that opens its own dedicated `BrowserWindow`
  instead of running in place. USB Wiper is the only one so far,
  wired directly in `buildToolRegistry()` rather than through
  tools.js, since its `open()` handler reaches into its own window
  module (`usbWiperWindow.js`) rather than tools.js's simple
  run()-and-report shape.

`tools:list` (IPC) serializes the registry (id/label/description/kind)
to the renderer, which builds one card per tool with no per-tool logic
of its own -- adding a future tool to either list on the main-process
side is enough for it to appear, no renderer changes needed. The list
is a scrollable flex column (`#tool-list`) rather than a fixed layout,
so it has room to grow.

`tools:invoke` (IPC, takes a tool id) either runs `runConfirmTask()` or
calls the entry's `open()`.

## Ported from Print Catalog, unchanged in substance

- **`tools.js`** -- `GUEST_HOME`/`assertGuestAccount()` guard,
  `clearDirContents()`, and the `TOOLS` registry (Cleanup profile).
  Ported verbatim except each task now also carries a `description`
  for the launcher card.
- **`drives.js`** -- macOS `diskutil`/`system_profiler` shell-outs for
  listing/wiping/renaming/ejecting USB drives. Fully self-contained,
  no Print Catalog dependency; ported verbatim.
- **`usbWiperWindow.js`/`usbWiperPreload.js`/`usbWiperRenderer.js`/
  `usbWiperWindow.html`** -- USB Wiper's own dedicated window (poll
  loop for insert/wipe/eject, rename-on-wipe option). Ported verbatim;
  its only external dependency is a `settingsStore` with
  `renameDrives`/`driveRenameName`, which this app provides via its
  own trimmed `settings.js`.
- **`settings.js`** -- same `SettingsStore` shape as Print Catalog's,
  trimmed to just the two fields USB Wiper persists (Print Catalog's
  catalog-specific fields -- `gitRepoUrl`, printer filters, etc. --
  don't apply here).

## Unquarantine Applications (new)

Ported from a standalone "Unquarantine Applications.applescript" tool
written to fix a specific bug: a bare (non-zip) downloaded file could
put PrusaSlicer through a fresh Gatekeeper quarantine check even
though PrusaSlicer itself was already approved -- and dismissing that
prompt (Cancel) killed an already-running PrusaSlicer, losing unsaved
work. Root cause turned out to be PrusaSlicer.app itself still
carrying a `com.apple.quarantine` attribute (e.g. after being copied
in via an image/restore rather than a fresh per-machine download);
stripping it fixed the behavior for every downloaded file, not just
one. This tool is the general fix: it clears that attribute from every
top-level app in `/Applications`, not just PrusaSlicer, so the same
class of bug can't recur for any other app on these laptops.

Lives in `tools.js` alongside Cleanup profile, as a second `TOOLS`
entry (`id: 'unquarantine-apps'`):

- `quarantinedApps()` lists top-level (`-maxdepth 1`) `*.app` bundles
  under `/Applications` that currently carry the flag, via
  `xattr -p com.apple.quarantine`. Read-only, no admin rights needed
  -- this is what lets `run()` skip the admin prompt entirely when
  nothing is flagged.
- `run()` re-checks after clearing (never assumes success from a
  non-throwing shell call) and returns `{ summary, failures }`, where
  `failures` covers both apps still flagged afterward and any stderr
  noise from the privileged command (each becomes one entry) --
  reusing the same `runConfirmTask()` failure-reporting path Cleanup
  profile uses, rather than a bespoke result shape.
- The privileged step (`find ... -exec xattr -dr com.apple.quarantine
  {} +`, batched into a single call so only one app-list is walked)
  runs via `runShellAsAdmin()`, which shells out to
  `osascript -e 'do shell script "..." with administrator
  privileges'` -- the same one-prompt mechanism the standalone
  AppleScript version used directly, chosen here specifically to avoid
  adding a dependency like `sudo-prompt` (see Build, below).
  `escapeForAppleScript()` escapes the shell command for safe
  interpolation into that AppleScript string literal. Cancelling the
  prompt surfaces as an `Error` with `.cancelled === true`
  (osascript's "-128" exit), which `run()` turns into a plain
  "Cancelled -- no apps were changed" summary rather than an error
  dialog.
- Known-benign noise, expected and explained in the confirm dialog
  rather than filtered out: Safari can't be touched (it's on the
  sealed system volume and doesn't need to be); apps with unusual
  internal symlinks (e.g. Silhouette Studio's bundled
  `LittleCMS64.framework`) log "No such file" for a broken link inside
  their own bundle when `xattr -r` tries to follow it, unrelated to
  quarantine. Only the "No such xattr" case (a file that simply had no
  flag to begin with) is filtered out of the noise before it's
  surfaced.

## Not ported (stayed in Print Catalog)

"Backfill Added Dates" and "Backfill creator info" were left behind --
both operate on the catalog's git-backed edit session/data model
(`EditSession`, `indexer`, `DATA_DIR`), not on anything self-contained,
so they aren't real candidates for this app without a genuine rework.

## Build

Same `electron-builder` mac-zip setup as Print Catalog
(`package.json`'s `build` block), separate `appId`
(`com.mh-acl.spark-utils`). No `dependencies` beyond Electron
itself -- nothing ported here needed chokidar/cropperjs/pdf-lib/
sudo-prompt; Unquarantine Applications' single admin prompt is done
via `osascript`, already on every Mac, rather than adding
`sudo-prompt` for that one call.
