'use strict';
import { commands, window, Disposable, ExtensionContext, MarkdownString, StatusBarAlignment, StatusBarItem, workspace, WorkspaceConfiguration } from 'vscode';
import * as os from 'os';
import { Units, UnitLabels, DiskSpaceFormat, DiskSpaceFormatMappings, FreqMappings, MemMappings } from './constants';
import { AppleGpuSampler, GpuStats } from './appleGpu';
import { Volume, selectVolumes, volumeLabel } from './disk';
import { Detail, DetailRow, Section, formatCoreLoads, formatInterval, formatMinutes, renderTooltip } from './tooltip';
import { DetailsView, PanelSection } from './panel';

var si = require('systeminformation');

// Clicking an entry opens the details view at that section, and clicking the
// same one again closes it. The second command is the cross in the view's own
// title bar.
const DETAILS_COMMAND: string = 'systemvitals.showDetails';
const HIDE_DETAILS_COMMAND: string = 'systemvitals.hideDetails';

// The panel's per-section Settings buttons open the settings narrowed to that
// section. The @ext: filter scopes the search to this extension, so the terms
// below need only tell the sections apart rather than be unique across every
// setting VS Code has.
const SETTINGS_COMMAND: string = 'workbench.action.openSettings';

/**
 * The groups the display is divided into.
 *
 * Each is a status bar entry of its own, which is what gives every metric a
 * hover that explains that metric rather than all of them, and a click that
 * configures it. The identifiers are stable so that a section hidden from the
 * status bar's context menu stays hidden, and the names are what that menu
 * shows.
 */
const SECTION_CPU: Section = { id: 'systemvitals.cpu', name: 'CPU', icon: '$(pulse)', settingsFilter: 'cpu' };
const SECTION_GPU: Section = { id: 'systemvitals.gpu', name: 'GPU', icon: '$(circuit-board)', settingsFilter: 'gpu' };
const SECTION_BATTERY: Section = { id: 'systemvitals.battery', name: 'Battery', icon: '$(plug)', settingsFilter: 'battery' };
const SECTION_MEMORY: Section = { id: 'systemvitals.memory', name: 'Memory', icon: '$(ellipsis)', settingsFilter: 'mem' };
const SECTION_DISK: Section = { id: 'systemvitals.disk', name: 'Disk', icon: '$(database)', settingsFilter: 'disk' };

/**
 * How long between samples, when the setting says nothing.
 *
 * This governs the hover as well as the status bar, so that the two never
 * disagree about the same instant. It is unhurried for a reason: VS Code
 * redraws an open hover whenever its content changes, so a short interval
 * leaves the details flickering and resizing under the pointer while they are
 * being read.
 */
const DEFAULT_UPDATE_FREQUENCY_MS: number = 10000;

/**
 * The processor's name and core count, read once.
 *
 * It cannot change while VS Code is running, and os.cpus() walks every core to
 * report it. systeminformation's si.cpu() would be the more natural source and
 * no longer throws on Apple Silicon as 4.27 did, but it is asynchronous where
 * this is read once at load.
 */
const PROCESSOR: string = describeProcessor();

export function activate(context: ExtensionContext) {
    // Asked for rather than written down, so that renaming the extension cannot
    // leave the entries opening a settings search that matches nothing.
    var resourceMonitor: ResMon = new ResMon(`@ext:${context.extension.id}`);
    resourceMonitor.StartUpdating();
    context.subscriptions.push(resourceMonitor);
}

function describeProcessor(): string {
    let cores = os.cpus();
    if (cores.length === 0) {
        return "";
    }
    return `${cores[0].model} · ${cores.length} cores`;
}

/**
 * The 1, 5 and 15 minute load averages, or null where they are meaningless.
 *
 * Windows has no such measure and Node reports zeroes there rather than
 * failing, which would otherwise render as a row of convincing-looking noughts.
 */
function loadAverage(): string | null {
    let averages = os.loadavg();
    if (averages.every(average => average === 0)) {
        return null;
    }
    return averages.map(average => average.toFixed(2)).join(', ');
}

