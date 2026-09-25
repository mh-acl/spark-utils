'use strict';

// drives.js
//
// Lists currently mounted external, physical volumes on macOS -- i.e.
// actual removable media like USB flash drives and SD cards, as
// opposed to network shares or disk images.
//
// This intentionally uses only macOS's built-in `diskutil` and
// `plutil` command-line tools rather than a native Node module like
// `drivelist`. A native addon would need compiling for Electron on
// every one of the makerspace's older OCLP laptops -- exactly the
// kind of build-toolchain headache we hit trying to install Node
// itself. Shelling out to tools that already ship with macOS sidesteps
// that entirely, at the cost of this module being macOS-only.

const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Runs the shared diskutil/plutil pipeline and returns the parsed
 * JSON, or null if there are no external physical disks at all.
 */
async function getDiskutilData() {
  const { stdout } = await execAsync(
    'diskutil list -plist external physical | plutil -convert json -o - -'
  );
  try {
    return JSON.parse(stdout);
  } catch (err) {
    // No external physical disks at all -- diskutil can return an
    // empty/invalid plist in that case rather than an empty list.
    return null;
  }
}

/**
 * @returns {Promise<Array<{ name: string, mountPoint: string }>>}
 */
function extractMountedVolumes(data) {
  const disks = (data && data.AllDisksAndPartitions) || [];
  const volumes = [];

  for (const disk of disks) {
    for (const partition of disk.Partitions || []) {
      if (!partition.MountPoint) continue; // unmounted (e.g. an EFI partition)
      volumes.push({
        name: partition.VolumeName || partition.MountPoint.split('/').pop(),
        mountPoint: partition.MountPoint,
        // The whole-disk identifier (e.g. "disk4"), not the partition's
        // own (e.g. "disk4s2") -- ejecting at the disk level unmounts
        // and spins down every volume on that physical device, which
        // is what actually makes it safe to unplug.
        diskIdentifier: disk.DeviceIdentifier,
      });
    }
  }

  return volumes;
}

/** All whole-disk identifiers currently attached, mounted or not. */
function extractDiskIdentifiers(data) {
  return ((data && data.AllDisksAndPartitions) || []).map((disk) => disk.DeviceIdentifier);
}

async function listUsbDrives() {
  const data = await getDiskutilData();
  return extractMountedVolumes(data);
}

/**
 * `diskutil eject` doesn't just unmount -- it unpublishes the disk's
 * IOMedia object from IOKit entirely, the same way physically unplugging
 * it would. That means `diskutil list` (what getDiskutilData() above
 * shells out to) can no longer see the disk at all the instant eject
 * succeeds, regardless of whether the drive is still sitting in the USB
 * port. isDiskPresent() used to rely solely on that data, which made it
 * report "gone" immediately upon eject instead of waiting for an actual
 * physical unplug.
 *
 * The fix: track the physical USB *device* (via system_profiler), not
 * the disk/media object eject destroys. The device node persists in
 * system_profiler's output until the drive is actually pulled, even
 * after its media has been unpublished.
 *
 * ejectedDeviceIdentities maps a diskIdentifier to the identity captured
 * for it right before eject was called, so isDiskPresent() can look the
 * right device back up afterward without every caller needing to plumb
 * that identity through themselves.
 */
const ejectedDeviceIdentities = new Map();

/**
 * Walks system_profiler's USB tree looking for the device whose Media
 * list includes this disk identifier (as the whole disk, e.g. "disk3",
 * or one of its partitions, e.g. "disk3s1"), and returns a stable
 * identity for it: the device's serial number where available, or a
 * name+location_id fallback for drives that don't report one. Returns
 * null if no matching device is found (e.g. transient diskutil/
 * system_profiler disagreement, or a device with no discoverable Media
 * at all).
 */
