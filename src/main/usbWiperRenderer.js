const BEGIN_LABEL = 'Begin Wiping USBs';
const STOP_LABEL = 'Stop Wiping USBs';

const button = document.getElementById('toggle-button');
const status = document.getElementById('status');
const progressBar = document.getElementById('progress-bar');
const renameCheckbox = document.getElementById('rename-checkbox');
const renameName = document.getElementById('rename-name');

let wiping = false;

function setRenameRowEnabled(enabled) {
  renameCheckbox.disabled = !enabled;
  renameName.disabled = !enabled || !renameCheckbox.checked;
}

async function saveRenameSettings() {
  await window.usbWiperAPI.saveRenameSettings({
    renameDrives: renameCheckbox.checked,
    driveRenameName: renameName.value || 'UNTITLED',
  });
}

renameCheckbox.addEventListener('change', () => {
  renameName.disabled = wiping || !renameCheckbox.checked;
  saveRenameSettings();
});

// Saved on blur rather than every keystroke -- avoids a settings.json
// write per character while someone's still typing a name.
renameName.addEventListener('blur', saveRenameSettings);

// value/max stay fixed at 0/1 and 1/1 -- the only thing that changes for
// "active" is removing the value attribute entirely, which is what makes
// a native <progress> element render as an indeterminate animated bar in
// Chromium rather than a static empty/full one.
function setProgressState(state) {
  progressBar.classList.remove('state-disabled', 'state-active', 'state-done', 'state-error');
  progressBar.classList.add(`state-${state}`);
  if (state === 'active') {
    progressBar.removeAttribute('value');
  } else if (state === 'done' || state === 'error') {
    progressBar.setAttribute('value', '1');
  } else {
    progressBar.setAttribute('value', '0');
  }
}

function setNotStarted() {
  wiping = false;
  button.textContent = BEGIN_LABEL;
  button.classList.remove('stopping');
  status.textContent = 'Click "Begin Wiping USBs" to start.';
  setProgressState('disabled');
  setRenameRowEnabled(true);
}

button.addEventListener('click', async () => {
  if (wiping) {
    await window.usbWiperAPI.stopSession();
    // User-initiated stop dismisses the window entirely, unlike an
    // auto-stop from losing focus (see onSessionEnded below).
    window.close();
  } else {
    await window.usbWiperAPI.startSession();
    wiping = true;
    button.textContent = STOP_LABEL;
    button.classList.add('stopping');
    setRenameRowEnabled(false);
    // Status text/progress state for "insert a drive" comes from the
    // 'usb-wiper:status' idle event the main process sends as part of
    // starting the session, handled below.
  }
});

window.usbWiperAPI.onStatus(({ phase, message }) => {
  status.textContent = message;
  if (phase === 'wiping' || phase === 'unmounting') {
    setProgressState('active');
  } else if (phase === 'done') {
    setProgressState('done');
  } else if (phase === 'error') {
    setProgressState('error');
  } else {
    setProgressState('disabled'); // 'idle'
  }
});

// Fired when the main process auto-stops the session because this window
// left the foreground. The window itself stays open; only the button,
// status, and progress bar reset, so the user can re-initiate wiping when
// they come back to it.
window.usbWiperAPI.onSessionEnded(() => {
  setNotStarted();
});

setNotStarted();

window.usbWiperAPI.getRenameSettings().then(({ renameDrives, driveRenameName }) => {
  renameCheckbox.checked = renameDrives;
  renameName.value = driveRenameName || 'UNTITLED';
  renameName.disabled = !renameDrives; // row itself stays enabled -- not wiping yet
});
