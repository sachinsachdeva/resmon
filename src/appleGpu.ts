'use strict';

import { execFile } from 'child_process';
import { totalmem } from 'os';

/**
 * One instantaneous read of an accelerator's IOKit statistics.
 *
 * On Apple Silicon there is no VRAM partition: the GPU addresses the same
 * memory the CPU does, so the memory figures are shares of one system-wide
 * pool rather than used/total of a dedicated one.
 */
export interface GpuReading {
    /** "Device Utilization %", 0-100, as a spot value at the instant of the read. */
    utilization: number;
    /** "Alloc system memory", in bytes: what the driver has claimed from the system. */
    allocatedMemory: number;
    /** "In use system memory", in bytes: the subset currently mapped. */
    mappedMemory: number;
    /** The accelerator's "model", such as "Apple M4". Null when the node does not name itself. */
    model: string | null;
    /** The accelerator's "gpu-core-count". Null when the node does not report one. */
    coreCount: number | null;
    /** Whether this GPU shares one memory pool with the CPU, rather than owning VRAM. */
    hasUnifiedMemory: boolean;
}

/**
 * What the display consumes: the latest reading, with utilization summarised
 * across the whole interval since the previous update rather than left as the
 * single spot value that reading happened to catch.
 */
export interface GpuStats extends GpuReading {
    /**
     * Mean utilization over the interval, which is what the status bar shows.
     *
     * "Device Utilization %" is a read-to-read delta, not a gauge, and its
     * denominator discounts time the GPU had nothing queued. How often it is
     * read therefore changes what it says. Against a load busy half the time,
     * measured on an M4:
     *
     *     read every 10ms   47%   (the true duty cycle)
     *     read every 100ms  61%
     *     read every 300ms  80%
     *     read every 500ms  93%
     *
     * Read once per update, as this used to be, it answers "did the GPU do
     * anything since you last looked" and pins near 100% whenever the answer is
     * yes. Only reading it briskly and consistently, then averaging, gives a
     * figure that means what the CPU percentage beside it means.
     */
    utilization: number;
    /** The busiest single read in the interval, which is what a mean hides. */
    peakUtilization: number;
    /** How many reads the mean covers, so the hover can qualify a thin average. */
    sampleCount: number;
    /**
     * Capacity of the pool the allocation is drawn from, in bytes, or null
     * where the GPU has its own VRAM and system memory is not its limit.
     */
    totalMemory: number | null;
}

// ioreg lives outside the default PATH of a GUI-launched process on some
// setups, and an unresolvable command would silently hide the whole section.
const IOREG_PATH: string = '/usr/sbin/ioreg';

// Recurse one level from each IOAccelerator node so we pick up its properties,
// with unlimited line width so the PerformanceStatistics dict isn't wrapped.
const IOREG_ARGS: string[] = ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'];

// The whole registry dump for one node is ~46 KB on an M4; allow generous room
// for machines that expose several accelerators.
const IOREG_MAX_BUFFER: number = 4 * 1024 * 1024;

// Two resources each ask whether they are shown and then what to display, so a
// single tick reads the sampler four times. Collapsing those into one ioreg
// invocation keeps the cost at ~10ms per tick, and matters for more than cost:
// all four must observe the same interval average, and only the first of them
// may consume it.
const CACHE_WINDOW_MS: number = 100;

// How often the background poller reads utilization between updates.
//
// This is the accuracy dial, and it is spent in CPU: an ioreg invocation costs
// about 9ms however little is asked of it, which is dear next to the syscall
// behind the CPU percentage. Four reads a second spends roughly 3.5% of one
// core while the reading is on screen, and is close enough for a load that is
// steady or absent, which is nearly all of them. The interval is deliberately
// fixed rather than jittered: the statistic measures the span between reads,
// so an irregular cadence measures an irregular thing.
const DEFAULT_POLL_INTERVAL_MS: number = 250;