async function findUsbDeviceIdentity(diskIdentifier) {
  let root;
  try {
    const { stdout } = await execAsync('system_profiler SPUSBDataType -json');
    root = JSON.parse(stdout);
  } catch (err) {
    return null;
  }

  function walk(nodes) {
    for (const node of nodes || []) {
      const media = node.Media || [];
      const matches = media.some((m) => {
        if (m.bsd_name === diskIdentifier) return true;
        return (m.volumes || []).some((v) => v.bsd_name === diskIdentifier);
      });
      if (matches) {
        return node.serial_num
          ? { kind: 'serial', value: node.serial_num }
          : { kind: 'name-location', value: `${node._name}|${node.location_id}` };
      }
      const found = walk(node._items);
      if (found) return found;
    }
    return null;
  }

  return walk(root.SPUSBDataType);
}

/**
 * Checks whether a previously-captured USB device identity still shows
 * up anywhere in system_profiler's USB tree, independent of mount or
 * eject state.
 */
async function isUsbDevicePresentByIdentity(identity) {
  let root;
  try {
    const { stdout } = await execAsync('system_profiler SPUSBDataType -json');
    root = JSON.parse(stdout);
  } catch (err) {
    return true; // transient hiccup -- assume still present, try again next poll
  }

  function walk(nodes) {
    for (const node of nodes || []) {
      if (identity.kind === 'serial' && node.serial_num === identity.value) return true;
      if (identity.kind === 'name-location' && `${node._name}|${node.location_id}` === identity.value) {
        return true;
      }
      if (walk(node._items)) return true;
    }
    return false;
  }

  return walk(root.SPUSBDataType);
}

/**
 * Ejects the whole physical disk (all its volumes/partitions), which
 * is what actually makes it safe to physically unplug -- ejecting
 * just one mounted volume can leave a second partition on the same
 * drive still mounted.
 *
 * Captures the device's USB identity first (see above) so isDiskPresent()
 * can still tell "ejected but still plugged in" apart from "actually
 * removed" afterward -- diskutil itself can no longer make that
 * distinction once eject has unpublished the disk.
 */
async function ejectDrive(diskIdentifier) {
  try {
    const identity = await findUsbDeviceIdentity(diskIdentifier);
    if (identity) ejectedDeviceIdentities.set(diskIdentifier, identity);
  } catch (err) {
    // If identity lookup fails for any reason, fall through and eject
    // anyway -- isDiskPresent() will fall back to the diskutil-based
    // check below, which just means removal detection may fire early
    // (same as the old behavior) for this one drive.
  }
  await execFileAsync('diskutil', ['eject', diskIdentifier]);
}

const fs = require('fs');
const path = require('path');

/**
 * Deletes everything inside a mounted USB volume (files and folders,
 * including dotfiles), leaving the volume itself mounted and intact so it
 * can still be ejected normally afterward. Permanent delete, no Trash - the
 * whole point of this tool is that these are shared, disposable-content
 * drives that accumulate makerspace files over time, same reasoning as
 * Cleanup profile's permanent deletion in tools.js.
 *
 * Returns { failures: [{ path, error }] } for anything that couldn't be
 * removed (e.g. macOS system files like .Trashes/.Spotlight-V100 that may
 * be permission-protected) rather than throwing, so one stubborn file
 * doesn't block wiping the rest of the drive.
 */
async function wipeDriveContents(mountPoint) {
  const entries = await fs.promises.readdir(mountPoint, { withFileTypes: true });
  const failures = [];

  for (const entry of entries) {
    const target = path.join(mountPoint, entry.name);
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
    } catch (error) {
      failures.push({ path: target, error: error.message });
    }
  }

  // Written last, after everything above is gone -- writing it any
  // earlier would just have it deleted by this same pass. An empty
  // regular file (not a folder) named .Trashes at the volume root
  // blocks macOS from creating its own .Trashes/<uid> folder there,
  // so Finder can't silently move deleted items into a hidden trash
  // on this drive -- it instead prompts to delete immediately, which
  // is what we want for shared, disposable-content drives.
  try {
    await fs.promises.writeFile(path.join(mountPoint, '.Trashes'), '');
  } catch (error) {
    failures.push({ path: path.join(mountPoint, '.Trashes'), error: error.message });
  }

  return { failures };
}


