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
     * Mean utilization across the sampling burst, which is what the status bar shows.
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
     * yes. Reading it twice in quick succession is what turns it into a window
     * of known width, and averaging a short burst of those is what makes the
     * figure mean what the CPU percentage beside it means.
     */
    utilization: number;
    /** The busiest single read in the interval, which is what a mean hides. */
    peakUtilization: number;
    /** How many readings the mean covers, so the hover can qualify a thin average. */
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

// Utilization is measured as a short burst of readings taken once per update,
// rather than by polling continuously between updates.
//
// The statistic reports on the span since it was last read, so the width of
// that span is what decides accuracy -- not how much of the interval is
// covered. Readings 50ms apart therefore describe near-instantaneous windows
// and average out close to the truth, while readings 250ms apart each run high
// and no amount of them fixes it. Measured on an M4 against a load busy 47% of
// the time: a burst of 8 at 50ms reports 55%, where continuous polling at
// 250ms reports 78% and costs five times as much.
//
// This also keeps the cost proportional to the update interval rather than to
// wall-clock time, which matters because every VS Code window runs its own
// extension host, and so its own sampler.
const BURST_GAP_MS: number = 50;
const MAX_BURST_READINGS: number = 8;

// A burst must stay a small fraction of the update interval, so the reading
// never becomes the reason an update is late.
const BURST_SHARE_OF_INTERVAL: number = 0.25;
const MIN_BURST_READINGS: number = 2;

// An idle GPU reads zero at any spacing, so once a burst has seen this many
// zeroes there is nothing left for the remaining readings to discover.
const IDLE_READINGS_BEFORE_STOPPING: number = 3;

// How much of each new burst goes into the figure on show.
//
// A burst measures a fraction of a second out of every update, so against
// intermittent work it is unbiased but jumpy: successive bursts on a load
// steady at 47% measured 39, 69, 0, 74, 3, 72. Averaging that towards the
// figure already displayed settles it without pulling it off the truth, which
// is sound here precisely because the samples are unbiased -- carrying over a
// biased reading would only have spread the bias.
const SMOOTHING_WEIGHT: number = 0.5;

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
 * Eases the displayed figure towards a new burst.
 *
 * Kept pure and separate so the settling behaviour can be tested without
 * running ioreg.
 */
export function smoothUtilization(previous: number | null, sample: number): number {
    if (previous === null || !Number.isFinite(previous)) {
        return sample;
    }

    return previous * (1 - SMOOTHING_WEIGHT) + sample * SMOOTHING_WEIGHT;
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
 * Samples GPU statistics from the IOKit registry.
 *
 * Each sample is a short burst of readings: one to re-base the statistic, then
 * a handful taken close together and averaged. Nothing runs between updates,
 * so a window nobody is looking at costs nothing, and a second VS Code window
 * costs the same as the first rather than doubling a background poll.
 *
 * Reading IOAccelerator requires no elevated privileges, unlike powermetrics.
 */
export class AppleGpuSampler {
    private _cachedStats: GpuStats | null;
    private _cachedAt: number;
    private _pending: Promise<GpuStats | null> | null;
    private _burstReadings: number;
    private _smoothed: number | null;
    private _disposed: boolean;

    constructor() {
        this._cachedStats = null;
        this._cachedAt = Number.NEGATIVE_INFINITY;
        this._pending = null;
        this._burstReadings = MAX_BURST_READINGS;
        this._smoothed = null;
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

        // Every caller in one tick must see the same numbers, and one burst
        // must serve all four of them.
        if (Date.now() - this._cachedAt < CACHE_WINDOW_MS) {
            return Promise.resolve(this._cachedStats);
        }

        // Fold callers that arrive mid-burst into the running one.
        if (this._pending !== null) {
            return this._pending;
        }

        this._pending = this.burst().then(stats => {
            this._cachedStats = stats;
            this._cachedAt = Date.now();
            this._pending = null;
            return stats;
        });

        return this._pending;
    }

    /**
     * Sizes the burst against the update interval, so the reading stays a small
     * fraction of it however briskly the status bar is refreshed.
     */
    public setUpdateInterval(milliseconds: number) {
        if (!Number.isFinite(milliseconds)) {
            return;
        }

        let affordable = Math.floor(milliseconds * BURST_SHARE_OF_INTERVAL / BURST_GAP_MS);
        this._burstReadings = Math.min(Math.max(affordable, MIN_BURST_READINGS), MAX_BURST_READINGS);
    }

    /**
     * Nothing runs between samples, so there is nothing to shut down. Kept so
     * callers need not know that.
     */
    public dispose() {
        this._disposed = true;
    }

    /**
     * Takes one burst: a reading to re-base the statistic, then several spaced
     * readings that are averaged.
     *
     * The first reading is discarded deliberately. It reports on the whole
     * span since the previous update -- ten seconds, most of it idle -- which
     * the statistic scores near 100%. Reading twice is what turns "since you
     * last looked" into a window of known width.
     */
    private async burst(): Promise<GpuStats | null> {
        let reading: GpuReading | null = await this.readRegistry();
        if (reading === null) {
            return null;
        }

        let window = new UtilizationWindow();
        let idleReadings: number = 0;

        for (let taken = 0; taken < this._burstReadings; taken++) {
            await delay(BURST_GAP_MS);
            if (this._disposed) {
                break;
            }

            let next: GpuReading | null = await this.readRegistry();
            if (next === null) {
                break;
            }

            reading = next;
            window.add(next.utilization);

            // An idle GPU has nothing further to report, so the rest of the
            // burst would be spent confirming a zero.
            idleReadings = next.utilization > 0 ? 0 : idleReadings + 1;
            if (idleReadings >= IDLE_READINGS_BEFORE_STOPPING) {
                break;
            }
        }

        this._smoothed = smoothUtilization(
            this._smoothed, window.count === 0 ? reading.utilization : window.mean);

        return {
            // The memory figures come from the burst's last reading, since they
            // are levels rather than spans and want no averaging.
            utilization: this._smoothed,
            // The peak is this burst's own, not eased: it is there to show what
            // an average hides, so smoothing it would defeat it.
            peakUtilization: window.count === 0 ? reading.utilization : window.peak,
            sampleCount: window.count,
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

function delay(milliseconds: number): Promise<void> {
    // Deliberately referenced. An unreferenced timer here lets the event loop
    // drain mid-burst when nothing else is pending, so the burst never resolves
    // -- and since ResMon.update() awaits every resource together, that would
    // hang the whole status bar rather than just the GPU reading. A burst is a
    // few hundred milliseconds at most, so it cannot hold shutdown up for long,
    // and dispose() stops it at the next gap regardless.
    return new Promise<void>(resolve => { setTimeout(resolve, milliseconds); });
}