// Below this the readings cost more than they inform; above it the figure drifts
// upwards towards "the GPU did something recently".
const MIN_POLL_INTERVAL_MS: number = 50;
const MAX_POLL_INTERVAL_MS: number = 2000;

// How far a gap between two readings may stray from the one that was intended
// before the reading is treated as measuring a different span, and so kept out
// of the average. The statistic covers exactly the time since the previous
// read, so a reading taken early or late is not describing the same thing as
// its neighbours.
const GAP_TOLERANCE_LOW: number = 0.5;
const GAP_TOLERANCE_HIGH: number = 2;

// An idle GPU reads zero at any cadence, so once this many readings in a row
// come back idle the poller slows down by this factor. Nearly all of a working
// day is idle as far as the GPU is concerned, which is what makes a brisk
// cadence affordable during the parts that are not.
const IDLE_READINGS_BEFORE_BACKOFF: number = 8;
const IDLE_BACKOFF_FACTOR: number = 4;

// How many readings a window must hold before its mean is taken at face value.
//
// The gauge is bimodal: a GPU busy half the time reads ~0 or ~100 and never 50,
// so a mean of a handful of readings is mostly noise. Blending in the last
// figure, weighted against this many samples, steadies the display without
// pinning it: a full ten-second window still carries three quarters of the
// weight, so a real change shows up within a couple of updates.
const SMOOTHING_SAMPLES: number = 6;

// Polling stops after this long without anyone asking for a sample, so a window
// whose GPU reading is switched off or hidden costs nothing. The next sample()
// starts it again.
const IDLE_TIMEOUT_MS: number = 20000;

const PERFORMANCE_STATISTICS_PATTERN = /"PerformanceStatistics" = \{([^}]*)\}/g;

// Descriptive properties sit beside PerformanceStatistics in the same node,
// either side of it, so they are read from the start of that node onwards.
const NODE_MARKER = '+-o ';
const MODEL_PATTERN = /"model" = "([^"]*)"/;
const CORE_COUNT_PATTERN = /"gpu-core-count" = (\d+)/;

// Apple's own GPU driver family. Every Apple Silicon GPU is an AGXAccelerator
// and shares its memory with the CPU; the model name is the fallback for a
// node that does not announce its class in the usual shape.
const AGX_CLASS_PATTERN = /<class\s+AGXAccelerator/;
const APPLE_MODEL_PATTERN = /^Apple\s/;

/**
 * Extracts one accelerator's statistics from the output of
 * `ioreg -r -d 1 -w 0 -c IOAccelerator`.
 *
 * Pure: takes text, returns data, never touches the system. Returns null if
 * the output holds no readable statistics, which is how this feature detects
 * that a machine cannot report GPU utilization.
 */
export function parsePerformanceStatistics(ioregOutput: string): GpuReading | null {
    // A Mac can list several accelerators, and the ones that report no
    // utilization are exactly the ones this feature cannot use. Scanning past
    // them matters because they are not always listed last: giving up on the
    // first dict would hide the GPU entirely on a machine whose usable
    // accelerator happens to come second.
    PERFORMANCE_STATISTICS_PATTERN.lastIndex = 0;
    let statisticsBlock = PERFORMANCE_STATISTICS_PATTERN.exec(ioregOutput);

    while (statisticsBlock !== null) {
        let statistics: string = statisticsBlock[1];
        let utilization: number | null = readStatistic(statistics, "Device Utilization %");

        if (utilization !== null) {
            return describeNode(ioregOutput, statisticsBlock.index, statistics, utilization);
        }

        statisticsBlock = PERFORMANCE_STATISTICS_PATTERN.exec(ioregOutput);
    }

    return null;
}

/**
 * Builds the reading for the node that supplied the given statistics.
 */
