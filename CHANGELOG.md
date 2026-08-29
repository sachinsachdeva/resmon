# Change Log

## [2.1.0]

Both GPU readings were wrong on Apple Silicon. Neither was wrong in a way that looked broken, which is why they lasted: one was a plausible number that meant something else, and the other pinned high.

- **GPU utilization was effectively a yes/no answer.** macOS reports `Device Utilization %` as a span between reads, not as a level: it covers the time since the statistic was last read, and its denominator discounts time the GPU had nothing queued. Read once per update, as it was, a load busy exactly half the time reported 88% on a 3-second interval and approached 100% on the 10-second default.

  Each update now takes a short burst of readings 50 ms apart and averages them, after one reading to re-base the statistic. The width of the span between readings is what decides accuracy, not how much of the interval is covered, so a burst is both more faithful and far cheaper than polling continuously: the same load now settles around 50% against a true 47%, where continuous polling reported 78% and cost five times as much. Successive bursts are eased together, since a burst is unbiased but samples only a fraction of a second.

  Nothing runs between updates, which matters because every VS Code window runs its own extension host: a background poller would have multiplied by the number of open windows, costing 29% of a core across four of them. The whole extension now costs about 1.5% of one core with the GPU reading on, against 0.9% without it, and four windows come to 6.9%.

- **GPU memory led with a figure that does not track GPU memory.** The status bar showed `In use system memory / Alloc system memory`, which reads as used-out-of-total but is neither. Holding 6 GB on the GPU moved the first figure by −0.07 GB while the second tracked it exactly. The reading now shows the allocation — the figure that responds to real allocations — against total system memory, which on unified memory is the pool it is genuinely drawn from. `In use system memory` is kept in the hover as "Mapped now", named for what it is. A discrete GPU, whose VRAM the registry does not report, shows the allocation with no total rather than a made-up one.
- A Mac listing an accelerator that reports no utilization ahead of one that does showed no GPU section at all: the parser stopped at the first set of statistics it found and gave up if that one lacked utilization. It now scans past such accelerators.
- The accelerator's name and core count are now read from the node that supplied the statistics only, so a neighbouring accelerator listed after it can no longer lend its name to another one's numbers.
- `ioreg` is invoked by absolute path, so a GUI-launched VS Code with an unusual `PATH` cannot silently lose the whole GPU section.
- The GPU hover gains a peak figure alongside the average, since an average hides whether the GPU was ever pegged. The peak is the burst's own and is not eased, so "is it busy right now" is answerable on the first update.
- A GPU reading that is switched off now costs nothing. `isShown()` sampled before asking whether the reading was wanted, so the statistics were gathered every update even when both GPU metrics were disabled.

The dependencies were overhauled at the same time, which changes what the disk figures mean.

- **Disk space is now reported the way `df` reports it, and the old numbers were wrong.** The percentage is used over used-plus-available, where it was used over size, and free space comes from the volume's own available figure rather than size minus used. On APFS those differ sharply, because every volume in a container reports the whole container as its size: this machine was shown as having 37 GB free where `df` said 9.9 GB, and 16% used where `df` said 96%. Expect the numbers to move, sometimes a long way; they were previously optimistic.
- `systeminformation` was upgraded from 4.x to 5.x. It is the only dependency that ships, and every release up to 5.31.6 carried command injection advisories -- eleven of them. Together with patches to the development dependencies, `npm audit` goes from eight vulnerabilities, one of them critical, to none.
- CPU temperature is correctly absent on a machine with no readable sensor, rather than reading "null C". systeminformation 5 reports no sensor as null where 4 reported -1, and the check knew only about -1.

## [2.0.0]

Three things change without being asked to, which is what the major version is for. No setting was removed or renamed, so existing configuration carries over untouched.

