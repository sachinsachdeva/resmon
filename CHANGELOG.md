# Change Log

## [Unreleased]

Both GPU readings were wrong on Apple Silicon. Neither was wrong in a way that looked broken, which is why they lasted: one was a plausible number that meant something else, and the other pinned high.

- **GPU utilization was effectively a yes/no answer.** macOS reports `Device Utilization %` as a span between reads, not as a level: it covers the time since the statistic was last read, and its denominator discounts time the GPU had nothing queued. Read once per update, as it was, a load busy exactly half the time reported 88% on a 3-second interval and would approach 100% on the 10-second default. Utilization is now sampled in the background at a fixed brisk cadence and averaged over the interval, which is the only way the figure means what the CPU percentage beside it means. The same load now reports 78% at the default cadence and 60% at 100 ms, against a true 47%; a steady load and an idle GPU were and remain exact. New `systemvitals.gpu.sampleintervalms` (50-2000 ms, default 250) trades CPU for accuracy — each read costs about 9 ms of CPU, so the default spends roughly 3.5% of one core while the reading is on screen. Polling relaxes while the GPU is idle and stops when the reading is hidden.
- **GPU memory led with a figure that does not track GPU memory.** The status bar showed `In use system memory / Alloc system memory`, which reads as used-out-of-total but is neither. Holding 6 GB on the GPU moved the first figure by −0.07 GB while the second tracked it exactly. The reading now shows the allocation — the figure that responds to real allocations — against total system memory, which on unified memory is the pool it is genuinely drawn from. `In use system memory` is kept in the hover as "Mapped now", named for what it is. A discrete GPU, whose VRAM the registry does not report, shows the allocation with no total rather than a made-up one.
- A Mac listing an accelerator that reports no utilization ahead of one that does showed no GPU section at all: the parser stopped at the first set of statistics it found and gave up if that one lacked utilization. It now scans past such accelerators.
- The accelerator's name and core count are now read from the node that supplied the statistics only, so a neighbouring accelerator listed after it can no longer lend its name to another one's numbers.
- `ioreg` is invoked by absolute path, so a GUI-launched VS Code with an unusual `PATH` cannot silently lose the whole GPU section.
- The GPU hover gains a peak figure alongside the average, since an average over the interval hides whether the GPU was ever pegged.

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
