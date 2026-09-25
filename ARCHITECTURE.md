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

- **confirm-run** -- tools.js's `TOOLS` array (just "Cleanup profile"
  for now): click -> confirm dialog -> `run()` -> result dialog,
  identical to Print Catalog's own Tools-menu `runTool()` flow, ported
  here as `main.js`'s `runConfirmTask()`.
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
sudo-prompt.
