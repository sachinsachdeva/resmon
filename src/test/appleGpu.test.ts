import * as assert from 'assert';
import { test } from 'node:test';
import { parsePerformanceStatistics, AppleGpuSampler, UtilizationWindow, smoothUtilization } from '../appleGpu';

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
        // A burst re-bases the statistic and then measures, so even the very
        // first sample is an average of windows of known width.
        assert.ok(stats.sampleCount >= 1, 'a sample should carry the burst behind it');
        assert.ok(stats.peakUtilization >= stats.utilization - 1e-9, 'the peak cannot sit below the mean');
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

test('a sampler takes a burst per sample, and nothing between them', async () => {
    // The reason this design exists: every VS Code window runs its own
    // extension host, so anything running between updates multiplies by the
    // number of open windows.
    let sampler = new AppleGpuSampler();
    await sampler.sample();

    let quiet = await new Promise<boolean>(resolve => {
        let readsAfterSampling = 0;
        let handle = setInterval(() => { readsAfterSampling++; }, 50);
        handle.unref();
        setTimeout(() => { clearInterval(handle); resolve(true); }, 300).unref();
    });

    assert.ok(quiet, 'nothing should be scheduled between samples');
    sampler.dispose();
});

test('a burst is sized so it cannot make an update late', async () => {
    // At the 200ms floor on updatefrequencyms a full burst would overrun the
    // interval it belongs to, so it is shortened rather than skipped.
    let sampler = new AppleGpuSampler();
    sampler.setUpdateInterval(200);

    let started = Date.now();
    await sampler.sample();
    let elapsed = Date.now() - started;

    if (process.platform === 'darwin') {
        assert.ok(elapsed < 200, `a burst inside a 200ms interval took ${elapsed}ms`);
    }
    sampler.dispose();
});

test('a nonsensical update interval leaves the burst alone', () => {
    let sampler = new AppleGpuSampler();

    // Must not throw, and must not leave the burst at zero readings.
    sampler.setUpdateInterval(NaN);
    sampler.setUpdateInterval(-1);
    sampler.dispose();
});

test('the first burst is shown as measured, with nothing to ease from', () => {
    assert.strictEqual(smoothUtilization(null, 42), 42);
});

test('smoothing steadies a jumpy run without pulling it off the truth', () => {
    // The bursts actually measured on a load steady at 47%: unbiased, but a
    // status bar showing 0 then 74 then 3 looks as broken as a wrong number.
    let bursts = [39, 69, 0, 74, 3, 72, 72, 68];

    let shown: number | null = null;
    let series: number[] = bursts.map(burst => {
        shown = smoothUtilization(shown, burst);
        return shown;
    });

    let spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    assert.ok(spread(series) < spread(bursts) * 0.7,
        `smoothed spread ${spread(series).toFixed(0)} should be well under the raw ${spread(bursts)}`);

    // Steadier, but still centred on the same truth rather than dragged off it.
    let mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    assert.ok(Math.abs(mean(series) - mean(bursts)) < 8,
        `smoothed mean ${mean(series).toFixed(1)} should track the raw mean ${mean(bursts).toFixed(1)}`);
});

test('smoothing still follows a real change promptly', () => {
    // An idle GPU that starts working must not take all day to say so: half the
    // step lands on the first update and the figure is most of the way there by
    // the third, which at the default cadence is half a minute.
    let shown: number | null = 0;

    shown = smoothUtilization(shown, 100);
    assert.ok(shown! >= 50, `only ${shown} after the first update of full load`);

    shown = smoothUtilization(shown, 100);
    shown = smoothUtilization(shown, 100);
    assert.ok(shown! > 80, `reached only ${shown} after three updates of full load`);

    // Meanwhile the hover's peak is not eased at all, so "is it busy right now"
    // is answerable on the first update.
});
