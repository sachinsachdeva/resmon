import * as assert from 'assert';
import { test } from 'node:test';
import { parsePerformanceStatistics, AppleGpuSampler, UtilizationWindow,
    isComparableGap, clampPollInterval, smoothUtilization } from '../appleGpu';

// Trimmed from real `ioreg -r -d 1 -w 0 -c IOAccelerator` output on an Apple M4.
// The "In use system memory (driver)" sibling key is kept deliberately: it is
// the trap the parser has to avoid.
const M4_SAMPLE = `+-o AGXAcceleratorG16G  <class AGXAcceleratorG16G, id 0x10000039c, registered, matched, active, busy 0 (309 ms), retain 59>
    {
      "IOMatchedAtBoot" = Yes
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=2181693440,"Tiler Utilization %"=30,"recoveryCount"=0,"Renderer Utilization %"=29,"Device Utilization %"=30,"In use system memory"=356089856}
      "model" = "Apple M4"
      "gpu-core-count" = 10
    }
`;

test('parses utilization and memory from real ioreg output', () => {
    let stats = parsePerformanceStatistics(M4_SAMPLE);

    assert.ok(stats !== null);
    assert.strictEqual(stats!.utilization, 30);
    assert.strictEqual(stats!.mappedMemory, 356089856);
    assert.strictEqual(stats!.allocatedMemory, 2181693440);
});

test('does not mistake the "(driver)" sibling for mapped memory', () => {
    // "In use system memory (driver)" is 0 and appears first, so a pattern
    // without the closing quote would report 0 bytes.
    let stats = parsePerformanceStatistics(M4_SAMPLE);

    assert.notStrictEqual(stats!.mappedMemory, 0);
    assert.strictEqual(stats!.mappedMemory, 356089856);
});

test('reads the accelerator name and core count for the hover', () => {
    let stats = parsePerformanceStatistics(M4_SAMPLE);

    assert.strictEqual(stats!.model, 'Apple M4');
    assert.strictEqual(stats!.coreCount, 10);
});

test('an Apple GPU is recognised as sharing memory with the CPU', () => {
    // Which is what lets the reading name a total at all: the allocation is a
    // share of system memory, where a discrete GPU's limit is its own VRAM.
    assert.strictEqual(parsePerformanceStatistics(M4_SAMPLE)!.hasUnifiedMemory, true);
});

test('a discrete GPU is not credited with the system memory pool', () => {
    let radeon = '+-o AMDRadeonAccelerator  <class AMDRadeonX6000, id 0x100000abc, registered>\n'
        + '    {\n      "PerformanceStatistics" = {"Device Utilization %"=44,"Alloc system memory"=123}\n'
        + '      "model" = "AMD Radeon Pro 5500M"\n    }\n';

    assert.strictEqual(parsePerformanceStatistics(radeon)!.hasUnifiedMemory, false);
});

test('a node that names itself nothing still reports its statistics', () => {
    let stats = parsePerformanceStatistics('"PerformanceStatistics" = {"Device Utilization %"=42}');

    assert.strictEqual(stats!.utilization, 42);
    assert.strictEqual(stats!.model, null);
    assert.strictEqual(stats!.coreCount, null);
});

test('the name comes from the node that supplied the statistics', () => {
    // A Mac with a discrete GPU lists both accelerators. If the first reports
    // no statistics, its name must not be attached to the second one's numbers.
    let dualGpu = '+-o IntelAccelerator  <class IntelAccelerator>\n'
        + '    {\n      "model" = "Intel UHD Graphics 630"\n      "gpu-core-count" = 24\n    }\n'
        + '+-o AMDRadeonAccelerator  <class AMDRadeonAccelerator>\n'
        + '    {\n      "PerformanceStatistics" = {"Device Utilization %"=88}\n'
        + '      "model" = "AMD Radeon Pro 5500M"\n      "gpu-core-count" = 24\n    }\n';

    let stats = parsePerformanceStatistics(dualGpu);

    assert.strictEqual(stats!.utilization, 88);
    assert.strictEqual(stats!.model, 'AMD Radeon Pro 5500M');
});