- The readings are now five status bar entries — CPU, GPU, Battery, Memory and Disk — rather than one. Anyone who had hidden or repositioned the single entry will need to do it again, and in a narrow window VS Code may drop the lower-priority entries (Memory, then Disk) where before it had one entry to fit. In exchange, each hover answers for its own group, each can be hidden on its own from the status bar's right-click menu, where they now appear by name, and a group whose metrics are all switched off or unavailable disappears rather than sitting there empty.
- `systemvitals.updatefrequencyms` now defaults to 10 seconds rather than 2. VS Code redraws an open hover the instant its content changes, so details rebuilt every couple of seconds flicker and resize while being read. One interval governs the reading and its details together, so a panel never shows a different sample from the entry behind it. Lower the setting for livelier numbers.
- The minimum VS Code version is now 1.74, up from 1.53, which is what markdown status bar tooltips require. Installs on older VS Code stay on 1.0.1.
- CPU temperature now sits with the other CPU readings rather than at the end of the line, so the CPU group is contiguous.

Everything else:

- Hovering a reading now opens a details panel for it. Each expands into the figures the status bar has no room for: the user/system split and per-core load bars behind the CPU percentage, cached and swap memory behind the memory fraction, the GPU's name and core count, battery health and cycle count, and used, free and total for every volume regardless of which one `systemvitals.disk.format` picks. A panel covers exactly what is on show, so a metric switched off is absent from both.
- Clicking a reading opens a details view: the same figures as the hover, for every group at once, in something that stays put while it is read and updates in place, with the group you clicked outlined. It docks in the panel beside Terminal and Problems, directly above the readings, rather than taking an editor tab. It closes by its title bar ✕, by clicking the same reading again, or from the command palette; clicking a different reading moves the outline instead of closing. Also on the palette as "System Vitals: Show Details".
- The panel carries no System Vitals tab until one is asked for, and closing the view removes the tab rather than leaving an empty shell. The view reads the samples the status bar already takes rather than polling on its own, so it costs nothing while closed.
- Each group in the details view has a Settings button that opens the Settings editor filtered to that group, so the disk group lands on the disk settings rather than the full list.
- Added a note to the GPU panel explaining that its memory allocation is what the driver has claimed from shared system memory, not a fixed VRAM capacity.
- Each metric is now sampled once per update and feeds both the status bar and its hover, so the details cost no extra polling.

## [1.0.1]

- Disk space is now usable on macOS without configuration. It previously listed all eight APFS volumes that macOS reports for a single physical disk, and the most obvious of them was misleading: `/` is the sealed read-only system snapshot, which reports roughly 95% free however full the machine is. The data volume is now shown in its place, labelled `/`.
- Volumes are identified by mount point rather than device node, so entries read `/` or `/home` instead of `/dev/disk3s5`.
- `systemvitals.disk.drives` now accepts mount points as well as device names, and still overrides the filtering entirely when set.

## [1.0.0]

First release of System Vitals, forked from [resmon](https://github.com/Njanderson/resmon) 1.0.7.

- Settings moved from the `resmon.*` namespace to `systemvitals.*`. If you are coming from resmon, your existing settings will not carry over and need to be set again. This keeps the two extensions independent when both are installed, rather than sharing one set of keys.
- Added GPU utilization and GPU memory monitoring on macOS, including Apple Silicon (M-series). Statistics are read from the IOKit registry via `ioreg`, which needs no elevated privileges. Both metrics hide themselves automatically on machines that do not report GPU statistics.
- Fixed `systeminformation` being pruned from the packaged extension, which produced a build that failed at activation once installed.
- Changed activation from `*` to `onStartupFinished`, so the extension no longer delays editor startup. This raises the minimum VS Code version to 1.53.
- Modernized the build: TypeScript 5, `@types/vscode` in place of the deprecated `vscode` module, and no `postinstall` hook.

## Inherited history

Releases below are from the upstream resmon project, retained for context.

### [1.0.7]
- Changed underlying CPU frequency API, added hiding battery/CPU temp information if the device lacks a battery/doesn't support CPU temp sensing, added some clarifications about CPU frequency behavior on Windows.

### [1.0.6]
- Added DiskSpace, CPU Temperature. Adjusted battery icon.

### [1.0.5]
- Refactored code heavily, addressed Github issue with memory.used versus memory.active.

### [1.0.4]
- Added icon for store.

### [1.0.3]
- Changed icons. Added choosable units.

### [1.0.2]
- Actually properly added systeminformation as a real dependency.

### [1.0.1]
- Properly added systeminformation as a real dependency

### [1.0.0]
- Initial release
