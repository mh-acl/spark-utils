'use strict';

// settings.js
//
// Small persisted store for this app's settings. Ported from Print
// Catalog's settings.js, trimmed down to just what USB Wiper needs --
// Print Catalog's own catalog-specific fields (gitRepoUrl, printer
// filters, etc.) don't apply here. Future standalone tools that need
// their own persisted settings should add fields here the same way.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DEFAULT_SETTINGS = {
  // USB Wiper's "Rename drive to:" checkbox + text field (see
  // usbWiperWindow.js) -- persisted so both the on/off state and the
  // last-typed name are remembered the next time the tool window is
  // opened, independent of any single wipe session.
  renameDrives: false,
  driveRenameName: 'UNTITLED',
};

class SettingsStore {
  constructor({ settingsFile }) {
    this.settingsFile = settingsFile;
    this.settings = { ...DEFAULT_SETTINGS };
  }

  async load() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.settingsFile, 'utf8'));
      this.settings = { ...DEFAULT_SETTINGS, ...raw };
    } catch (err) {
      this.settings = { ...DEFAULT_SETTINGS }; // no settings file yet, or it's corrupt
    }
    return this.settings;
  }

  async save(newSettings) {
    this.settings = { ...DEFAULT_SETTINGS, ...newSettings };
    await fsp.mkdir(path.dirname(this.settingsFile), { recursive: true });
    await fsp.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2));
    return this.settings;
  }

  get() {
    return this.settings;
  }
}

module.exports = { SettingsStore, DEFAULT_SETTINGS };
