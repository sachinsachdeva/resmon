import * as assert from 'assert';
import { test } from 'node:test';
import { Volume, selectVolumes, volumeLabel } from '../disk';

function volume(fs: string, mount: string, use: number, size: number = 245107195904): Volume {
    // On APFS every volume in the container reports the container's size, so
    // "available" is the shared remainder rather than size minus used.
    let used = Math.round(size * use / 100);
    return { fs: fs, mount: mount, size: size, used: used, available: size - used, use: use };
}

// The eight APFS volumes a real Apple M4 reports for one physical disk.
// '/' is the sealed read-only system snapshot: it says 5% used no matter how
// full the machine is. '/System/Volumes/Data' is the real answer, at 67%.
const MACOS_VOLUMES: Volume[] = [
    volume('/dev/disk3s1s1', '/', 5.16),
    volume('/dev/disk3s6', '/System/Volumes/VM', 5.26),
    volume('/dev/disk3s2', '/System/Volumes/Preboot', 3.71),
    volume('/dev/disk3s4', '/System/Volumes/Update', 0),
    volume('/dev/disk1s2', '/System/Volumes/xarts', 1.2, 524288000),
    volume('/dev/disk1s1', '/System/Volumes/iSCPreboot', 1.19, 524288000),
    volume('/dev/disk1s3', '/System/Volumes/Hardware', 0.09, 524288000),
    volume('/dev/disk3s5', '/System/Volumes/Data', 67.43),
];

test('macOS collapses to the one volume that answers the question', () => {
    let selected = selectVolumes(MACOS_VOLUMES, [], 'darwin');

    assert.strictEqual(selected.length, 1, 'should not list eight volumes for one disk');
    assert.strictEqual(selected[0].mount, '/System/Volumes/Data');
    assert.strictEqual(selected[0].use, 67.43);
});

test('macOS does not report the sealed snapshot as free space', () => {
    // The bug this guards against: showing '/' at 5% used, so a nearly full
    // machine looks almost empty.
    let selected = selectVolumes(MACOS_VOLUMES, [], 'darwin');

    assert.ok(selected.every(v => v.fs !== '/dev/disk3s1s1'), 'sealed system snapshot must not be shown');
});

test('macOS data volume is labelled as the root filesystem', () => {
    assert.strictEqual(volumeLabel(volume('/dev/disk3s5', '/System/Volumes/Data', 67), 'darwin'), '/');
});

test('volumes are labelled by mount point, not device node', () => {
    assert.strictEqual(volumeLabel(volume('/dev/sda1', '/home', 40), 'linux'), '/home');
    assert.strictEqual(volumeLabel(volume('C:', 'C:', 40), 'win32'), 'C:');
});

test('an explicit drives list overrides the filtering entirely', () => {
    let byDevice = selectVolumes(MACOS_VOLUMES, ['/dev/disk3s1s1'], 'darwin');

    assert.strictEqual(byDevice.length, 1);
    assert.strictEqual(byDevice[0].fs, '/dev/disk3s1s1', 'the user asked for it, so show it');
});

test('drives can be given as mount points as well as devices', () => {
    let byMount = selectVolumes(MACOS_VOLUMES, ['/System/Volumes/Preboot'], 'darwin');

    assert.strictEqual(byMount.length, 1);
    assert.strictEqual(byMount[0].fs, '/dev/disk3s2');
});

test('a drives entry that matches nothing yields nothing, not everything', () => {
    assert.strictEqual(selectVolumes(MACOS_VOLUMES, ['/dev/nope'], 'darwin').length, 0);
});

test('other platforms keep every real filesystem', () => {
    let linuxVolumes = [
        volume('/dev/sda1', '/', 40),
        volume('/dev/sdb1', '/home', 12),
    ];

    assert.strictEqual(selectVolumes(linuxVolumes, [], 'linux').length, 2);
});

test('zero-capacity pseudo filesystems are dropped', () => {
    // These would render as 0 B, or NaN once a percentage is computed.
    let withPseudo = [
        volume('/dev/sda1', '/', 40),
        volume('devfs', '/dev', 0, 0),
        volume('map auto_home', '/System/Volumes/Data/home', 0, 0),
    ];

    let selected = selectVolumes(withPseudo, [], 'linux');

    assert.strictEqual(selected.length, 1);
    assert.strictEqual(selected[0].fs, '/dev/sda1');
});

test('macOS without a data volume falls back to non-system mounts', () => {
    // Older macOS, or a Mac whose disk is not split the modern way.
    let older = [
        volume('/dev/disk1s1', '/', 55),
        volume('/dev/disk1s4', '/System/Volumes/Preboot', 2),
        volume('/dev/disk2s1', '/Volumes/External', 10),
    ];

    let selected = selectVolumes(older, [], 'darwin');

    assert.deepStrictEqual(selected.map(v => v.mount), ['/', '/Volumes/External']);
});