test('a later node cannot lend its name to an earlier one', () => {
    // The reverse of the case above: the usable accelerator comes first, so the
    // name must not be picked up from the node after it.
    let dualGpu = '+-o AGXAcceleratorG16G  <class AGXAcceleratorG16G>\n'
        + '    {\n      "PerformanceStatistics" = {"Device Utilization %"=12}\n'
        + '      "model" = "Apple M4"\n    }\n'
        + '+-o OtherAccelerator  <class OtherAccelerator>\n'
        + '    {\n      "model" = "Some Other GPU"\n      "gpu-core-count" = 99\n    }\n';

    let stats = parsePerformanceStatistics(dualGpu);

    assert.strictEqual(stats!.model, 'Apple M4');
    assert.strictEqual(stats!.coreCount, null);
});

test('returns null rather than throwing on unusable input', () => {
    assert.strictEqual(parsePerformanceStatistics(''), null);
    assert.strictEqual(parsePerformanceStatistics('not ioreg output at all'), null);
    // Truncated before the statistics block closes.
    assert.strictEqual(parsePerformanceStatistics('"PerformanceStatistics" = {"Alloc'), null);
});

test('returns null when utilization is absent, even if memory is present', () => {
    // Utilization is the one value the feature cannot do without, so a machine
    // reporting only memory counts as unsupported.
    let stats = parsePerformanceStatistics('"PerformanceStatistics" = {"Alloc system memory"=123}');

    assert.strictEqual(stats, null);
});

test('defaults missing memory values to zero', () => {
    let stats = parsePerformanceStatistics('"PerformanceStatistics" = {"Device Utilization %"=42}');

    assert.strictEqual(stats!.utilization, 42);
    assert.strictEqual(stats!.mappedMemory, 0);
    assert.strictEqual(stats!.allocatedMemory, 0);
});

test('an accelerator reporting no utilization does not hide the one that does', () => {
    // The regression this guards: a first node with a statistics dict but no
    // utilization used to end the search, so the whole GPU section vanished on
    // any Mac that listed such an accelerator ahead of the real one.
    let dualGpu = '+-o FirstAccelerator  <class FirstAccelerator>\n'
        + '    {\n      "PerformanceStatistics" = {"Alloc system memory"=123}\n'
        + '      "model" = "Useless Accelerator"\n    }\n'
        + '+-o AGXAcceleratorG16G  <class AGXAcceleratorG16G>\n'
        + '    {\n      "PerformanceStatistics" = {"Device Utilization %"=88,"Alloc system memory"=999}\n'
        + '      "model" = "Apple M4"\n    }\n';

    let stats = parsePerformanceStatistics(dualGpu);

    assert.ok(stats !== null, 'a usable accelerator listed second must still be found');
    assert.strictEqual(stats!.utilization, 88);
    assert.strictEqual(stats!.model, 'Apple M4');
});

test('reads the first accelerator that can actually report utilization', () => {
    let dualGpu = '"PerformanceStatistics" = {"Device Utilization %"=7}\n'
        + '"PerformanceStatistics" = {"Device Utilization %"=88}';

    assert.strictEqual(parsePerformanceStatistics(dualGpu)!.utilization, 7);
});

test('a run of readings averages to the interval, not to its last value', () => {
    // The defect this exists to prevent: "Device Utilization %" is a gauge, so
    // a GPU busy half the time reads ~0 or ~100 and never 50. One reading per
    // update reports a coin toss; the mean reports the workload.
    let window = new UtilizationWindow();
    [100, 0, 100, 0, 100, 0, 100, 0].forEach(reading => window.add(reading));

    assert.strictEqual(window.mean, 50);
    assert.strictEqual(window.peak, 100);
    assert.strictEqual(window.count, 8);
});

test('the peak survives an average that buries it', () => {
    let window = new UtilizationWindow();
    [0, 0, 0, 0, 0, 0, 0, 96].forEach(reading => window.add(reading));

    assert.strictEqual(window.mean, 12);
    assert.strictEqual(window.peak, 96);
});

test('an empty window reports zero rather than NaN', () => {
    let window = new UtilizationWindow();

    assert.strictEqual(window.mean, 0);
    assert.strictEqual(window.peak, 0);
    assert.strictEqual(window.count, 0);
});

test('resetting begins a fresh interval', () => {
    let window = new UtilizationWindow();
    window.add(100);
    window.reset();
    window.add(10);

    assert.strictEqual(window.mean, 10);
    assert.strictEqual(window.peak, 10, 'the previous interval\'s peak must not carry over');
});

test('readings the driver cannot supply are kept out of the mean', () => {
    let window = new UtilizationWindow();
    window.add(50);
    window.add(NaN);
    window.add(Infinity);

    assert.strictEqual(window.count, 1);
    assert.strictEqual(window.mean, 50);
});

