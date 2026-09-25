'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const { TOOLS } = require('./tools');
const { SettingsStore } = require('./settings');
const { openUsbWiperWindow } = require('./usbWiperWindow');

let launcherWindow = null;

const settingsStore = new SettingsStore({
  settingsFile: path.join(app.getPath('userData'), 'settings.json'),
});

// The launcher's full tool list: tools.js's confirm-then-run tasks
// (just "Cleanup profile" today, more expected alongside future
// makerspace utilities) plus any tool that instead opens its own
// window, like USB Wiper. Window-opening entries are defined here
// rather than folded into tools.js, since their 'open' handler reaches
// into their own window module (usbWiperWindow.js) rather than
// tools.js's simple run()-and-report shape. To add a future
// window-based tool, add another entry here the same way USB Wiper is
// defined below; to add a future confirm-then-run tool, add it to
// tools.js's TOOLS array instead -- either way nothing else in this
// file needs to change.
function buildToolRegistry() {
  return [
    ...TOOLS.map((task) => ({ kind: 'confirm-run', task })),
    {
      kind: 'window',
      task: {
        id: 'usb-wiper',
        label: 'USB Wiper',
        description: 'Auto-detects an inserted USB drive, wipes it, optionally renames it, and ejects it.',
      },
      open: () => openUsbWiperWindow(settingsStore),
    },
  ];
}

const REGISTRY = buildToolRegistry();

function findEntry(id) {
  return REGISTRY.find((entry) => entry.task.id === id);
}

// Confirm -> run -> report-result flow for a tools.js-style task.
// Ported from Print Catalog's main.js runTool() -- confirm-then-run
// tasks are meant to behave identically whichever app hosts them, and
// tools.js's task shape (confirmTitle/Message/Detail, async run()
// optionally returning { failures }) was written against this exact
// pattern.
async function runConfirmTask(task) {
  const { response } = await dialog.showMessageBox(launcherWindow, {
    type: 'warning',
    buttons: ['Cancel', task.label],
    defaultId: 0,
    cancelId: 0,
    title: task.confirmTitle,
    message: task.confirmMessage,
    detail: task.confirmDetail,
  });
  if (response !== 1) return;

  try {
    const result = await task.run();
    const failures = (result && result.failures) || [];
    if (failures.length === 0) {
      await dialog.showMessageBox(launcherWindow, {
        type: 'info',
        title: task.label,
        message: (result && result.summary) || `${task.label} completed successfully.`,
        detail: result && result.detail,
      });
    } else {
      await dialog.showMessageBox(launcherWindow, {
        type: 'warning',
        title: task.label,
        message: `${task.label} finished, but ${failures.length} item(s) could not be removed.`,
        detail: failures.map((f) => `${f.path}: ${f.error}`).join('\n'),
      });
    }
  } catch (err) {
    await dialog.showMessageBox(launcherWindow, {
      type: 'error',
      title: `${task.label} failed`,
      message: err.message,
    });
  }
}

// Minimal app menu -- no Tools menu, since every tool now lives as a
// button in the launcher window itself (that's the whole point of
// this app). editMenu is kept for standard copy/paste/undo shortcuts
// in any tool window with a text field (e.g. USB Wiper's rename box).
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : [{ label: 'File', submenu: [{ role: 'quit' }] }]),
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Sized to comfortably hold a handful of tool cards with room to
// scroll as more are added -- see renderer/styles.css's #tool-list,
// which is a scrollable flex column rather than a fixed layout, so
// growing this list later needs no window/layout changes here.
function createLauncherWindow() {
  launcherWindow = new BrowserWindow({
    width: 420,
    height: 480,
    minWidth: 360,
    minHeight: 320,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  launcherWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  launcherWindow.on('closed', () => {
    launcherWindow = null;
  });
}

// Sent to the renderer as plain data (id/label/description/kind) --
// task.run()/open() themselves aren't serializable across the IPC
// boundary and aren't needed on that side anyway, since every click
// just calls back into 'tools:invoke' with the id.
ipcMain.handle('tools:list', () =>
  REGISTRY.map(({ kind, task }) => ({
    id: task.id,
    label: task.label,
    description: task.description,
    kind,
  }))
);

ipcMain.handle('tools:invoke', async (event, id) => {
  const entry = findEntry(id);
  if (!entry) throw new Error(`Unknown tool: ${id}`);
  if (entry.kind === 'window') {
    entry.open();
  } else {
    await runConfirmTask(entry.task);
  }
});

app.whenReady().then(async () => {
  await settingsStore.load();
  buildMenu();
  createLauncherWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createLauncherWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
