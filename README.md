# 🚀 DDev & Disk Orbit — Developer Environment Cockpit & Space Optimizer

An interactive, fast disk auditor, Colima VM resource controller, and DDEV environment launcher built specifically for macOS developers using **DDEV**, **Colima**, and local database & theme compilation workflows.

---

## ⚡ Quick Start

From your terminal:

```bash
cd ~/j/ddev-orbit
./orbit
```

This will automatically launch the local dashboard and open `http://localhost:7890` in your default browser.

### Key Features

1. **⚡ One-Click "Start Everything"**:
   - Detects Colima state: automatically starts the Colima VM runtime if stopped.
   - Starts DDEV containers with attached search profiles (Solr, Elasticsearch, Opensearch).
   - Detects frontend build status: compiles theme `dist` assets (`make yarnprod`, `make buildall`, `npm run build`) if missing or outdated.

2. **⚙️ Colima VM Resource Controls & Usage vs Settings**:
   - Live visibility into **current usage vs configured settings**:
     - **Memory (RAM)**: Current RAM used vs setting limit (e.g. `1.8 GiB / 8 GiB`) and Mac host total (`24 GB`).
     - **CPU**: Real-time load vs allocated cores (e.g. `12% / 4 Cores`) and Mac host cores (`14 Cores`).
     - **Datadisk**: Allocated datadisk blocks vs setting limit (e.g. `74.8 GB / 100 GiB (74.8%)`).
   - Interactive resource presets: *Eco (2C / 4GB)*, *Standard (4C / 8GB)*, and *Power (6C / 12GB)*.
   - **1-Click Restart Colima**: Quick restart button located directly in the header bar, the disk optimizer banner, and the resource settings modal.
   - Adjust resources directly in the UI and apply with automatic restart without losing project database volumes.

3. **🌿 Git Branch & Working Tree Status (Changed & Untracked Files)**:
   - Detects the currently checked out Git branch for every project directly from `HEAD` (supports worktrees, submodules, and standard repos).
   - Real-time Git status detection: displays `Clean` or `±X changed • ?Y untracked` warning badges.
   - Hover tooltips provide a direct preview of modified and untracked file paths without opening a terminal.
   - Quick **"Uncommitted / Untracked"** filter pill and sort option to immediately isolate projects with pending work.
   - **DDEV View as Default Tab**: Opens straight into the DDEV environment view on launch.

4. **🎨 Automated Dist & Theme Detection**:
   - Inspects `themes/*/package.json`, `dist/`, and `Makefile` build targets.
   - Real-time `Dist Ready` / `Dist Missing` badges across active and stopped projects.
   - Dedicated "Build Dist" trigger on each project card.

5. **🧹 Disk Bloat Optimizer & Live Gain Notifications**:
   - Reclaim space from Colima datadisk (`fstrim`), Docker builder prune, stopped containers, Xcode `DerivedData`, dev artifacts, and database dumps (`.sspak`, `.sql`, `.zst`).
   - **Disk Space Gain Notifications**: Celebratory notifications and live animated badges (`+X GB Saved!`) highlight the exact amount of disk space reclaimed whenever optimization actions run or free disk space expands.

---

### CLI Commands

```bash
# Instant terminal audit report
./orbit scan

# List all database dumps and snapshots with sizes & ages
./orbit dumps

# Inspect DDEV containers, Docker volumes, and Colima VM storage
./orbit ddev

# Launch the interactive web UI
./orbit ui
```

---

## 🔍 Key Findings & Opportunities on Your System

| Category | Size | Key Action |
| :--- | :--- | :--- |
| **Colima VM `datadisk`** | **~90.9 GB** | 143 Docker volumes from 32 DDEV projects. Run `docker system prune` and trim Colima disk. |
| **`~/Downloads/DB`** | **~28.5 GB** | 37 large `.sspak`, `.sql`, `.sspak.zip` files (e.g. `mottrans-prod-assets` 13GB, `nzsar` 3.4GB). |
| **Dev Artifacts & Xcode** | **~15+ GB** | `node_modules`, `vendor`, and Xcode `DerivedData`. |
| **Total Reclaimable Potential** | **~100+ GB** | Over **5×** your current free disk space! |

---

## 🛡️ Safety Built-in

- **Zero Immediate File Destruction:** "Move to Trash" in the UI moves items to macOS `~/.Trash` instead of using destructive commands, allowing complete reversibility.
- **Project Code Integrity:** Pruning DDEV volumes or deleting stopped DDEV containers preserves your application git repositories and source code in `~/Sites`.