/**
 * Whether a temperature reading is a reading at all.
 *
 * A machine with no sensor the OS will expose reports null, and releases
 * before systeminformation 5 reported -1 for the same thing.
 */
function isReadableTemperature(celsius: number | null): boolean {
    return typeof celsius === 'number' && Number.isFinite(celsius) && celsius > 0;
}

/**
 * The space a volume actually has left.
 *
 * Not size minus used: on APFS every volume in a container reports the whole
 * container as its size, so subtracting counts space the other volumes have
 * already taken. The root volume of this machine has 245GB of "size", 13GB
 * used and 10GB genuinely free.
 */
function freeSpace(volume: Volume): number {
    return volume.available;
}

/**
 * What a resource contributes to a single update: the text it puts in the
 * status bar, and the rows it adds to its section's hover.
 */
interface ResourceRender extends Detail {
    text: string;
}

abstract class Resource {
    // A WorkspaceConfiguration is an immutable snapshot, so this is replaced
    // via setConfig() on every update tick. Holding the object handed over at
    // construction would freeze every resource-level setting at activation.
    protected _config: WorkspaceConfiguration;
    protected _isShownByDefault: boolean;
    protected _configKey: string;
    protected _maxWidth: number;
    private _section: Section;

    constructor(config: WorkspaceConfiguration, isShownByDefault: boolean, configKey: string, section: Section) {
        this._config = config;
        this._isShownByDefault = isShownByDefault;
        this._configKey = configKey;
        this._section = section;
        this._maxWidth = 0;
    }

    public getSection(): Section {
        return this._section;
    }

    /**
     * Points this resource at a freshly read configuration, so that changed
     * settings apply on the next tick rather than at the next window reload.
     */
    public setConfig(config: WorkspaceConfiguration) {
        this._config = config;
    }

    /**
     * Clears the padding high water mark.
     *
     * _maxWidth only ever grows, which is what stops the status bar jittering
     * as digits come and go. It does mean a setting that shortens the display,
     * such as switching memory from B to GB, would otherwise leave a gap at the
     * old width for the rest of the session.
     */
    public resetWidth() {
        this._maxWidth = 0;
    }

    /**
     * Samples this resource once, yielding both what the status bar shows and
     * what the hover elaborates on, or null when the resource is hidden.
     *
     * One sample feeds both so that the hover costs no extra polling, and so
     * the two can never disagree about the same instant.
     */
    public async getResourceRender(): Promise<ResourceRender | null> {
        if (await this.isShown())
        {
            let render: ResourceRender = await this.render();
            this._maxWidth = Math.max(this._maxWidth, render.text.length);

            // Pad out to the correct length such that the length doesn't change
            return { text: render.text.padEnd(this._maxWidth, ' '), rows: render.rows, note: render.note };
        }

        return null;
    }

    protected abstract render(): Promise<ResourceRender>;

    protected async isShown(): Promise<boolean> {
        return Promise.resolve(this._config.get(`show.${this._configKey}`, this._isShownByDefault));
    }

    public getPrecision(): number {
        return this._config.get("show.precision", 2);
    }

    protected convertBytesToLargestUnit(bytes: number): string {
        let unit: Units = Units.None;
        while (bytes/unit >= 1024 && unit < Units.G) {
            unit *= 1024;
        }
        return `${(bytes/unit).toFixed(this.getPrecision())} ${UnitLabels[unit]}`;
    }

    protected formatWithUnit(bytes: number, unit: string): string {
        return `${(bytes / MemMappings[unit]).toFixed(this.getPrecision())} ${unit}`;
    }

    /**
     * Formats a percentage, treating the unreportable as zero.
     *
     * Several of these figures are ratios the platform can hand back as NaN —
     * per-core load between two samples in the same tick, or a fraction of a
     * zero-byte volume — and "NaN%" in a status bar helps nobody.
     */
    protected formatPercent(value: number): string {
        return `${(Number.isFinite(value) ? value : 0).toFixed(this.getPrecision())}%`;
    }
}

