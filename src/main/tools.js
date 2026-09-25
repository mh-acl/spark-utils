'use strict';

const os = require('os');
const path = require('path');
const fsp = require('fs').promises;

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
];

module.exports = { TOOLS, assertGuestAccount, clearDirContents, GUEST_HOME };
