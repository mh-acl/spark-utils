'use strict';

const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Guest-account safety check shared by any destructive tool task. The
// makerspace's loaner laptops always log guests into the same OS
// account, whose home folder is this exact path. Any task that
// touches guest files should call this first and refuse to run if the
// current home folder doesn't match -- that means this isn't actually
// a guest-account session, and destructive tasks have no business
// running.
const GUEST_HOME = '/Users/user';

function assertGuestAccount() {
  const home = os.homedir();
  if (home !== GUEST_HOME) {
    throw new Error(
      `Refusing to run: expected the guest account's home folder ` +
        `("${GUEST_HOME}"), but this machine's home folder is "${home}". ` +
        `This doesn't look like a guest-account session.`
    );
  }
}

// Deletes everything inside dirPath (files, folders, and dotfiles),
// leaving dirPath itself in place. Missing directories are treated as
// already-clean rather than an error. Returns a list of
// { path, error } for anything that couldn't be removed, so the
// caller can report partial failures instead of silently losing them.
async function clearDirContents(dirPath) {
  const failures = [];
  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return failures;
    throw err;
  }

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    try {
      await fsp.rm(entryPath, { recursive: true, force: true });
    } catch (err) {
      failures.push({ path: entryPath, error: err.message });
    }
  }
  return failures;
}

// --- Unquarantine Applications -------------------------------------------
//
// Ported from the standalone "Unquarantine Applications.applescript" tool
// (clears com.apple.quarantine from every top-level app in /Applications,
// with a single admin prompt, skipped entirely if nothing is flagged).
// Same shell logic as that script; only the "how do we get one admin
// prompt without a new dependency" part changes for this context.

const APPS_FOLDER = '/Applications';

// Escapes a string for safe interpolation inside a double-quoted
// AppleScript string literal. Used to hand a shell command to
// osascript's "do shell script ... with administrator privileges",
// which is the built-in (no extra dependency, e.g. sudo-prompt) way to
// get a single native macOS admin-auth prompt from Node -- same
// mechanism the standalone AppleScript version used directly.
function escapeForAppleScript(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function runShell(cmd) {
  const { stdout } = await execFileAsync('/bin/sh', ['-c', cmd]);
  return stdout;
}

// Runs shellCmd with one macOS admin-authorization prompt. Throws an
// Error with `.cancelled === true` if the person dismisses the prompt,
// so callers can treat that as a quiet no-op rather than a real
// failure (osascript reports this as "User canceled. (-128)").
async function runShellAsAdmin(shellCmd) {
  const script = `do shell script "${escapeForAppleScript(shellCmd)}" with administrator privileges`;
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script]);
    return stdout;
  } catch (err) {
    if (err.message && err.message.includes('-128')) {
      const cancelErr = new Error('User cancelled the admin-authorization prompt.');
      cancelErr.cancelled = true;
      throw cancelErr;
    }
    throw err;
  }
}

// Top-level (maxdepth-1) apps under APPS_FOLDER that currently carry a
// quarantine flag, one per array entry. Reading attributes needs no
// admin rights, so this alone never triggers a prompt -- it's what
// lets run() below skip the prompt entirely when there's nothing to do.
async function quarantinedApps() {
  const cmd =
    `for a in ${APPS_FOLDER}/*.app; do ` +
    `/usr/bin/xattr -p com.apple.quarantine "$a" >/dev/null 2>&1 && echo "$a"; ` +
    `done; true`;
  const out = await runShell(cmd);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// Registry of confirm-then-run tools. main.js's launcher window turns
// this list (plus any window-opening tools it defines itself, like
// USB Wiper -- see main.js's buildToolRegistry()) into the buttons
// shown there automatically -- adding a future confirm-then-run task
// (e.g. resetting settings back to defaults) just means adding an
// entry here, no launcher-wiring changes needed.
//
// Each task:
//   id             - stable identifier, referenced by the launcher's
//                    'tools:invoke' IPC call
//   label          - button text
//   description    - short one-line blurb shown under the label on
//                    the launcher card
//   confirmTitle/Message/Detail - shown in the confirmation dialog
//                    before run() is called
//   run()          - does the work; either resolves (optionally with
//                    { failures: [...] } for partial failures) or
//                    throws on total failure
const TOOLS = [
  {
    id: 'cleanup-profile',
    label: 'Cleanup profile',
    description: "Deletes everything in the guest account's Downloads and Desktop. Cannot be undone.",
    confirmTitle: 'Cleanup profile',
    confirmMessage: 'Delete all files in Downloads and Desktop?',
    confirmDetail:
      "This permanently deletes every file and folder inside the guest account's " +
      'Downloads and Desktop -- including hidden files. This cannot be undone.',
    async run() {
      assertGuestAccount();
      const failures = [
        ...(await clearDirContents(path.join(os.homedir(), 'Downloads'))),
        ...(await clearDirContents(path.join(os.homedir(), 'Desktop'))),
      ];
      return { failures };
    },
  },
  {
    id: 'unquarantine-apps',
    label: 'Unquarantine Applications',
    description:
      'Clears the quarantine flag from every app in /Applications, so an already-approved ' +
      "app (e.g. PrusaSlicer) stops re-prompting -- and losing unsaved work if it's already " +
      'running -- when opening a freshly downloaded file.',
    confirmTitle: 'Unquarantine Applications',
    confirmMessage: `Clear the quarantine flag from every app in ${APPS_FOLDER}?`,
    confirmDetail:
      'Only asks for admin authorization if at least one app is currently flagged. ' +
      'A couple of expected messages may show up afterward and can be ignored: ' +
      "Safari can't be touched (it lives on the sealed system volume, and doesn't need " +
      'to be), and some apps with unusual internal symlinks (e.g. Silhouette Studio) log ' +
      "\"No such file\" for a broken link inside their own bundle -- unrelated to quarantine.",
    async run() {
      const before = await quarantinedApps();
      if (before.length === 0) {
        return { summary: `No apps in ${APPS_FOLDER} have a quarantine flag. Nothing to do.` };
      }

      // The one and only privileged call. find batches every app into a
      // single xattr invocation; -r also clears flags on files inside
      // each bundle. "No such xattr" noise (files that had no flag) is
      // filtered out; anything else (e.g. "Operation not permitted",
      // or the known-benign Safari/symlink messages described in
      // confirmDetail above) is kept and surfaced below.
      const cmd =
        `/usr/bin/find ${APPS_FOLDER} -maxdepth 1 -name '*.app' ` +
        `-exec /usr/bin/xattr -dr com.apple.quarantine {} + 2>&1 | ` +
        `/usr/bin/grep -v 'No such xattr'; true`;

      let noise;
      try {
        noise = (await runShellAsAdmin(cmd)).trim();
      } catch (err) {
        if (err.cancelled) {
          return { summary: 'Cancelled -- no apps were changed.' };
        }
        throw err;
      }

      // Verify by re-checking rather than assuming success.
      const after = await quarantinedApps();
      const cleared = before.length - after.length;

      const failures = after.map((appPath) => ({ path: appPath, error: 'still has a quarantine flag' }));
      if (noise) {
        for (const line of noise.split('\n').filter(Boolean)) {
          failures.push({ path: '(message)', error: line });
        }
      }

      return {
        summary: `Cleared quarantine on ${cleared} of ${before.length} app(s).`,
        failures,
      };
    },
  },
];

module.exports = {
  TOOLS,
  assertGuestAccount,
  clearDirContents,
  GUEST_HOME,
  quarantinedApps,
  runShellAsAdmin,
};