class CpuUsage extends Resource {

    constructor(config: WorkspaceConfiguration) {
        super(config, true, "cpuusage", SECTION_CPU);
    }

    async render(): Promise<ResourceRender> {
        let currentLoad = await si.currentLoad();
        let usage = 100 - currentLoad.currentLoadIdle;

        return {
            text: `$(pulse) ${usage.toFixed(this.getPrecision())}%`,
            rows: this.getRows(currentLoad, usage),
        };
    }

    private getRows(currentLoad: any, usage: number): DetailRow[] {
        let rows: DetailRow[] = [];

        if (PROCESSOR !== "") {
            rows.push({ label: "Processor", value: PROCESSOR });
        }

        // The split matters: a machine at 90% system time is usually waiting on
        // something, where 90% user time is work getting done.
        rows.push({
            label: "Usage",
            value: `${this.formatPercent(usage)} (${this.formatPercent(currentLoad.currentLoadUser)} user, `
                + `${this.formatPercent(currentLoad.currentLoadSystem)} system)`,
        });

        let cores = formatCoreLoads((currentLoad.cpus || []).map((cpu: any) => cpu.load));
        if (cores !== "") {
            rows.push({ label: "Cores", value: cores });
        }

        let averages = loadAverage();
        if (averages !== null) {
            rows.push({ label: "Load average", value: `${averages} (1, 5, 15 min)` });
        }

        return rows;
    }

}

class CpuFreq extends Resource {
    constructor(config: WorkspaceConfiguration) {
        super(config, true, "cpufreq", SECTION_CPU);
    }

    async render(): Promise<ResourceRender> {
        let cpuCurrentSpeed = await si.cpuCurrentSpeed();
        // systeminformation returns frequency in terms of GHz by default
        let speedHz = parseFloat(cpuCurrentSpeed.avg) * Units.G;
        let formattedWithUnits = this.getFormattedWithUnits(speedHz);

        return {
            text: `$(dashboard) ${(formattedWithUnits)}`,
            rows: this.getRows(cpuCurrentSpeed, formattedWithUnits),
        };
    }

    private getRows(cpuCurrentSpeed: any, average: string): DetailRow[] {
        let rows: DetailRow[] = [{ label: "Frequency", value: average }];

        // Identical wherever the platform reports one figure for every core,
        // which covers Apple Silicon and most of Windows, so the spread is only
        // worth a row when there is one.
        if (cpuCurrentSpeed.min !== cpuCurrentSpeed.max) {
            let slowest = this.getFormattedWithUnits(parseFloat(cpuCurrentSpeed.min) * Units.G);
            let fastest = this.getFormattedWithUnits(parseFloat(cpuCurrentSpeed.max) * Units.G);
            rows.push({ label: "Across cores", value: `${slowest} to ${fastest}` });
        }

        return rows;
    }

    getFormattedWithUnits(speedHz: number): string {
        var unit = this._config.get('freq.unit', "GHz");
        var freqDivisor: number = FreqMappings[unit];
        return `${(speedHz / freqDivisor).toFixed(this.getPrecision())} ${unit}`;
    }
}

class CpuTemp extends Resource {

    constructor(config: WorkspaceConfiguration) {
        super(config, false, "cputemp", SECTION_CPU);
    }

    protected async isShown(): Promise<boolean> {
        // A machine with no readable sensor reports null, and older releases
        // reported -1, so the test is for a usable number rather than for
        // either of the ways of saying there isn't one. Without this a Mac
        // with no exposed sensor showed "null C".
        let cpuTemp = (await si.cpuTemperature()).main;
        return isReadableTemperature(cpuTemp) && await super.isShown();
    }