function describeNode(ioregOutput: string, offset: number, statistics: string, utilization: number): GpuReading {
    // Bounded to the one node, so a machine with several accelerators cannot
    // lend a neighbour's name, core count or driver family to these numbers.
    let node: string = nodeAround(ioregOutput, offset);
    let model = MODEL_PATTERN.exec(node);
    let coreCount = CORE_COUNT_PATTERN.exec(node);
    let modelName: string | null = model === null ? null : model[1];

    return {
        utilization: utilization,
        allocatedMemory: readStatistic(statistics, "Alloc system memory") || 0,
        mappedMemory: readStatistic(statistics, "In use system memory") || 0,
        model: modelName,
        coreCount: coreCount === null ? null : parseInt(coreCount[1], 10),
        hasUnifiedMemory: AGX_CLASS_PATTERN.test(node)
            || (modelName !== null && APPLE_MODEL_PATTERN.test(modelName)),
    };
}

/**
 * The single node containing the given offset, or the whole dump when the
 * output carries no node headers at all.
 */
function nodeAround(ioregOutput: string, offset: number): string {
    let start: number = ioregOutput.lastIndexOf(NODE_MARKER, offset);
    if (start === -1) {
        start = 0;
    }

    let end: number = ioregOutput.indexOf(NODE_MARKER, offset);
    return end === -1 ? ioregOutput.slice(start) : ioregOutput.slice(start, end);
}

/**
 * Reads a single `"key"=<integer>` entry out of a PerformanceStatistics dict.
 *
 * The closing quote in the pattern is load-bearing: without it "In use system
 * memory" would also match its sibling "In use system memory (driver)", which
 * is a different (and usually zero) value.
 */
function readStatistic(statistics: string, key: string): number | null {
    let escapedKey: string = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let match = new RegExp(`"${escapedKey}"=(\\d+)`).exec(statistics);
    if (match === null) {
        return null;
    }
    return parseInt(match[1], 10);
}

/**
 * Averages a run of spot utilization readings.
 *
 * Kept separate from the sampler so the arithmetic that turns a gauge into an
 * interval figure can be tested without running ioreg.
 */
export class UtilizationWindow {
    private _sum: number;
    private _count: number;
    private _peak: number;

    constructor() {
        this._sum = 0;
        this._count = 0;
        this._peak = 0;
    }

    public add(utilization: number) {
        // A reading the driver could not supply would otherwise poison the mean
        // for the whole interval.
        if (!Number.isFinite(utilization)) {
            return;
        }

        let bounded = Math.min(Math.max(utilization, 0), 100);
        this._sum += bounded;
        this._count++;
        this._peak = Math.max(this._peak, bounded);
    }

    public get count(): number {
        return this._count;
    }

    public get mean(): number {
        return this._count === 0 ? 0 : this._sum / this._count;
    }

    public get peak(): number {
        return this._peak;
    }

    public reset() {
        this._sum = 0;
        this._count = 0;
        this._peak = 0;
    }
}

/**
 * Whether two readings taken this far apart measured the same kind of span,
 * and so can be averaged together.
 *
 * "Device Utilization %" reports on the time since the previous read, so a
 * reading taken well early or well late is describing a different window from
 * its neighbours and would distort the mean rather than refine it.
 */
export function isComparableGap(gapMs: number, expectedGapMs: number): boolean {
    if (!Number.isFinite(gapMs) || expectedGapMs <= 0) {
        return false;
    }

    return gapMs >= expectedGapMs * GAP_TOLERANCE_LOW && gapMs <= expectedGapMs * GAP_TOLERANCE_HIGH;
}

/**
 * Holds a requested poll cadence to the range that is worth spending CPU on.
 */