/**
 * Checks whether a disk is still physically attached at all -- NOT
 * whether it's still mounted, and (see ejectedDeviceIdentities above)
 * not merely whether diskutil can still see its media object, since
 * eject unpublishes that regardless of physical attachment.
 *
 * If ejectDrive() was called for this diskIdentifier, this checks the
 * USB device identity captured at that time via system_profiler, which
 * keeps reporting "present" for an ejected-but-still-plugged-in drive
 * and only flips to "gone" once it's actually unplugged. Once it does
 * flip, the captured identity is cleared, since it's no longer useful
 * and diskIdentifier could be reused by a future disk.
 *
 * If eject was never called for this diskIdentifier (or identity lookup
 * failed at the time), falls back to the plain diskutil-list check --
 * accurate as long as eject hasn't unpublished the media object yet.
 */
async function isDiskPresent(diskIdentifier) {
  const identity = ejectedDeviceIdentities.get(diskIdentifier);
  if (identity) {
    const present = await isUsbDevicePresentByIdentity(identity);
    if (!present) ejectedDeviceIdentities.delete(diskIdentifier);
    return present;
  }
  const data = await getDiskutilData();
  return extractDiskIdentifiers(data).includes(diskIdentifier);
}

// FAT12/16/32 volume labels share the old 8.3 label space: 11
// characters max, uppercase only, and a restricted charset (no
// lowercase, no most punctuation or symbols). exFAT and macOS's own
// filesystems (HFS+/APFS) don't have this restriction, so this is
// only applied when the volume is actually FAT.
const FAT_LABEL_MAX_LENGTH = 11;

/**
 * Adapts a requested volume name to what FAT12/16/32 can actually
 * store: uppercased, and stripped down to letters/digits/spaces only
 * rather than trying to enumerate FAT's full accepted symbol set,
 * then truncated to 11 characters. Trimmed after truncating too, in
 * case cutting it off at 11 chars lands mid-space. An input that's
 * empty after stripping (e.g. it was entirely symbols) falls back to
 * "UNTITLED" rather than handing diskutil an empty label.
 */
function sanitizeFatLabel(name) {
  const stripped = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '');
  const truncated = stripped.slice(0, FAT_LABEL_MAX_LENGTH).trim();
  return truncated || 'UNTITLED';
}

/**
 * Looks up a mounted volume's filesystem type (e.g. "msdos" for
 * FAT12/16/32, "exfat", "hfs", "apfs") via `diskutil info`. Returns
 * '' if it can't be determined, which callers should treat as "don't
 * assume FAT" rather than a hard error.
 */
async function getFilesystemType(mountPoint) {
  try {
    // Single-quoted and escaped the same way mountPoint itself might
    // need to be (it can contain spaces, e.g. "/Volumes/MY DRIVE") --
    // this shells out same as getDiskutilData() above, just with a
    // dynamic argument that needs quoting.
    const quoted = `'${mountPoint.replace(/'/g, `'\\''`)}'`;
    const { stdout } = await execAsync(
      `diskutil info -plist ${quoted} | plutil -convert json -o - -`
    );
    const data = JSON.parse(stdout);
    return data.FilesystemType || '';
  } catch (err) {
    return '';
  }
}

/**
 * Renames a mounted volume via `diskutil rename`, which accepts a
 * mount point in place of the volume's current name -- convenient
 * here since the caller (usbWiperWindow.js) already has each volume's
 * mountPoint on hand and would otherwise have to track its
 * (possibly-just-wiped) display name separately. When the volume is
 * FAT12/16/32 (`FilesystemType` "msdos" -- covers all three; diskutil
 * distinguishes them via `FilesystemName` instead, e.g. "MS-DOS
 * FAT32", not `FilesystemType`), the requested name is first adapted
 * to what that filesystem can actually store -- see sanitizeFatLabel.
 */
async function renameVolume(mountPoint, name) {
  const filesystemType = await getFilesystemType(mountPoint);
  const finalName = filesystemType === 'msdos' ? sanitizeFatLabel(name) : name;
  await execFileAsync('diskutil', ['rename', mountPoint, finalName]);
}

module.exports = {
  listUsbDrives,
  ejectDrive,
  isDiskPresent,
  extractMountedVolumes,
  extractDiskIdentifiers,
  wipeDriveContents,
  renameVolume,
};