    async render(): Promise<ResourceRender> {
        let currentTemps = await si.cpuTemperature();
        let rows: DetailRow[] = [
            { label: "Temperature", value: this.formatCelsius(currentTemps.main) },
        ];

        // main is an average across packages on machines that have several, so
        // the hottest sensor is the one that throttles first.
        if (isReadableTemperature(currentTemps.max) && currentTemps.max > currentTemps.main) {
            rows.push({ label: "Hottest sensor", value: this.formatCelsius(currentTemps.max) });
        }

        return {
            text: `$(flame) ${this.formatCelsius(currentTemps.main)}`,
            rows: rows,
        };
    }

    private formatCelsius(temperature: number): string {
        return `${(temperature).toFixed(this.getPrecision())} C`;
    }
}

/**
 * Base for the macOS GPU metrics, which all come from one IOKit registry read.
 *
 * Availability is decided by whether the machine actually reports statistics
 * rather than by checking the architecture, so this covers Apple Silicon and
 * Intel Macs alike and stays hidden anywhere the data is missing.
 */
abstract class AppleGpuResource extends Resource {
    protected _sampler: AppleGpuSampler;

    constructor(config: WorkspaceConfiguration, isShownByDefault: boolean, configKey: string, sampler: AppleGpuSampler) {
        super(config, isShownByDefault, configKey, SECTION_GPU);
        this._sampler = sampler;
    }

    protected async isShown(): Promise<boolean> {
        // The sampler caches briefly, so this read and the one in render()
        // share a single ioreg invocation.
        let stats = await this._sampler.sample();
        return stats !== null && await super.isShown();
    }
}

class GpuUsage extends AppleGpuResource {

    constructor(config: WorkspaceConfiguration, sampler: AppleGpuSampler) {
        super(config, true, "gpu", sampler);
    }

    async render(): Promise<ResourceRender> {
        let stats = await this._sampler.sample();
        if (stats === null) {
            return { text: "", rows: [] };
        }

        return {
            text: `$(circuit-board) ${(stats.utilization).toFixed(this.getPrecision())}%`,
            rows: this.getRows(stats),
        };
    }

    private getRows(stats: GpuStats): DetailRow[] {
        let rows: DetailRow[] = [];

        if (stats.model !== null) {
            let cores = stats.coreCount === null ? "" : ` · ${stats.coreCount} cores`;
            rows.push({ label: "Graphics", value: `${stats.model}${cores}` });
        }

        rows.push({ label: "Utilization", value: this.formatPercent(stats.utilization) });
        return rows;
    }
}

class GpuMemory extends AppleGpuResource {

    constructor(config: WorkspaceConfiguration, sampler: AppleGpuSampler) {
        super(config, false, "gpumem", sampler);
    }

    async render(): Promise<ResourceRender> {
        let stats = await this._sampler.sample();
        if (stats === null) {
            return { text: "", rows: [] };
        }

        let unit = this._config.get('gpu.unit', "GB");
        var memDivisor = MemMappings[unit];
        // Apple Silicon shares system memory with the CPU, so this is memory
        // currently mapped out of memory the driver has claimed, not VRAM.
        let inUseWithUnits = stats.inUseMemory / memDivisor;
        let allocatedWithUnits = stats.allocatedMemory / memDivisor;

        return {
            text: `$(server) ${(inUseWithUnits).toFixed(this.getPrecision())}/${(allocatedWithUnits).toFixed(this.getPrecision())} ${unit}`,
            rows: [
                { label: "Memory in use", value: this.formatWithUnit(stats.inUseMemory, unit) },
                { label: "Driver allocation", value: this.formatWithUnit(stats.allocatedMemory, unit) },
            ],
            // The one figure here people reliably misread, and the status bar
            // has no room to say so.
            note: "The GPU shares one pool of memory with the CPU. The allocation is what the driver "
                + "has claimed from the system so far, not a fixed VRAM capacity, so it moves over time.",
        };
    }
}

class Battery extends Resource {

    constructor(config: WorkspaceConfiguration) {
        super(config, true, "battery", SECTION_BATTERY);
    }