export function clampPollInterval(milliseconds: number): number {
    if (!Number.isFinite(milliseconds)) {
        return DEFAULT_POLL_INTERVAL_MS;
    }

    return Math.min(Math.max(milliseconds, MIN_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS);
}

/**
 * Blends a window's mean with the figure last reported, in proportion to how
 * many readings the window managed to gather.
 *
 * A window thick with readings is trusted on its own; a thin one leans on what
 * came before rather than showing the coin toss its few readings amount to.
 */
export function smoothUtilization(previous: number | null, mean: number, sampleCount: number): number {
    if (previous === null || sampleCount <= 0) {
        return mean;
    }

    return (mean * sampleCount + previous * SMOOTHING_SAMPLES) / (sampleCount + SMOOTHING_SAMPLES);
}

/**
 * Samples GPU statistics from the IOKit registry, averaging utilization across
 * the whole interval and caching briefly so that several resources can share
 * one reading per update tick.
 *
 * Reading IOAccelerator requires no elevated privileges, unlike powermetrics.
 */
export class AppleGpuSampler {
    private _cachedStats: GpuStats | null;
    private _cachedAt: number;
    private _pending: Promise<GpuStats | null> | null;
    private _window: UtilizationWindow;
    private _smoothed: number | null;
    private _pollIntervalMs: number;
    private _pollTimer: NodeJS.Timeout | null;
    private _lastRequestedAt: number;
    private _lastReadAt: number;
    private _expectedGapMs: number;
    private _idleReadings: number;
    private _disposed: boolean;

    constructor() {
        this._cachedStats = null;
        this._cachedAt = Number.NEGATIVE_INFINITY;
        this._pending = null;
        this._window = new UtilizationWindow();
        this._smoothed = null;
        this._pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
        this._pollTimer = null;
        this._lastRequestedAt = Number.NEGATIVE_INFINITY;
        this._lastReadAt = Number.NEGATIVE_INFINITY;
        this._expectedGapMs = DEFAULT_POLL_INTERVAL_MS;
        this._idleReadings = 0;
        this._disposed = false;
    }

    /**
     * Returns the current GPU statistics, or null when they are unavailable:
     * off macOS, on a Mac whose driver exposes no statistics, or when ioreg
     * fails.
     *
     * Never rejects. ResMon.update() gathers every resource with Promise.all
     * and has no error handling, so a single rejection would break the update
     * loop and freeze the whole status bar.
     */
    public sample(): Promise<GpuStats | null> {
        if (process.platform !== 'darwin' || this._disposed) {
            return Promise.resolve(null);
        }

        this._lastRequestedAt = Date.now();
        this.startPolling();

        // Every caller in one tick must see the same numbers, and only the
        // first of them may consume the interval's accumulated readings.
        if (Date.now() - this._cachedAt < CACHE_WINDOW_MS) {
            return Promise.resolve(this._cachedStats);
        }

        // Fold callers that arrive mid-flight into the running invocation.
        if (this._pending !== null) {
            return this._pending;
        }

        this._pending = this.readRegistry().then(reading => {
            let stats = this.summarise(reading);
            this._cachedStats = stats;
            this._cachedAt = Date.now();
            this._pending = null;
            return stats;
        });

        return this._pending;
    }

    /**
     * Sets how briskly utilization is read between updates, which trades CPU
     * for how much the figure can be trusted. Out-of-range values are clamped
     * rather than refused, so a mistyped setting slows the poller instead of
     * disabling the reading.
     */
    public setPollInterval(milliseconds: number) {
        this._pollIntervalMs = clampPollInterval(milliseconds);
    }

    /**
     * Stops the background poller. Idempotent, and safe to call off macOS.
     */
    public dispose() {
        this._disposed = true;
        this.stopPolling();
    }

    /**
     * Closes the interval: folds the update's own reading in with everything
     * the poller gathered since the last update, then starts a fresh window.
     */
    private summarise(reading: GpuReading | null): GpuStats | null {
        if (reading === null) {
            // A failed read says nothing about the interval, so the readings
            // already gathered are kept for the next update to report.
            return null;
        }

        this.record(reading);

        // A window can close empty when the update interval is shorter than the
        // poll cadence, so every reading in it measured the wrong span. The
        // figure then holds rather than dropping to a zero nothing observed.
        if (this._window.count > 0) {
            this._smoothed = smoothUtilization(this._smoothed, this._window.mean, this._window.count);
        }

        let stats: GpuStats = {
            utilization: this._smoothed === null ? reading.utilization : this._smoothed,
            peakUtilization: this._window.peak,
            sampleCount: this._window.count,
            allocatedMemory: reading.allocatedMemory,
            mappedMemory: reading.mappedMemory,
            model: reading.model,
            coreCount: reading.coreCount,
            hasUnifiedMemory: reading.hasUnifiedMemory,
            // Unified memory makes the whole of RAM the pool the allocation is
            // drawn from. A discrete GPU's limit is its own VRAM, which this
            // node does not report, so the reading is left without a total
            // rather than being given a meaningless one.
            totalMemory: reading.hasUnifiedMemory ? totalmem() : null,
        };

        this._window.reset();
        return stats;
    }

    /**
     * Takes one reading into account: into the average if it measured the span
     * it was meant to, and into the idle count either way.
     *
     * The gap test is what makes the average mean anything. "Device Utilization
     * %" reports on the time since the previous read, so readings taken at
     * different spacings are not comparable, and mixing them averages spans of
     * different lengths as though they were alike. The reading that resumes
     * polling after an idle back-off is the clearest case: it covers seconds of
     * mostly-idle time and reads high, which would show up as a spike exactly
     * when work begins.
     */
    private record(reading: GpuReading) {
        let now: number = Date.now();
        let gap: number = now - this._lastReadAt;
        this._lastReadAt = now;

        if (isComparableGap(gap, this._expectedGapMs)) {
            this._window.add(reading.utilization);
        }

        // Tracked from every reading, not just the counted ones, so that work
        // starting during a back-off is noticed at the first sight of it.
        if (reading.utilization > 0) {
            this._idleReadings = 0;
        } else {
            this._idleReadings++;
        }
    }

    /**
     * The delay before the next reading, relaxed while the GPU has nothing to
     * report.
     */
    private nextDelay(): number {
        if (this._idleReadings < IDLE_READINGS_BEFORE_BACKOFF) {
            return this._pollIntervalMs;
        }

        return Math.min(this._pollIntervalMs * IDLE_BACKOFF_FACTOR, MAX_POLL_INTERVAL_MS);
    }

    /**
     * Begins taking readings between updates, if not already doing so.
     *
     * The timer is unreferenced: a status bar poller must never be the reason
     * the extension host stays alive.
     */
    private startPolling() {
        if (this._pollTimer !== null || this._disposed || process.platform !== 'darwin') {
            return;
        }

        // Remembered so the next reading can be checked against the span it
        // was supposed to measure.
        this._expectedGapMs = this.nextDelay();
        this._pollTimer = setTimeout(() => this.poll(), this._expectedGapMs);
        this._pollTimer.unref();
    }

    private stopPolling() {
        if (this._pollTimer !== null) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
    }

    /**
     * Takes one reading for the average, then schedules the next.
     *
     * Chained rather than an interval so a slow ioreg can never have two
     * invocations in flight at once.
     */
    private poll() {
        this._pollTimer = null;

        // Nobody has asked for a sample in a long while, so the reading is
        // hidden or switched off and the polling is pure waste.
        if (this._disposed || Date.now() - this._lastRequestedAt > IDLE_TIMEOUT_MS) {
            return;
        }

        this.readRegistry().then(reading => {
            if (reading !== null) {
                this.record(reading);
            }
            this.startPolling();
        });
    }

    /**
     * Runs ioreg and parses its output, resolving to null on any failure.
     *
     * execFile is wrapped by hand rather than with util.promisify because the
     * pinned @types/node predates promisify's typings.
     */
    private readRegistry(): Promise<GpuReading | null> {
        return new Promise<GpuReading | null>(resolve => {
            execFile(IOREG_PATH, IOREG_ARGS, { maxBuffer: IOREG_MAX_BUFFER }, (error, stdout) => {
                if (error) {
                    resolve(null);
                    return;
                }

                try {
                    resolve(parsePerformanceStatistics(stdout.toString()));
                } catch (parseError) {
                    resolve(null);
                }
            });
        });
    }
}