test('readings outside 0-100 are clamped rather than skewing the mean', () => {
    let window = new UtilizationWindow();
    window.add(-5);
    window.add(140);

    assert.strictEqual(window.mean, 50);
    assert.strictEqual(window.peak, 100);
});

test('sampler resolves instead of rejecting, on every platform', async () => {
    // ResMon.update() gathers resources with Promise.all and has no error
    // handling, so a rejection here would freeze the whole status bar.
    let sampler = new AppleGpuSampler();
    let stats = await sampler.sample();

    if (process.platform !== 'darwin') {
        assert.strictEqual(stats, null, 'GPU statistics must be unavailable off macOS');
        sampler.dispose();
        return;
    }

    // On macOS the values are real, so assert their shape rather than exact numbers.
    if (stats !== null) {
        assert.ok(stats.utilization >= 0 && stats.utilization <= 100);
        // The very first read has no predecessor to measure a span against, so
        // it seeds the baseline and the raw value stands in for an average.
        assert.strictEqual(stats.sampleCount, 0);
        assert.ok(stats.allocatedMemory >= 0);
        assert.ok(stats.mappedMemory >= 0);
        // Unified memory is what lets the reading name a pool to be a share of.
        if (stats.hasUnifiedMemory) {
            assert.ok(stats.totalMemory !== null && stats.totalMemory > 0);
        } else {
            assert.strictEqual(stats.totalMemory, null);
        }
    }

    sampler.dispose();
});

test('sampler serves concurrent callers from one sample', async () => {
    // Two resources each call isShown() and render() per tick. Beyond saving
    // three ioreg invocations, this is what stops the first of them consuming
    // the interval average and leaving the other three with a single reading.
    let sampler = new AppleGpuSampler();
    let results = await Promise.all([sampler.sample(), sampler.sample(), sampler.sample(), sampler.sample()]);

    let distinct = new Set(results.map(r => JSON.stringify(r)));
    assert.strictEqual(distinct.size, 1, 'concurrent callers should observe one identical sample');
    sampler.dispose();
});

test('a disposed sampler goes quiet', async () => {
    // The poller runs on a timer between updates, so nothing may keep taking
    // readings once the extension has been torn down.
    let sampler = new AppleGpuSampler();
    await sampler.sample();
    sampler.dispose();

    assert.strictEqual(await sampler.sample(), null);
});

test('only readings taken at the intended spacing are averaged together', () => {
    // The statistic covers the time since the previous read, so mixing spans of
    // different lengths averages unlike things.
    assert.strictEqual(isComparableGap(250, 250), true);
    assert.strictEqual(isComparableGap(180, 250), true);
    assert.strictEqual(isComparableGap(400, 250), true);

    // Far too early, and far too late.
    assert.strictEqual(isComparableGap(20, 250), false);
    assert.strictEqual(isComparableGap(4000, 250), false);
});

test('the first reading of all has no span to measure', () => {
    // _lastReadAt starts at negative infinity, so the opening gap is infinite.
    assert.strictEqual(isComparableGap(Infinity, 250), false);
    assert.strictEqual(isComparableGap(NaN, 250), false);
});

test('the reading that resumes polling after an idle spell is not counted', () => {
    // It spans seconds of mostly-idle time, and the statistic discounts idle
    // time, so counting it would spike the figure exactly when work begins.
    let idleCadence = 250 * 4;

    assert.strictEqual(isComparableGap(idleCadence, 250), false,
        'a reading arriving on the relaxed cadence cannot join a brisk average');
});

test('a poll cadence is held to what is worth spending CPU on', () => {
    assert.strictEqual(clampPollInterval(250), 250);
    assert.strictEqual(clampPollInterval(1), 50, 'too brisk to afford');
    assert.strictEqual(clampPollInterval(60000), 2000, 'too slow to mean anything');
    // A mistyped setting should slow the poller, never disable the reading.
    assert.strictEqual(clampPollInterval(NaN), 250);
});

test('a thin window leans on the figure before it, a thick one does not', () => {
    // With no history there is nothing to lean on.
    assert.strictEqual(smoothUtilization(null, 80, 3), 80);

    // One reading against six samples' worth of history barely moves it.
    assert.ok(smoothUtilization(0, 100, 1) < 20);

    // A full window carries most of the weight, so real change still shows.
    assert.ok(smoothUtilization(0, 100, 40) > 85);
});