    protected async isShown(): Promise<boolean> {
        let hasBattery = (await si.battery()).hasBattery;
        return hasBattery && await super.isShown();
    }

    async render(): Promise<ResourceRender> {
        let rawBattery = await si.battery();
        var percentRemaining = Math.min(Math.max(rawBattery.percent, 0), 100);

        return {
            text: `$(plug) ${percentRemaining}%`,
            rows: this.getRows(rawBattery, percentRemaining),
        };
    }

    private getRows(rawBattery: any, percentRemaining: number): DetailRow[] {
        let rows: DetailRow[] = [
            { label: "Charge", value: `${percentRemaining}%` },
            { label: "State", value: this.getState(rawBattery) },
        ];

        let remaining = formatMinutes(rawBattery.timeRemaining);
        if (remaining !== null) {
            rows.push({ label: rawBattery.isCharging ? "Until full" : "Remaining", value: remaining });
        }

        // Batteries wear: a pack holding 4600 of the 5000 mAh it was built for
        // is at 92% health however full its charge reads.
        if (rawBattery.designedCapacity > 0 && rawBattery.maxCapacity > 0) {
            let health = rawBattery.maxCapacity / rawBattery.designedCapacity * 100;
            rows.push({ label: "Health", value: `${this.formatPercent(health)} of design capacity` });
        }

        if (rawBattery.cycleCount > 0) {
            rows.push({ label: "Cycles", value: `${rawBattery.cycleCount}` });
        }

        return rows;
    }

    private getState(rawBattery: any): string {
        if (rawBattery.isCharging) {
            return "Charging";
        }
        if (rawBattery.acConnected) {
            return "Plugged in, not charging";
        }
        return "On battery";
    }
}

class Memory extends Resource {

    constructor(config: WorkspaceConfiguration) {
        super(config, true, "mem", SECTION_MEMORY);
    }

    async render() : Promise<ResourceRender> {
        let unit = this._config.get('mem.unit', "GB");
        var memDivisor = MemMappings[unit];
        let memoryData = await si.mem();
        let memoryUsedWithUnits = memoryData.active / memDivisor;
        let memoryTotalWithUnits = memoryData.total / memDivisor;

        return {
            text: `$(ellipsis) ${(memoryUsedWithUnits).toFixed(this.getPrecision())}/${(memoryTotalWithUnits).toFixed(this.getPrecision())} ${unit}`,
            rows: this.getRows(memoryData, unit),
        };
    }

    private getRows(memoryData: any, unit: string): DetailRow[] {
        let rows: DetailRow[] = [
            {
                label: "In use",
                value: `${this.formatWithUnit(memoryData.active, unit)} of ${this.formatWithUnit(memoryData.total, unit)}`
                    + ` (${this.formatPercent(memoryData.active / memoryData.total * 100)})`,
            },
            { label: "Available", value: this.formatWithUnit(memoryData.available, unit) },
        ];

        // Cache is memory the system will hand back the moment anything wants
        // it, which is why "used" so often looks alarming and is not.
        if (memoryData.buffcache > 0) {
            rows.push({ label: "Cached", value: this.formatWithUnit(memoryData.buffcache, unit) });
        }

        if (memoryData.swaptotal > 0) {
            rows.push({
                label: "Swap",
                value: `${this.formatWithUnit(memoryData.swapused, unit)} of ${this.formatWithUnit(memoryData.swaptotal, unit)}`,
            });
        }

        return rows;
    }
}

class DiskSpace extends Resource {

    constructor(config: WorkspaceConfiguration) {
        super(config, false, "disk", SECTION_DISK);
    }

    getFormat(): DiskSpaceFormat {
        let format: string | undefined = this._config.get<string>("disk.format");
        if (format) {
            return DiskSpaceFormatMappings[format];
        } else {
            return DiskSpaceFormat.PercentRemaining;
        }
    }

    getDrives(): string[] {
        let drives: string[] | undefined = this._config.get<string[]>("disk.drives");
        if (drives) {
            return drives;
        } else {
            return [];
        }
    }

