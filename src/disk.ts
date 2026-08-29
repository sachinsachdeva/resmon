'use strict';

/**
 * The subset of a systeminformation fsSize() entry that matters here.
 */
export interface Volume {
    fs: string;
    mount: string;
    size: number;
    used: number;
    /**
     * Space genuinely still available, which on APFS is not size minus used:
     * every volume in a container reports the container's size.
     */
    available: number;
    /** Used as a percentage of used plus available, which is what df reports. */
    use: number;
}

// Where macOS mounts the volume holding everything a user actually stores.
const MACOS_DATA_MOUNT = '/System/Volumes/Data';

// macOS keeps Preboot, VM, Update, xarts, iSCPreboot and Hardware here. They
// are implementation details of the boot process, not disks anyone monitors.
const MACOS_SYSTEM_MOUNT_PREFIX = '/System/Volumes/';

/**
 * Chooses which volumes to display.
 *
 * An explicit drives list always wins and is matched against both the device
 * and the mount point, so either '/dev/disk3s5' or '/System/Volumes/Data'
 * selects the same volume.
 *
 * Left to itself on macOS this would list eight APFS volumes for one physical
 * disk. Worse, the obvious-looking one is misleading: '/' is the sealed,
 * read-only system snapshot and reports about 95% free no matter how full the
 * machine is. The volume that answers "how much space do I have left" is the
 * data volume, so when it is present it stands in for the root filesystem and
 * the sealed snapshot is dropped.
 */
export function selectVolumes(volumes: Volume[], drives: string[], platform: string): Volume[] {
    if (drives.length > 0) {
        return volumes.filter(volume => drives.indexOf(volume.fs) !== -1 || drives.indexOf(volume.mount) !== -1);
    }

    // Pseudo filesystems report no capacity and would render as 0 B or NaN.
    let realVolumes = volumes.filter(volume => volume.size > 0);

    if (platform !== 'darwin') {
        return realVolumes;
    }

    let dataVolume = realVolumes.filter(volume => volume.mount === MACOS_DATA_MOUNT);
    if (dataVolume.length > 0) {
        return dataVolume;
    }

    return realVolumes.filter(volume => volume.mount.indexOf(MACOS_SYSTEM_MOUNT_PREFIX) !== 0);
}

/**
 * The name to show for a volume.
 *
 * Mount points are what people recognise; '/dev/disk3s5' tells a reader
 * nothing. The macOS data volume is labelled '/' because that is the
 * filesystem it represents from the user's point of view, and it is the only
 * volume shown once the sealed snapshot is dropped.
 */
export function volumeLabel(volume: Volume, platform: string): string {
    if (platform === 'darwin' && volume.mount === MACOS_DATA_MOUNT) {
        return '/';
    }
    return volume.mount || volume.fs;
}