    getFormattedDiskSpace(volume: Volume) {
        let label = volumeLabel(volume, process.platform);
        switch (this.getFormat()) {
            case DiskSpaceFormat.PercentRemaining:
                return `${label} ${(100 - volume.use).toFixed(this.getPrecision())}% remaining`;
            case DiskSpaceFormat.PercentUsed:
                return `${label} ${volume.use.toFixed(this.getPrecision())}% used`;
            case DiskSpaceFormat.Remaining:
                return `${label} ${this.convertBytesToLargestUnit(freeSpace(volume))} remaining`;
            case DiskSpaceFormat.UsedOutOfTotal:
                return `${label} ${this.convertBytesToLargestUnit(volume.used)}/${this.convertBytesToLargestUnit(volume.size)} used`;
        }
    }

    async render(): Promise<ResourceRender> {
        let fsSizes: Volume[] = await si.fsSize();
        let volumes = selectVolumes(fsSizes, this.getDrives(), process.platform);
        let formattedDrives = volumes.map(volume => this.getFormattedDiskSpace(volume));

        return {
            text: "$(database) " + formattedDrives.join(", "),
            rows: volumes.map(volume => this.getRow(volume)),
        };
    }

    /**
     * The disk.format setting picks one of four ways to state a volume's
     * space for the status bar. The hover has room for all of them, so it
     * gives the figures the setting left out.
     */
    private getRow(volume: Volume): DetailRow {
        return {
            label: volumeLabel(volume, process.platform),
            value: `${this.convertBytesToLargestUnit(volume.used)} of ${this.convertBytesToLargestUnit(volume.size)} used`
                + ` (${this.formatPercent(volume.use)}), ${this.convertBytesToLargestUnit(freeSpace(volume))} free`,
        };
    }
}

/**
 * One section's status bar entry: the resources it shows, and the hover that
 * explains them.
 */
class SectionMonitor {
    private _section: Section;
    private _resources: Resource[];
    private _delimiter: string;
    private _item: StatusBarItem;
    private _isVisible: boolean;

    // The markdown the hover was last given, so that a sample which changed
    // nothing does not redraw it.
    private _markdown: string;

    constructor(section: Section, resources: Resource[], alignment: StatusBarAlignment, priority: number, color: string) {
        this._section = section;
        this._resources = resources;
        this._delimiter = "    ";
        this._isVisible = false;
        this._markdown = "";
        this._item = this.createItem(alignment, priority, color);
    }

    public getSection(): Section {
        return this._section;
    }

    public getResources(): Resource[] {
        return this._resources;
    }

    public addResource(resource: Resource) {
        this._resources.push(resource);
    }

    public getAlignment(): StatusBarAlignment {
        return this._item.alignment;
    }

    public setColor(color: string) {
        this._item.color = color;
    }

    /**
     * Moves this section's entry to the other end of the status bar, which the
     * API only allows by replacing the entry.
     */
    public realign(alignment: StatusBarAlignment, priority: number, color: string) {
        this._item.dispose();
        this._isVisible = false;
        this._markdown = "";
        this._item = this.createItem(alignment, priority, color);
    }

    /**
     * Samples every resource in this section and shows the result, hiding the
     * entry entirely when the section has nothing to report.
     */
    public async update(): Promise<PanelSection | null> {
        let pendingUpdates = this._resources.map(resource => resource.getResourceRender());
        let renders = (await Promise.all(pendingUpdates)).filter(render => render !== null) as ResourceRender[];

        if (renders.length === 0) {
            this.setVisible(false);
            return null;
        }

        // All three from the one sample, so the reading, the hover explaining
        // it and the panel always describe the same instant.
        this._item.text = renders.map(render => render.text).join(this._delimiter);
        this.setTooltip(renderTooltip(this._section, renders));
        this.setVisible(true);

        return {
            id: this._section.id,
            name: this._section.name,
            rows: renders.reduce((all, render) => all.concat(render.rows), [] as DetailRow[]),
            notes: renders.map(render => render.note).filter(note => note !== undefined) as string[],
        };
    }

    public dispose() {
        this._item.dispose();
    }

    private createItem(alignment: StatusBarAlignment, priority: number, color: string): StatusBarItem {
        let item = window.createStatusBarItem(this._section.id, alignment, priority);
        // Named, so the status bar's context menu offers "System Vitals CPU"
        // rather than an extension identifier repeated five times.
        item.name = `System Vitals ${this._section.name}`;
        item.color = color;
        // Clicking an entry opens the details panel at this section, which is
        // also what makes VS Code give it a pointer and a hover highlight.
        item.command = {
            title: `Show System Vitals ${this._section.name} details`,
            command: DETAILS_COMMAND,
            arguments: [this._section.id],
        };
        return item;
    }

    private setVisible(isVisible: boolean) {
        if (isVisible === this._isVisible) {
            return;
        }

        this._isVisible = isVisible;
        if (isVisible) {
            this._item.show();
        } else {
            this._item.hide();
        }
    }

    /**
     * Hands the hover its new content, unless a sample left it saying exactly
     * what it already said.
     *
     * VS Code redraws a visible hover the instant its tooltip changes, and it
     * cannot tell that the replacement is identical, so a disk reading that
     * held steady would otherwise flicker for nothing.
     */
    private setTooltip(markdown: string) {
        if (markdown === this._markdown) {
            return;
        }

        this._markdown = markdown;
        this._item.tooltip = markdown === "" ? undefined : this.buildTooltip(markdown);
    }

    private buildTooltip(markdown: string): MarkdownString {
        // The second argument renders $(icon) the way the status bar does. The
        // hover deliberately stays untrusted: the click handles the one command
        // worth offering, so no command link has to survive a volume name.
        return new MarkdownString(markdown, true);
    }
}


class ResMon {
    private _config: WorkspaceConfiguration;
    private _updating: boolean;
    private _sections: SectionMonitor[];
    private _configListener: Disposable;
    private _commandListeners: Disposable[];
    private _extensionFilter: string;

    // The view's tab appears in the panel only once a reading has been clicked,
    // and goes away again when it is closed, so nothing is spent on a view
    // nobody has asked for.
    private _details: DetailsView;
    private _snapshots: PanelSection[];

    constructor(extensionFilter: string) {
        this._config = workspace.getConfiguration('systemvitals');
        this._updating = false;
        this._extensionFilter = extensionFilter;
        this._details = new DetailsView(sectionId => this.openSettings(sectionId));
        this._snapshots = [];

        // The GPU resources share one sampler so that a tick costs a single
        // read of the IOKit registry rather than one per resource.
        let gpuSampler = new AppleGpuSampler();

        // Add all resources to monitor. Resources sharing a section are kept
        // together, since a section is one entry in the status bar.
        let resources: Resource[] = [
            new CpuUsage(this._config),
            new CpuFreq(this._config),
            new CpuTemp(this._config),
            new GpuUsage(this._config, gpuSampler),
            new GpuMemory(this._config, gpuSampler),
            new Battery(this._config),
            new Memory(this._config),
            new DiskSpace(this._config),
        ];

        this._sections = this.createSections(resources, this._getAlignment());

        // Settings that shorten a resource's display would otherwise leave the
        // status bar padded out at the old width for the rest of the session.
        this._configListener = workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('systemvitals')) {
                this.forEachResource(resource => resource.resetWidth());
            }
        });

        // Registered rather than only wired to the readings, so the view can be
        // opened and closed from the command palette as well as by clicking.
        this._commandListeners = [
            commands.registerCommand(DETAILS_COMMAND, (sectionId?: string) => this.showDetails(sectionId)),
            commands.registerCommand(HIDE_DETAILS_COMMAND, () => this._details.hide()),
        ];
    }

    /**
     * Opens the details view at the section that was clicked, or closes it
     * again if that is already what it is showing.
     */
    private showDetails(sectionId?: string) {
        // Clicking the reading that is already on show closes it again. The
        // palette command arrives without a section and only ever opens, since
        // a command called Show Details that hides them would be a poor joke.
        if (sectionId !== undefined && this._details.isShowing(sectionId)) {
            this._details.hide();
            return;
        }

        // Seeded with the last sample so the view has something to show at
        // once, rather than staying blank until the next update comes round.
        this._details.update(this._snapshots, this._getCadence());
        this._details.reveal(sectionId);
    }

    private openSettings(sectionId: string) {
        let section = this._sections
            .map(monitor => monitor.getSection())
            .filter(candidate => candidate.id === sectionId)[0];
        let filter = section === undefined ? this._extensionFilter : `${this._extensionFilter} ${section.settingsFilter}`;
        commands.executeCommand(SETTINGS_COMMAND, filter);
    }

    private _getCadence(): string {
        return `Refreshing every ${formatInterval(this._config.get('updatefrequencyms', DEFAULT_UPDATE_FREQUENCY_MS))}`;
    }

    public StartUpdating() {
        this._updating = true;
        this.update();
    }

    public StopUpdating() {
        this._updating = false;
    }

    /**
     * Groups the resources into one entry per section, in the order they are
     * registered.
     *
     * Status bar entries are ordered by descending priority, so counting down
     * from zero keeps the sections left to right in that same order while
     * leaving the leftmost of them where the single entry used to sit.
     */
    private createSections(resources: Resource[], alignment: StatusBarAlignment): SectionMonitor[] {
        let sections: SectionMonitor[] = [];
        let color = this._getColor();

        resources.forEach(resource => {
            let section = resource.getSection();
            let existing = sections.filter(candidate => candidate.getSection().id === section.id)[0];
            if (existing !== undefined) {
                existing.addResource(resource);
                return;
            }

            sections.push(new SectionMonitor(section, [resource], alignment, -sections.length, color));
        });

        return sections;
    }

    private forEachResource(visit: (resource: Resource) => void) {
        this._sections.forEach(section => section.getResources().forEach(visit));
    }

    private _getAlignment(): StatusBarAlignment {
        return this._config.get('alignLeft') ? StatusBarAlignment.Left : StatusBarAlignment.Right;
    }

    private _getColor() : string {
        const defaultColor = "#FFFFFF";

        // Enforce #RRGGBB format
        let hexColorCodeRegex = /^#[0-9A-F]{6}$/i;
        let configColor = this._config.get('color', defaultColor);
        if (!hexColorCodeRegex.test(configColor)) {
            configColor = defaultColor;
        }

        return configColor;
    }

    private async update() {
        if (this._updating) {

            // Update the configuration in case it has changed. A
            // WorkspaceConfiguration is a snapshot, so the resources need to be
            // pointed at the new one or they would keep reading activation-time
            // values.
            this._config = workspace.getConfiguration('systemvitals');
            this.forEachResource(resource => resource.setConfig(this._config));

            // Update each entry's styling
            let proposedAlignment = this._getAlignment();
            let color = this._getColor();
            this._sections.forEach((section, index) => {
                if (proposedAlignment !== section.getAlignment()) {
                    section.realign(proposedAlignment, -index, color);
                } else {
                    section.setColor(color);
                }
            });

            // Sample every section, each of which shows its own result
            let snapshots = await Promise.all(this._sections.map(section => section.update()));
            this._snapshots = snapshots.filter(snapshot => snapshot !== null) as PanelSection[];
            this._details.update(this._snapshots, this._getCadence());

            setTimeout(() => this.update(), this._config.get('updatefrequencyms', DEFAULT_UPDATE_FREQUENCY_MS));
        }
    }

    dispose() {
        this.StopUpdating();
        this._configListener.dispose();
        this._commandListeners.forEach(listener => listener.dispose());
        this._sections.forEach(section => section.dispose());
        this._details.dispose();
    }
}

export function deactivate() {
}
