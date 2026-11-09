let state = {
  data: null,
  activeTab: 'ddev',
  selectedDumps: new Set(),
  lastClickedDumpIndex: null,
  dumpsSortBy: 'size',
  dumpsSortOrder: 'desc',
  currentAction: null,
  ddevFilterSearchOnly: false,
  ddevFilterDirtyOnly: false
};

let toastTimeout = null;
let toastRemainingMs = 8000;
let toastStartTime = 0;

document.addEventListener('DOMContentLoaded', () => {
  loadData();
  setupGlobalShortcuts();
});

function setupGlobalShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Escape to close modal or clear selection
    if (e.key === 'Escape') {
      const modal = document.getElementById('actionModal');
      if (modal && !modal.classList.contains('hidden')) {
        closeExecModal();
        return;
      }
      if (state.selectedDumps.size > 0) {
        clearDumpsSelection();
      }
    }
    // Ctrl/Cmd + A to select all dumps when on dumps tab and not focused in an input
    if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
        return;
      }
      if (state.activeTab === 'dumps') {
        e.preventDefault();
        selectAllDumps(true);
      }
    }
  });
}

// -------------------------------------------------------------
// TOAST NOTIFICATIONS (8s duration, interactive, hover-pause)
// -------------------------------------------------------------

function showToast(message, subtext = null, actionBtnText = null, actionBtnCallback = null) {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMsg');
  const toastSubMsg = document.getElementById('toastSubMsg');
  const toastActionBtn = document.getElementById('toastActionBtn');
  const bar = document.getElementById('toastProgressBar');

  toastMsg.textContent = message;

  if (subtext) {
    toastSubMsg.textContent = subtext;
    toastSubMsg.classList.remove('hidden');
  } else {
    toastSubMsg.classList.add('hidden');
    toastSubMsg.textContent = '';
  }

  if (actionBtnText && actionBtnCallback) {
    toastActionBtn.textContent = actionBtnText;
    toastActionBtn.onclick = (e) => {
      e.stopPropagation();
      actionBtnCallback();
    };
    toastActionBtn.classList.remove('hidden');
  } else {
    toastActionBtn.classList.add('hidden');
    toastActionBtn.onclick = null;
  }

  toast.classList.remove('translate-y-24', 'opacity-0', 'pointer-events-none');

  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }

  // Reset progress bar animation
  bar.classList.remove('toast-bar', 'paused');
  void bar.offsetWidth; // force DOM reflow
  bar.classList.add('toast-bar');

  toastRemainingMs = 8000;
  toastStartTime = Date.now();

  toastTimeout = setTimeout(() => {
    hideToast();
  }, toastRemainingMs);
}

function hideToast() {
  const toast = document.getElementById('toast');
  toast.classList.add('translate-y-24', 'opacity-0', 'pointer-events-none');
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }
}

function pauseToastTimer() {
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    const elapsed = Date.now() - toastStartTime;
    toastRemainingMs = Math.max(1000, toastRemainingMs - elapsed);
    const bar = document.getElementById('toastProgressBar');
    if (bar) bar.classList.add('paused');
  }
}

function resumeToastTimer() {
  const bar = document.getElementById('toastProgressBar');
  if (bar) bar.classList.remove('paused');
  toastStartTime = Date.now();
  toastTimeout = setTimeout(() => {
    hideToast();
  }, toastRemainingMs);
}

// -------------------------------------------------------------
// DISK GAIN CELEBRATION & NOTIFICATIONS
// -------------------------------------------------------------

let gainBadgeTimeout = null;
let colimaGainBadgeTimeout = null;

function notifyDiskSpaceGain(gainStr, detail = '', options = {}) {
  if (!gainStr || gainStr === '0 B' || gainStr === '0B') return;

  state.lastGainNotifyTime = Date.now();

  const isTrash = options.isTrash || (detail && detail.toLowerCase().includes('trash'));
  const isColima = options.isColima || (detail && detail.toLowerCase().includes('colima'));

  const actionText = isTrash ? 'Open Trash' : 'View DDEV & Storage';
  const actionCb = isTrash ? () => revealFile('~/.Trash') : () => switchTab('ddev');

  const title = `🎉 Saved ${gainStr} Disk Space!`;
  const subtext = detail || (isColima ? 'Colima datadisk trimmed • Freed to APFS' : 'Disk space reclaimed on your Mac');

  // Customize toast appearance for celebrations
  const toast = document.getElementById('toast');
  const toastIconBox = document.getElementById('toastIconBox');
  if (toast) {
    toast.style.borderColor = 'var(--ok)';
    toast.style.boxShadow = '0 20px 35px -10px rgba(16, 185, 129, 0.4)';
  }
  if (toastIconBox) {
    toastIconBox.style.background = 'var(--ok-bg)';
    toastIconBox.style.color = 'var(--ok)';
    toastIconBox.innerHTML = `
      <svg class="w-5 h-5 animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    `;
  }

  showToast(title, subtext, actionText, actionCb);

  // Reset toast styling after duration
  setTimeout(() => {
    if (toast) {
      toast.style.borderColor = '';
      toast.style.boxShadow = '';
    }
    if (toastIconBox) {
      toastIconBox.innerHTML = `
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
      `;
    }
  }, 8500);

  // Update Overview card #diskGainBadge
  const badge = document.getElementById('diskGainBadge');
  const badgeText = document.getElementById('diskGainBadgeText');
  if (badge && badgeText) {
    badgeText.textContent = `+${gainStr} Saved!`;
    badge.classList.remove('hidden');
    if (gainBadgeTimeout) clearTimeout(gainBadgeTimeout);
    gainBadgeTimeout = setTimeout(() => {
      badge.classList.add('hidden');
    }, 14000);
  }

  // If Colima datadisk trimmed, update #colimaGainBadge in Tab 2
  if (isColima) {
    const cBadge = document.getElementById('colimaGainBadge');
    const cBadgeText = document.getElementById('colimaGainBadgeText');
    if (cBadge && cBadgeText) {
      cBadgeText.textContent = `-${gainStr} Trimmed!`;
      cBadge.classList.remove('hidden');
      if (colimaGainBadgeTimeout) clearTimeout(colimaGainBadgeTimeout);
      colimaGainBadgeTimeout = setTimeout(() => {
        cBadge.classList.add('hidden');
      }, 14000);
    }
  }
}

function copyToClipboard(text, message = 'Copied to clipboard!') {
  navigator.clipboard.writeText(text).then(() => {
    showToast(message, text);
  }).catch(() => {
    prompt('Copy command:', text);
  });
}

// -------------------------------------------------------------
// TAB NAVIGATION (4 Focused Tabs)
// -------------------------------------------------------------

function switchTab(tabId) {
  state.activeTab = tabId;
  
  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.className = 'tab-btn flex items-center gap-2.5 px-5 py-2.5 rounded-[var(--r)] font-mono font-medium text-xs transition-all text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] whitespace-nowrap';
    btn.style.background = '';
    const badge = btn.querySelector('span[id^="tabCount-"]');
    if (badge) {
      badge.className = 'text-xs px-2 py-0.5 rounded-[calc(var(--r)-2px)] font-mono font-bold bg-[var(--surface)] text-[var(--muted)] border border-[var(--line)]';
      badge.style.background = '';
      badge.style.color = '';
    }
  });

  const activeBtn = document.getElementById(`tabBtn-${tabId}`);
  if (activeBtn) {
    activeBtn.className = 'tab-btn flex items-center gap-2.5 px-5 py-2.5 rounded-[var(--r)] font-mono font-bold text-xs transition-all text-white shadow-md whitespace-nowrap';
    activeBtn.style.background = 'var(--g-accent)';
    const badge = activeBtn.querySelector('span[id^="tabCount-"]');
    if (badge) {
      badge.className = 'text-xs px-2 py-0.5 rounded-[calc(var(--r)-2px)] font-mono font-bold bg-[var(--surface)] text-[var(--accent)] border border-[var(--edge)]';
    }
  }

  // Update tab panels
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.add('hidden');
  });
  const activePanel = document.getElementById(`tabContent-${tabId}`);
  if (activePanel) {
    activePanel.classList.remove('hidden');
  }
}

// -------------------------------------------------------------
// DATA LOADING & AUDIT
// -------------------------------------------------------------

async function loadData() {
  try {
    const res = await fetch('/api/data');
    if (res.status === 202) {
      setTimeout(loadData, 1200);
      return;
    }
    const data = await res.json();

    // Check for disk gains compared to previous scan
    if (state.lastDiskFree !== undefined && data.overview) {
      const diskGain = data.overview.disk_free - state.lastDiskFree;
      const colimaGain = (state.lastColimaAllocated !== undefined && data.overview.colima_allocated) 
        ? state.lastColimaAllocated - data.overview.colima_allocated 
        : 0;

      const now = Date.now();
      const recentNotify = state.lastGainNotifyTime && (now - state.lastGainNotifyTime < 5000);

      if (!recentNotify) {
        if (diskGain > 25 * 1024 * 1024) {
          notifyDiskSpaceGain(
            formatBytes(diskGain), 
            `Host Free Space: ${formatBytes(state.lastDiskFree)} → ${data.overview.disk_free_str}`
          );
        } else if (colimaGain > 25 * 1024 * 1024) {
          notifyDiskSpaceGain(
            formatBytes(colimaGain), 
            `Colima Datadisk: ${formatBytes(state.lastColimaAllocated)} → ${data.overview.colima_allocated_str}`,
            { isColima: true }
          );
        }
      }
    }

    if (data.overview) {
      state.lastDiskFree = data.overview.disk_free;
      state.lastColimaAllocated = data.overview.colima_allocated;
    }

    state.data = data;
    renderAll();
    updateHeaderStatus();
  } catch (err) {
    console.error('Failed to load audit data:', err);
  }
}

function updateHeaderStatus() {
  const badge = document.getElementById('headerStatusBadge');
  if (badge) {
    badge.textContent = `Audited ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
}

async function triggerRefresh() {
  const spinner = document.getElementById('refreshSpinner');
  const btnText = document.getElementById('refreshBtnText');
  spinner.classList.add('animate-spin');
  btnText.textContent = 'Scanning...';

  try {
    await fetch('/api/refresh', { method: 'POST' });
    showToast('Scan started in background...');
    setTimeout(loadData, 2000);
  } catch (err) {
    console.error(err);
  } finally {
    setTimeout(() => {
      spinner.classList.remove('animate-spin');
      btnText.textContent = 'Refresh';
    }, 1500);
  }
}

function renderAll() {
  if (!state.data) return;
  const d = state.data;

  // Overview metrics
  document.getElementById('diskFreeStr').textContent = d.overview.disk_free_str;
  document.getElementById('diskUsedStr').textContent = d.overview.disk_used_str;
  document.getElementById('diskTotalStr').textContent = d.overview.disk_total_str;
  document.getElementById('diskPercentText').textContent = `${d.overview.disk_used_percent}% utilized`;
  
  const pBar = document.getElementById('diskProgressBar');
  pBar.style.width = `${Math.min(100, d.overview.disk_used_percent)}%`;

  const alertBadge = document.getElementById('diskAlertBadge');
  const freeGB = d.overview.disk_free / (1024 ** 3);
  if (freeGB < 20) {
    alertBadge.textContent = 'Critical';
    alertBadge.style.background = 'var(--bad-bg)';
    alertBadge.style.color = 'var(--bad)';
    alertBadge.style.border = '1px solid var(--bad)';
  } else if (freeGB < 40) {
    alertBadge.textContent = 'Low Space';
    alertBadge.style.background = 'var(--warn-bg)';
    alertBadge.style.color = 'var(--warn)';
    alertBadge.style.border = '1px solid var(--warn)';
  } else {
    alertBadge.textContent = 'Healthy';
    alertBadge.style.background = 'var(--ok-bg)';
    alertBadge.style.color = 'var(--ok)';
    alertBadge.style.border = '1px solid var(--ok)';
  }

  document.getElementById('metricColimaDisk').textContent = d.overview.colima_allocated_str;
  document.getElementById('metricDbDumps').textContent = d.db_dumps.total_dumps_size_str;
  document.getElementById('metricDockerVolumes').textContent = `${d.docker.total_volumes} vols`;
  document.getElementById('potentialSavingsStr').textContent = `~${d.potential_savings_str}`;
  
  const colimaTitle = document.getElementById('colimaAllocatedTitle');
  if (colimaTitle) {
    colimaTitle.textContent = d.overview.colima_allocated_str;
  }

  // Colima Resource Bar
  const colima = d.overview.colima || {};
  const isColimaRunning = colima.is_running || false;
  const colimaDot = document.getElementById('colimaStatusDot');
  if (colimaDot) {
    colimaDot.className = `w-2.5 h-2.5 rounded-full shrink-0 ${isColimaRunning ? 'bg-[var(--ok)] animate-pulse' : 'bg-[var(--faint)]'}`;
  }
  const colimaTxt = document.getElementById('colimaStatusText');
  if (colimaTxt) {
    colimaTxt.textContent = `Colima (${isColimaRunning ? 'Running' : 'Stopped'})`;
    colimaTxt.className = `text-xs font-mono font-bold ${isColimaRunning ? 'text-[var(--ok)]' : 'text-[var(--muted)]'}`;
  }
  const cCpu = document.getElementById('colimaCpuPill');
  if (cCpu) {
    cCpu.textContent = `CPU: ${colima.cpu_used_percent || 0}% / ${colima.cpu_str || '4 Cores'}`;
  }
  const cMem = document.getElementById('colimaMemPill');
  if (cMem) {
    cMem.textContent = `RAM: ${colima.memory_used_str || '0 B'} / ${colima.memory_str || '8 GiB'} (${colima.memory_used_percent || 0}%)`;
  }
  const cDisk = document.getElementById('colimaDiskPill');
  if (cDisk) {
    cDisk.textContent = `Disk: ${colima.disk_used_str || '0 B'} / ${colima.disk_str || '100 GiB'} (${colima.disk_used_percent || 0}%)`;
  }

  // Update Tab 2 Colima Deep Dive Banner Cards
  const bMemUsed = document.getElementById('bannerMemUsed');
  if (bMemUsed) bMemUsed.textContent = colima.memory_used_str || '0 B';
  const bMemSetting = document.getElementById('bannerMemSetting');
  if (bMemSetting) bMemSetting.textContent = `${colima.memory_str || '8 GiB'} Setting`;
  const bMemPct = document.getElementById('bannerMemPercent');
  if (bMemPct) bMemPct.textContent = `${colima.memory_used_percent || 0}%`;
  const bMemBar = document.getElementById('bannerMemBar');
  if (bMemBar) bMemBar.style.width = `${Math.min(100, colima.memory_used_percent || 0)}%`;
  const bHostRam = document.getElementById('bannerHostRam');
  if (bHostRam) bHostRam.textContent = colima.host_total_ram_str || '--';

  const bCpuLoad = document.getElementById('bannerCpuLoad');
  if (bCpuLoad) bCpuLoad.textContent = colima.load_avg != null ? colima.load_avg.toFixed(2) : '0.00';
  const bCpuSetting = document.getElementById('bannerCpuSetting');
  if (bCpuSetting) bCpuSetting.textContent = `${colima.cpu_str || '4 Cores'} Setting`;
  const bCpuPct = document.getElementById('bannerCpuPercent');
  if (bCpuPct) bCpuPct.textContent = `${colima.cpu_used_percent || 0}%`;
  const bCpuBar = document.getElementById('bannerCpuBar');
  if (bCpuBar) bCpuBar.style.width = `${Math.min(100, colima.cpu_used_percent || 0)}%`;
  const bHostCpu = document.getElementById('bannerHostCpu');
  if (bHostCpu) bHostCpu.textContent = colima.host_total_cpus || '--';

  const bDiskUsed = document.getElementById('bannerDiskUsed');
  if (bDiskUsed) bDiskUsed.textContent = colima.disk_used_str || '--';
  const bDiskSetting = document.getElementById('bannerDiskSetting');
  if (bDiskSetting) bDiskSetting.textContent = `${colima.disk_str || '100 GiB'} Setting`;
  const bDiskPct = document.getElementById('bannerDiskPercent');
  if (bDiskPct) bDiskPct.textContent = `${colima.disk_used_percent || 0}%`;
  const bDiskBar = document.getElementById('bannerDiskBar');
  if (bDiskBar) bDiskBar.style.width = `${Math.min(100, colima.disk_used_percent || 0)}%`;

  // Tab counts
  document.getElementById('tabCount-dumps').textContent = `${d.db_dumps.total_dumps} • ${d.db_dumps.total_dumps_size_str}`;
  document.getElementById('tabCount-ddev').textContent = `${d.docker.total_volumes} vols • ${d.overview.colima_allocated_str}`;
  document.getElementById('tabCount-artifacts').textContent = d.artifacts.total_artifacts_size_str;

  // Render sections
  renderDumpsTable();
  renderDdevSection();
  renderArtifactsSection();
}

// -------------------------------------------------------------
// TAB 1: DATABASE DUMPS (Multi-select, Shift-range, Sorting, Trash)
// -------------------------------------------------------------

function getFilteredDumps() {
  if (!state.data) return [];
  const filterLoc = document.getElementById('dumpsFilterSelect').value;
  const filterAge = document.getElementById('dumpsAgeFilterSelect').value;
  const search = document.getElementById('dumpsSearchInput').value.toLowerCase().trim();

  let dumps = state.data.db_dumps.dumps.filter(d => {
    // Location filter
    if (filterLoc === 'Downloads/DB' && !d.location.includes('Downloads/DB')) return false;
    if (filterLoc === 'Project Snapshot' && !d.location.includes('Project Snapshot') && !d.location.includes('Project Dumps')) return false;
    if (filterLoc === 'Downloads' && d.location !== 'Downloads') return false;

    // Age filter
    if (filterAge === 'older14' && d.age_days < 14) return false;
    if (filterAge === 'older30' && d.age_days < 30) return false;
    if (filterAge === 'older60' && d.age_days < 60) return false;

    // Search query
    if (search) {
      const matchName = d.name.toLowerCase().includes(search);
      const matchProj = d.project && d.project.toLowerCase().includes(search);
      const matchLoc = d.location.toLowerCase().includes(search);
      if (!matchName && !matchProj && !matchLoc) return false;
    }
    return true;
  });

  // Sorting
  dumps.sort((a, b) => {
    let comparison = 0;
    if (state.dumpsSortBy === 'size') {
      comparison = a.size - b.size;
    } else if (state.dumpsSortBy === 'age') {
      comparison = a.age_days - b.age_days;
    } else if (state.dumpsSortBy === 'name') {
      comparison = a.name.localeCompare(b.name);
    } else if (state.dumpsSortBy === 'location') {
      comparison = a.location.localeCompare(b.location);
    }
    return state.dumpsSortOrder === 'desc' ? -comparison : comparison;
  });

  return dumps;
}

function onSearchOrFilterChange() {
  renderDumpsTable();
}

function toggleDumpsSort(column) {
  if (state.dumpsSortBy === column) {
    state.dumpsSortOrder = state.dumpsSortOrder === 'asc' ? 'desc' : 'asc';
  } else {
    state.dumpsSortBy = column;
    state.dumpsSortOrder = (column === 'size' || column === 'age') ? 'desc' : 'asc';
  }
  updateSortIndicators();
  renderDumpsTable();
}

function updateSortIndicators() {
  ['name', 'location', 'size', 'age'].forEach(col => {
    const el = document.getElementById(`sortIndicator-${col}`);
    if (!el) return;
    if (state.dumpsSortBy === col) {
      el.textContent = state.dumpsSortOrder === 'asc' ? '▲' : '▼';
    } else {
      el.textContent = '';
    }
  });
}

function renderDumpsTable() {
  if (!state.data) return;
  const dumps = getFilteredDumps();

  document.getElementById('dumpsCountText').textContent = dumps.length;
  const totalFilteredBytes = dumps.reduce((acc, cur) => acc + cur.size, 0);
  document.getElementById('dumpsSizeText').textContent = formatBytes(totalFilteredBytes);

  const tbody = document.getElementById('dumpsTableBody');
  if (dumps.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-12 text-center text-[var(--muted)] font-mono">No database dumps matching the current search & filters.</td></tr>`;
    updateSelectionToolbar(dumps);
    return;
  }

  tbody.innerHTML = dumps.map((d, index) => {
    const isSelected = state.selectedDumps.has(d.path);
    
    // Desk style age badge
    const ageBadgeStyle = d.age_days > 45 
      ? 'background: var(--bad-bg); color: var(--bad); border: 1px solid var(--bad);' 
      : d.age_days > 14 
      ? 'background: var(--warn-bg); color: var(--warn); border: 1px solid var(--warn);' 
      : 'background: var(--ok-bg); color: var(--ok); border: 1px solid var(--ok);';
    
    const projBadge = d.project 
      ? `<span class="px-2.5 py-0.5 rounded-[var(--r)] text-xs font-mono font-bold desk-card-2 text-[var(--accent)]">${d.project}</span>`
      : `<span class="text-[var(--faint)] text-xs font-mono italic">none</span>`;

    const rowClass = isSelected 
      ? 'row-selected transition cursor-pointer select-none' 
      : 'hover:bg-[var(--surface-2)] transition cursor-pointer select-none';

    return `
      <tr class="${rowClass}" data-index="${index}" onclick="handleDumpRowClick(event, ${index})">
        <td class="py-3.5 px-4 text-center" onclick="event.stopPropagation()">
          <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleDumpSelection(${index}, this.checked)" class="w-4 h-4 rounded-[calc(var(--r)-3px)] bg-[var(--surface-2)] border-[var(--edge)] cursor-pointer">
        </td>
        <td class="py-3.5 px-4 font-mono text-[var(--text)]">
          <div class="truncate max-w-sm sm:max-w-xl font-bold text-[var(--text)]" title="${d.name}">
            ${d.name}
          </div>
          <div class="text-[11px] text-[var(--muted)] font-mono truncate max-w-sm sm:max-w-xl mt-0.5" title="${d.path}">
            ${d.path}
          </div>
        </td>
        <td class="py-3.5 px-3">${projBadge}</td>
        <td class="py-3.5 px-3 font-mono text-[var(--muted)]">
          <span class="px-2 py-0.5 rounded-[var(--r)] text-xs bg-[var(--bg-2)] border border-[var(--line)]">${d.location}</span>
        </td>
        <td class="py-3.5 px-3 font-mono font-bold text-[var(--warn)] text-xs whitespace-nowrap">${d.size_str}</td>
        <td class="py-3.5 px-3 whitespace-nowrap">
          <span class="px-2.5 py-0.5 rounded-[var(--r)] text-xs font-mono font-bold" style="${ageBadgeStyle}">
            ${d.age_days === 0 ? 'Today' : `${d.age_days}d ago`}
          </span>
        </td>
        <td class="py-3.5 px-4 text-right" onclick="event.stopPropagation()">
          <div class="flex items-center justify-end gap-2">
            <button onclick="revealFile('${escapeQuotes(d.path)}')" class="px-3 py-1.5 text-xs font-mono font-bold rounded-[var(--r)] desk-card-2 hover:bg-[var(--surface-3)] text-[var(--text)] transition" title="Show and highlight in Finder">
              Reveal
            </button>
            <button onclick="trashFile('${escapeQuotes(d.path)}', '${escapeQuotes(d.name)}')" class="px-3 py-1.5 text-xs font-mono font-bold rounded-[var(--r)] transition" style="background: var(--bad-bg); color: var(--bad); border: 1px solid var(--bad);" title="Move safely to macOS ~/.Trash">
              Trash
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  updateSelectionToolbar(dumps);
}

function handleDumpRowClick(e, index) {
  const dumps = getFilteredDumps();
  if (index < 0 || index >= dumps.length) return;

  const targetPath = dumps[index].path;

  if (e.shiftKey && state.lastClickedDumpIndex !== null) {
    const start = Math.min(state.lastClickedDumpIndex, index);
    const end = Math.max(state.lastClickedDumpIndex, index);
    for (let i = start; i <= end; i++) {
      state.selectedDumps.add(dumps[i].path);
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (state.selectedDumps.has(targetPath)) {
      state.selectedDumps.delete(targetPath);
    } else {
      state.selectedDumps.add(targetPath);
    }
    state.lastClickedDumpIndex = index;
  } else {
    if (state.selectedDumps.has(targetPath)) {
      state.selectedDumps.delete(targetPath);
    } else {
      state.selectedDumps.add(targetPath);
    }
    state.lastClickedDumpIndex = index;
  }

  renderDumpsTable();
}

function toggleDumpSelection(index, isChecked) {
  const dumps = getFilteredDumps();
  if (index < 0 || index >= dumps.length) return;

  const path = dumps[index].path;
  if (isChecked) {
    state.selectedDumps.add(path);
  } else {
    state.selectedDumps.delete(path);
  }
  state.lastClickedDumpIndex = index;
  renderDumpsTable();
}

function toggleSelectAllDumps(isChecked) {
  const dumps = getFilteredDumps();
  if (isChecked) {
    dumps.forEach(d => state.selectedDumps.add(d.path));
  } else {
    state.selectedDumps.clear();
  }
  renderDumpsTable();
}

function selectAllDumps(shouldSelect) {
  const dumps = getFilteredDumps();
  if (shouldSelect) {
    dumps.forEach(d => state.selectedDumps.add(d.path));
  } else {
    state.selectedDumps.clear();
  }
  renderDumpsTable();
}

function clearDumpsSelection() {
  state.selectedDumps.clear();
  state.lastClickedDumpIndex = null;
  renderDumpsTable();
}

function updateSelectionToolbar(filteredDumps) {
  const bar = document.getElementById('dumpsSelectionBar');
  const countNumber = document.getElementById('selectedCountNumber');
  const countText = document.getElementById('selectedCountText');
  const sizeText = document.getElementById('selectedSizeText');
  const selectAllBox = document.getElementById('dumpsSelectAllCheckbox');

  const selectedCount = state.selectedDumps.size;
  if (selectedCount > 0) {
    bar.classList.remove('hidden');
    countNumber.textContent = selectedCount;
    countText.textContent = `${selectedCount} item${selectedCount > 1 ? 's' : ''} selected`;

    let totalBytes = 0;
    if (state.data && state.data.db_dumps) {
      state.data.db_dumps.dumps.forEach(d => {
        if (state.selectedDumps.has(d.path)) {
          totalBytes += d.size;
        }
      });
    }
    sizeText.textContent = formatBytes(totalBytes);
  } else {
    bar.classList.add('hidden');
  }

  if (selectAllBox && filteredDumps.length > 0) {
    const allSelected = filteredDumps.every(d => state.selectedDumps.has(d.path));
    const someSelected = filteredDumps.some(d => state.selectedDumps.has(d.path));
    selectAllBox.checked = allSelected;
    selectAllBox.indeterminate = !allSelected && someSelected;
  }
}

async function trashSelectedDumps() {
  const paths = Array.from(state.selectedDumps);
  if (paths.length === 0) return;

  let totalBytes = 0;
  if (state.data && state.data.db_dumps) {
    state.data.db_dumps.dumps.forEach(d => {
      if (state.selectedDumps.has(d.path)) totalBytes += d.size;
    });
  }

  const confirmed = confirm(
    `Move ${paths.length} database dumps (${formatBytes(totalBytes)}) to your macOS Trash?\n\n` +
    `Items will be moved to ~/.Trash and can easily be recovered if needed.`
  );
  if (!confirmed) return;

  try {
    const res = await fetch('/api/action/trash_batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths })
    });
    const result = await res.json();
    if (result.success) {
      notifyDiskSpaceGain(result.freed_str, `Moved ${result.count} dumps safely to ~/.Trash`, { isTrash: true });
      const trashedSet = new Set(result.trashed);
      if (state.data) {
        state.data.db_dumps.dumps = state.data.db_dumps.dumps.filter(d => !trashedSet.has(d.path));
        state.data.db_dumps.total_dumps = state.data.db_dumps.dumps.length;
        const newTotal = state.data.db_dumps.dumps.reduce((a, c) => a + c.size, 0);
        state.data.db_dumps.total_dumps_size = newTotal;
        state.data.db_dumps.total_dumps_size_str = formatBytes(newTotal);
      }
      clearDumpsSelection();
      renderAll();
    } else {
      alert(`Error trashing files: ${result.error || 'Operation failed'}`);
    }
  } catch (err) {
    console.error(err);
    alert('Failed to connect to server.');
  }
}

function revealSelectedDump() {
  const paths = Array.from(state.selectedDumps);
  if (paths.length === 0) return;
  revealFile(paths[0]);
  if (paths.length > 1) {
    showToast('Revealed in Finder', `1st of ${paths.length} selected files`);
  }
}

function copySelectedDumpPaths() {
  const paths = Array.from(state.selectedDumps);
  if (paths.length === 0) return;
  copyToClipboard(paths.join('\n'), `Copied ${paths.length} file paths to clipboard!`);
}

// -------------------------------------------------------------
// TAB 2: DDEV & COLIMA (Active Running First, Other Filter/Sort, Search Setup)
// -------------------------------------------------------------

function toggleDdevSearchFilter() {
  state.ddevFilterSearchOnly = !state.ddevFilterSearchOnly;
  const btn = document.getElementById('ddevFilterSearchOnly');
  if (btn) {
    if (state.ddevFilterSearchOnly) {
      btn.className = 'px-2.5 py-1.5 rounded-[var(--r)] text-xs font-mono font-bold border transition text-[var(--accent)] border-[var(--accent)] bg-[var(--surface-3)]';
    } else {
      btn.className = 'px-2.5 py-1.5 rounded-[var(--r)] text-xs font-mono font-bold border transition desk-card hover:bg-[var(--surface-3)] text-[var(--muted)] border-[var(--edge)]';
    }
  }
  renderDdevSection();
}

function toggleDdevDirtyFilter() {
  state.ddevFilterDirtyOnly = !state.ddevFilterDirtyOnly;
  const btn = document.getElementById('ddevFilterDirtyOnly');
  if (btn) {
    if (state.ddevFilterDirtyOnly) {
      btn.className = 'px-2.5 py-1.5 rounded-[var(--r)] text-xs font-mono font-bold border transition text-[var(--warn)] border-[var(--warn)] bg-[var(--surface-3)] flex items-center gap-1.5';
    } else {
      btn.className = 'px-2.5 py-1.5 rounded-[var(--r)] text-xs font-mono font-bold border transition desk-card hover:bg-[var(--surface-3)] text-[var(--muted)] border-[var(--edge)] flex items-center gap-1.5';
    }
  }
  renderDdevSection();
}

function renderGitPills(p) {
  if (!p.branch && !p.git) return '';
  const git = p.git || {};
  const branchName = p.branch || git.branch || 'git';

  let branchBadge = `
    <span class="px-2 py-0.5 rounded-[var(--r)] text-[10px] font-mono font-bold text-[var(--accent)] desk-card-2 flex items-center gap-1 shrink-0" title="Git Branch: ${branchName}">
      <svg class="w-3 h-3 text-[var(--accent)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h10M7 7a3 3 0 100-6 3 3 0 000 6zm0 0v10m10-10a3 3 0 100-6 3 3 0 000 6zm0 0v2a4 4 0 01-4 4H7" />
      </svg>
      <span class="truncate max-w-[130px] sm:max-w-[180px]">${branchName}</span>
    </span>
  `;

  if (!git.has_git) {
    return branchBadge;
  }

  let tooltip = '';
  if (git.has_changes && git.files && git.files.length > 0) {
    const list = git.files.map(f => `${f.status.padEnd(2)} ${f.file}`).join('\n');
    const extra = git.total_dirty > git.files.length ? `\n...and ${git.total_dirty - git.files.length} more` : '';
    tooltip = `Uncommitted Changes (${git.total_dirty} files):\n${list}${extra}`;
  } else if (git.clean) {
    tooltip = 'Working tree clean (no modified or untracked files)';
  }

  let statusBadge = '';
  if (git.clean) {
    statusBadge = `
      <span class="px-2 py-0.5 rounded-[var(--r)] text-[10px] font-mono font-bold text-[var(--ok)] desk-card-2 flex items-center gap-1 shrink-0 cursor-help" title="${escapeQuotes(tooltip)}">
        <svg class="w-3 h-3 text-[var(--ok)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
        </svg>
        <span>Clean</span>
      </span>
    `;
  } else {
    const parts = [];
    if (git.changed > 0) parts.push(`±${git.changed} changed`);
    if (git.untracked > 0) parts.push(`?${git.untracked} untracked`);
    const label = parts.join(' • ') || `${git.total_dirty} dirty`;

    statusBadge = `
      <span class="px-2 py-0.5 rounded-[calc(var(--r)-2px)] text-[10px] font-mono font-bold flex items-center gap-1.5 shrink-0 cursor-help shadow-sm" style="background: var(--warn-bg); color: var(--warn); border: 1px solid var(--warn);" title="${escapeQuotes(tooltip)}">
        <span class="w-1.5 h-1.5 rounded-full bg-[var(--warn)] animate-pulse shrink-0"></span>
        <span>${label}</span>
      </span>
    `;
  }

  return branchBadge + statusBadge;
}

function renderDdevSection() {
  if (!state.data) return;
  const d = state.data;
  
  const allProjects = Object.values(d.projects);
  const runningProjects = allProjects.filter(p => p.is_running);
  const stoppedProjectsAll = allProjects.filter(p => !p.is_running);

  const rCountEl = document.getElementById('ddevRunningCount');
  if (rCountEl) rCountEl.textContent = runningProjects.length;
  const sCountEl = document.getElementById('ddevStoppedCount');
  if (sCountEl) sCountEl.textContent = stoppedProjectsAll.length;

  // Uncommitted / Dirty Projects Summary
  const dirtyProjects = allProjects.filter(p => p.git && p.git.has_changes);
  const dirtyBadge = document.getElementById('ddevDirtySummaryBadge');
  const dirtyText = document.getElementById('ddevDirtySummaryText');
  if (dirtyBadge && dirtyText) {
    if (dirtyProjects.length > 0) {
      dirtyText.textContent = `${dirtyProjects.length} with changes / untracked`;
      dirtyBadge.classList.remove('hidden');
    } else {
      dirtyBadge.classList.add('hidden');
    }
  }

  // 1. RENDER RUNNING PROJECTS (Top Pinned Section)
  const rList = document.getElementById('ddevRunningProjectsList');
  if (rList) {
    if (runningProjects.length === 0) {
      rList.innerHTML = `<div class="text-xs text-[var(--muted)] font-mono py-8 col-span-2 text-center desk-card-2 p-4">No active DDEV projects running. Click "Start" on any project below to spin it up.</div>`;
    } else {
      rList.innerHTML = runningProjects.map(p => {
        const search = p.search || {};
        let searchPill = '';
        let turnOnSearchBtn = '';

        if (search.configured) {
          if (search.is_running) {
            searchPill = `<span class="px-2 py-0.5 rounded-[var(--r)] text-[11px] font-mono font-bold" style="background: var(--ok-bg); color: var(--ok); border: 1px solid var(--ok);" title="Search container is running">
              ● ${capitalize(search.type)} Active
            </span>`;
          } else if (search.profile) {
            searchPill = `<span class="px-2 py-0.5 rounded-[var(--r)] text-[11px] font-mono font-bold" style="background: var(--warn-bg); color: var(--warn); border: 1px solid var(--warn);" title="Search container not running (requires --profiles=${search.profile})">
              ○ Search Off (${search.profile})
            </span>`;
            turnOnSearchBtn = `<button onclick="triggerTurnOnSearch('${p.name}', '${search.profile || ''}', '${search.type || ''}', this)" class="px-2.5 py-1.5 text-xs font-mono font-bold rounded-[var(--r)] text-white shadow-sm transition active:scale-95 flex items-center gap-1.5" style="background: var(--g-warn);" title="Start ${search.type} search service (${search.profile})">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
              <span>Turn on Search</span>
            </button>`;
          } else {
            searchPill = `<span class="px-2 py-0.5 rounded-[var(--r)] text-[11px] font-mono font-bold" style="background: var(--ok-bg); color: var(--ok); border: 1px solid var(--ok);">
              ● ${capitalize(search.type)} Running
            </span>`;
          }
        }

        const dist = p.dist || {};
        let distPill = '';
        let buildDistBtn = '';
        if (dist.configured) {
          if (dist.is_built) {
            distPill = `<span class="px-2 py-0.5 rounded-[var(--r)] text-[11px] font-mono font-bold text-[var(--ok)] desk-card-2" title="Frontend dist assets built and ready">
              ● Dist Ready
            </span>`;
          } else {
            distPill = `<span class="px-2 py-0.5 rounded-[var(--r)] text-[11px] font-mono font-bold text-[var(--warn)] desk-card-2" title="Frontend dist missing (${dist.missing_themes?.join(', ') || 'unbuilt'})">
              ○ Dist Missing
            </span>`;
            buildDistBtn = `<button onclick="triggerBuildDist('${p.name}', this)" class="px-2.5 py-1.5 text-xs font-mono font-bold rounded-[var(--r)] desk-card-2 hover:bg-[var(--surface-3)] text-[var(--warn)] border border-[var(--warn)] transition" title="Build frontend dist (${dist.build_cmd || 'build'})">
              Build Dist
            </button>`;
          }
        }

        const gitPills = renderGitPills(p);

        const phpTag = p.php_version ? `<span class="text-[11px] font-mono text-[var(--muted)] px-1.5 py-0.5 rounded desk-card">PHP ${p.php_version}</span>` : '';
        const typeTag = p.project_type ? `<span class="text-[11px] font-mono text-[var(--faint)]">${p.project_type}</span>` : '';

        return `
          <div class="p-4 rounded-[var(--r)] desk-card-2 flex flex-col justify-between gap-3 border border-[var(--edge)] hover:border-[var(--accent)] transition">
            <div>
              <div class="flex items-center justify-between gap-2 flex-wrap">
                <div class="flex items-center gap-2">
                  <span class="w-2.5 h-2.5 rounded-full bg-[var(--ok)] animate-pulse shrink-0"></span>
                  <a href="${p.http_url}" target="_blank" rel="noopener noreferrer" class="text-sm font-display text-[var(--text)] hover:text-[var(--accent)] transition flex items-center gap-1.5" title="Open ${p.http_url} in browser">
                    <span>${p.name}</span>
                    <svg class="w-3.5 h-3.5 text-[var(--muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </div>
                <div class="flex items-center gap-1.5 flex-wrap">
                  ${gitPills}
                  ${searchPill}
                  ${distPill}
                  <span class="text-[10px] font-mono font-bold px-2 py-0.5 rounded-[calc(var(--r)-2px)] bg-[var(--bg-2)] text-[var(--ok)] border border-[var(--ok)]">
                    DB Safe
                  </span>
                </div>
              </div>

              <div class="flex items-center gap-2 mt-2 text-xs text-[var(--muted)] font-mono flex-wrap">
                ${phpTag}
                ${typeTag}
                <span class="truncate text-[11px] text-[var(--faint)]" title="${p.approot}">${p.approot}</span>
              </div>
            </div>

            <div class="flex items-center justify-between gap-2 pt-2.5 border-t border-[var(--line)] flex-wrap">
              <div class="flex items-center gap-2 flex-wrap">
                <a href="${p.http_url}" target="_blank" rel="noopener noreferrer" class="px-2.5 py-1.5 text-xs font-mono font-bold rounded-[var(--r)] text-white shadow-sm transition flex items-center gap-1.5" style="background: var(--g-accent);" title="Open live project in browser">
                  <span>Open Site ↗</span>
                </a>
                ${turnOnSearchBtn}
                ${buildDistBtn}
              </div>

              <div class="flex items-center gap-1.5">
                <button onclick="promptActionExec('ddev_restart_project', 'Restart Project: ${p.name}', 'ddev restart ${p.name}', 'Restarts running containers for project ${p.name}.', '${p.name}')" class="px-2 py-1.5 text-xs font-mono font-bold rounded-[var(--r)] desk-card hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-white transition" title="Restart Project">
                  Restart
                </button>
                <button onclick="promptActionExec('ddev_stop_project', 'Stop Project: ${p.name}', 'ddev stop ${p.name}', 'Stops running containers for project ${p.name} to free RAM and Mutagen caches. Database volumes remain preserved and ready.', '${p.name}')" class="px-2 py-1.5 text-xs font-mono font-bold rounded-[var(--r)] text-[var(--bad)] hover:bg-[var(--bad-bg)] border border-[var(--bad)] transition" title="Stop Project">
                  Stop
                </button>
                <button onclick="revealFile('${escapeQuotes(p.approot)}')" class="p-1.5 text-xs font-mono font-bold rounded-[var(--r)] desk-card hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-white transition" title="Reveal folder in Finder">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                </button>
                <button onclick="copyToClipboard('${escapeQuotes(p.approot)}', 'Copied project directory path!')" class="p-1.5 rounded-[var(--r)] desk-card hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-white transition" title="Copy project path">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
                </button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 2. FILTER & SORT STOPPED / OTHER PROJECTS
  const searchInput = document.getElementById('ddevStoppedSearch');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const sortSelect = document.getElementById('ddevStoppedSort');
  const sortBy = sortSelect ? sortSelect.value : 'newest';

  let stoppedProjects = stoppedProjectsAll.filter(p => {
    if (state.ddevFilterSearchOnly && !p.search?.configured) return false;
    if (state.ddevFilterDirtyOnly && (!p.git || !p.git.has_changes)) return false;
    if (query) {
      const matchName = p.name.toLowerCase().includes(query);
      const matchPath = p.approot.toLowerCase().includes(query);
      const matchPhp = p.php_version && p.php_version.toLowerCase().includes(query);
      const matchSearch = p.search?.type && p.search.type.toLowerCase().includes(query);
      const matchBranch = p.branch && p.branch.toLowerCase().includes(query);
      const matchDirty = (query === 'dirty' || query === 'changed' || query === 'untracked') && p.git?.has_changes;
      const matchClean = (query === 'clean') && p.git?.clean;
      if (!matchName && !matchPath && !matchPhp && !matchSearch && !matchBranch && !matchDirty && !matchClean) return false;
    }
    return true;
  });

  // Sorting
  stoppedProjects.sort((a, b) => {
    if (sortBy === 'newest') return (b.mtime || 0) - (a.mtime || 0);
    if (sortBy === 'oldest') return (a.mtime || 0) - (b.mtime || 0);
    if (sortBy === 'alpha_asc') return a.name.localeCompare(b.name);
    if (sortBy === 'alpha_desc') return b.name.localeCompare(a.name);
    if (sortBy === 'size') return (b.dumps_size || 0) - (a.dumps_size || 0);
    if (sortBy === 'dirty') return (b.git?.total_dirty || 0) - (a.git?.total_dirty || 0);
    return 0;
  });

  const sList = document.getElementById('ddevStoppedProjectsList');
  if (sList) {
    if (stoppedProjects.length === 0) {
      sList.innerHTML = `<div class="text-xs text-[var(--muted)] font-mono py-8 text-center">No stopped projects matching search/filter.</div>`;
    } else {
      sList.innerHTML = stoppedProjects.map(p => {
        const search = p.search || {};
        let searchBadge = '';
        let startSearchBtn = '';

        if (search.configured) {
          if (search.profile) {
            searchBadge = `<span class="px-2 py-0.5 rounded-[var(--r)] text-[10px] font-mono font-bold text-[var(--accent)] desk-card-2" title="Requires --profiles=${search.profile}">
              ${capitalize(search.type)} (${search.profile})
            </span>`;
            startSearchBtn = `<button onclick="triggerTurnOnSearch('${p.name}', '${search.profile || ''}', '${search.type || ''}', this)" class="px-2 py-1.5 text-xs font-mono font-bold rounded-[var(--r)] text-white shadow-sm transition active:scale-95 flex items-center gap-1" style="background: var(--g-warn);" title="Start project with search profile (${search.profile})">
              <span>+ Search</span>
            </button>`;
          } else {
            searchBadge = `<span class="px-2 py-0.5 rounded-[var(--r)] text-[10px] font-mono font-bold text-[var(--muted)] desk-card-2">
              ${capitalize(search.type)}
            </span>`;
          }
        }

        const dist = p.dist || {};
        let distBadge = '';
        let buildDistBtn = '';

        if (dist.configured) {
          if (dist.is_built) {
            distBadge = `<span class="px-2 py-0.5 rounded-[var(--r)] text-[10px] font-mono font-bold text-[var(--ok)] desk-card-2" title="Frontend dist assets built and ready">
              ● Dist Ready
            </span>`;
          } else {
            distBadge = `<span class="px-2 py-0.5 rounded-[var(--r)] text-[10px] font-mono font-bold text-[var(--warn)] desk-card-2" title="Dist missing (${dist.missing_themes?.join(', ') || 'unbuilt'})">
              ○ Dist Missing
            </span>`;
            buildDistBtn = `<button onclick="triggerBuildDist('${p.name}', this)" class="px-2 py-1.5 text-xs font-mono font-bold rounded-[var(--r)] desk-card hover:bg-[var(--surface-3)] text-[var(--warn)] border border-[var(--warn)] transition" title="Build frontend dist (${dist.build_cmd || 'build'})">
              Build Dist
            </button>`;
          }
        }

        const gitPills = renderGitPills(p);

        const ageTag = `<span class="text-[11px] font-mono text-[var(--muted)]">${p.last_modified_str || 'Stopped'}</span>`;
        const phpTag = p.php_version ? `<span class="text-[10px] font-mono text-[var(--faint)]">PHP ${p.php_version}</span>` : '';
        const dumpsInfo = p.dumps_size > 0 ? `<span class="text-[10px] font-mono text-[var(--warn)] font-bold">${p.dumps_size_str} dumps</span>` : '';

        const startEverythingBtn = `<button onclick="triggerStartEverything('${p.name}', '${search.profile || ''}', this)" class="px-2.5 py-1.5 text-xs font-mono font-bold rounded-[var(--r)] text-white shadow-sm transition active:scale-95 flex items-center gap-1.5" style="background: var(--g-ok);" title="Start Colima (if stopped) + DDEV containers${search.profile ? ' (' + search.profile + ')' : ''} + Build dist if missing">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          <span>Start Everything</span>
        </button>`;

        return `
          <div class="p-3 rounded-[var(--r)] desk-card-2 flex items-center justify-between hover:border-[var(--muted)] transition">
            <div class="min-w-0 pr-3">
              <div class="flex items-center gap-2 flex-wrap">
                <strong class="text-xs text-[var(--text)] font-sans font-bold">${p.name}</strong>
                <span class="px-2 py-0.5 rounded-[var(--r)] text-[10px] font-mono text-[var(--muted)] bg-[var(--bg-2)] border border-[var(--line)]">Stopped</span>
                ${gitPills}
                ${searchBadge}
                ${distBadge}
                ${dumpsInfo}
              </div>
              <div class="flex items-center gap-2 mt-1 text-[11px] text-[var(--muted)] font-mono">
                ${ageTag}
                ${phpTag}
                <span class="truncate text-[var(--faint)]" title="${p.approot}">${p.approot}</span>
              </div>
            </div>

            <div class="flex items-center gap-1.5 shrink-0 flex-wrap">
              ${startEverythingBtn}
              <button onclick="promptActionExec('ddev_start_project', 'Start Project: ${p.name}', 'ddev start ${p.name}', 'Starts project web and database containers for ${p.name}.', '${p.name}')" class="px-2 py-1.5 text-xs font-mono font-bold rounded-[var(--r)] desk-card hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-white transition" title="Start containers only (fast)">
                Start
              </button>
              ${startSearchBtn}
              ${buildDistBtn}
              <button onclick="revealFile('${escapeQuotes(p.approot)}')" class="p-1.5 rounded-[var(--r)] desk-card hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-white text-xs font-mono font-bold transition" title="Reveal folder in Finder">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
              </button>
              <button onclick="copyToClipboard('${escapeQuotes(p.approot)}', 'Copied project directory path!')" class="p-1.5 rounded-[var(--r)] desk-card hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-white text-xs font-mono font-bold transition" title="Copy project path">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 3. RENDER DOCKER VOLUMES
  const vList = document.getElementById('ddevVolumesList');
  if (vList) {
    document.getElementById('ddevVolumesCount').textContent = d.docker.volumes.length;
    
    vList.innerHTML = d.docker.volumes.map(v => {
      const isDb = v.type.includes('Database');
      const typeStyle = isDb ? 'color: var(--ok);' :
                        v.type.includes('Mutagen') ? 'color: var(--accent);' : 'color: var(--muted);';
      const badgeLabel = isDb ? 'Database (Preserved)' : v.type;

      return `
        <div class="p-2.5 rounded-[var(--r)] desk-card-2 flex items-center justify-between text-xs">
          <div class="truncate max-w-xs font-mono text-[var(--text)]" title="${v.name}">
            ${v.name}
          </div>
          <div class="text-xs font-mono font-bold" style="${typeStyle}">
            ${badgeLabel}
          </div>
        </div>
      `;
    }).join('');
  }
}

// -------------------------------------------------------------
// TAB 3: DEV ARTIFACTS
// -------------------------------------------------------------

function renderArtifactsSection() {
  if (!state.data) return;
  const artifacts = state.data.artifacts.artifacts;
  document.getElementById('artifactsTotalSize').textContent = state.data.artifacts.total_artifacts_size_str;
  
  const aList = document.getElementById('artifactsList');
  if (artifacts.length === 0) {
    aList.innerHTML = `<div class="text-xs text-[var(--muted)] font-mono py-8 text-center">No heavy build artifacts detected.</div>`;
    return;
  }

  aList.innerHTML = artifacts.map(a => `
    <div class="py-3.5 flex items-center justify-between hover:bg-[var(--surface-2)] px-3 rounded-[var(--r)] transition">
      <div>
        <div class="flex items-center gap-2">
          <span class="text-xs font-bold text-[var(--text)] font-sans">${a.project}</span>
          <span class="px-2 py-0.5 rounded-[var(--r)] text-xs desk-card-2 text-[var(--accent)] font-mono font-bold">${a.type}</span>
        </div>
        <div class="text-[11px] text-[var(--muted)] font-mono mt-0.5 truncate max-w-xl" title="${a.path}">
          ${a.path}
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-xs font-mono font-bold text-[var(--warn)]">${a.size_str}</span>
        <button onclick="promptActionExec('trash_artifact', 'Move Artifact to Trash: ${a.type}', 'rm -rf \"${a.path}\"', 'Safely moves this build artifact to macOS Trash (~/.Trash). It automatically re-generates when running npm install or build.', '${escapeQuotes(a.path)}')" class="px-3 py-1.5 text-xs font-mono font-bold rounded-[var(--r)] transition" style="background: var(--bad-bg); color: var(--bad); border: 1px solid var(--bad);" title="Move safely to macOS Trash">
          Trash Artifact
        </button>
        <button onclick="copyToClipboard('rm -rf \"${a.path}\"', 'Copied delete command!')" class="p-1.5 rounded-[var(--r)] desk-card hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-white transition" title="Copy CLI Command">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
        </button>
      </div>
    </div>
  `).join('');
}

// -------------------------------------------------------------
// DIRECT REVEAL & TRASH HANDLERS
// -------------------------------------------------------------

async function revealFile(path) {
  try {
    const res = await fetch('/api/action/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    });
    const result = await res.json();
    if (result.success) {
      showToast('Revealed in Finder', path);
    } else {
      showToast('Failed to reveal file', result.error || 'Path not found');
    }
  } catch (err) {
    console.error(err);
    showToast('Failed to reveal file', err.message);
  }
}

function revealDownloadsDB() {
  revealFile('~/Downloads/DB');
}

async function trashFile(path, name) {
  const confirmed = confirm(`Move this file to macOS Trash?\n\n${name}\n\n(It will be safely moved to ~/.Trash and can easily be recovered if needed)`);
  if (!confirmed) return;

  try {
    const res = await fetch('/api/action/trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    });
    const result = await res.json();
    if (result.success) {
      const freed = result.freed_str || 'Disk space';
      notifyDiskSpaceGain(freed, `Moved ${name} safely to ~/.Trash`, { isTrash: true });
      if (state.data) {
        state.data.db_dumps.dumps = state.data.db_dumps.dumps.filter(d => d.path !== path);
        state.data.db_dumps.total_dumps = state.data.db_dumps.dumps.length;
        const newTotal = state.data.db_dumps.dumps.reduce((a, c) => a + c.size, 0);
        state.data.db_dumps.total_dumps_size = newTotal;
        state.data.db_dumps.total_dumps_size_str = formatBytes(newTotal);
        renderDumpsTable();
      }
    } else {
      alert(`Error: ${result.error || 'Failed to move to Trash'}`);
    }
  } catch (err) {
    console.error(err);
    alert('Server error.');
  }
}

// -------------------------------------------------------------
// DIRECT ACTIONS & SEARCH PROFILE CONTROLS
// -------------------------------------------------------------

async function triggerTurnOnSearch(projectName, profile, searchType, btnEl) {
  const safeProfile = profile || 'search';
  const label = searchType ? capitalize(searchType) : 'Search';
  
  let originalContent = '';
  if (btnEl) {
    originalContent = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.classList.add('opacity-75');
    btnEl.innerHTML = `
      <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
      </svg>
      <span>Starting...</span>
    `;
  }

  showToast(`Spinning up ${label} for ${projectName}...`, `Running: ddev start ${projectName} --profiles=${safeProfile}`);

  try {
    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'ddev_start_search',
        target: projectName,
        profile: safeProfile
      })
    });
    const result = await res.json();
    if (result.success) {
      showToast(`${projectName}: ${label} is active!`, result.command ? `$ ${result.command}` : '');
      triggerRefresh();
    } else {
      const errMsg = result.stderr || result.error || 'Failed to start search container';
      showToast(`Error starting search for ${projectName}`, errMsg, 'Details', () => {
        promptActionExec('ddev_start_search', `Turn on Search: ${projectName}`, `ddev start ${projectName} --profiles=${safeProfile}`, errMsg, projectName, safeProfile);
      });
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.classList.remove('opacity-75');
        btnEl.innerHTML = originalContent;
      }
    }
  } catch (err) {
    showToast(`Error contacting server: ${err.message}`);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.classList.remove('opacity-75');
      btnEl.innerHTML = originalContent;
    }
  }
}

async function triggerStartEverything(projectName, profile, btnEl) {
  let originalContent = '';
  if (btnEl) {
    originalContent = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.classList.add('opacity-75');
    btnEl.innerHTML = `
      <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
      </svg>
      <span>Starting...</span>
    `;
  }

  showToast(`Spinning up everything for ${projectName}...`, `Checking Colima, DDEV${profile ? ' (' + profile + ')' : ''}, & Dist`);

  try {
    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'ddev_start_everything',
        target: projectName,
        profile: profile || ''
      })
    });
    const result = await res.json();
    if (result.success) {
      showToast(`${projectName} is completely ready!`, `Finished in ${result.duration}s`);
      triggerRefresh();
    } else {
      const errMsg = result.stderr || result.error || 'Failed to complete full startup';
      showToast(`Error starting ${projectName}`, errMsg, 'Details', () => {
        promptActionExec('ddev_start_everything', `Start Everything: ${projectName}`, `ddev start ${projectName}${profile ? ' --profiles=' + profile : ''}`, result.stdout || errMsg, projectName, profile);
      });
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.classList.remove('opacity-75');
        btnEl.innerHTML = originalContent;
      }
    }
  } catch (err) {
    showToast(`Error contacting server: ${err.message}`);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.classList.remove('opacity-75');
      btnEl.innerHTML = originalContent;
    }
  }
}

async function triggerBuildDist(projectName, btnEl) {
  let originalContent = '';
  if (btnEl) {
    originalContent = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.classList.add('opacity-75');
    btnEl.innerHTML = `
      <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
      </svg>
      <span>Building...</span>
    `;
  }

  showToast(`Building frontend dist for ${projectName}...`, 'Running asset pipeline in theme directory');

  try {
    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'ddev_build_dist',
        target: projectName
      })
    });
    const result = await res.json();
    if (result.success) {
      showToast(`${projectName}: Dist built successfully!`, result.command ? `$ ${result.command}` : '');
      triggerRefresh();
    } else {
      const errMsg = result.stderr || result.error || 'Frontend build failed';
      showToast(`Build error for ${projectName}`, errMsg, 'Details', () => {
        promptActionExec('ddev_build_dist', `Build Dist: ${projectName}`, result.command || 'make buildall', errMsg, projectName);
      });
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.classList.remove('opacity-75');
        btnEl.innerHTML = originalContent;
      }
    }
  } catch (err) {
    showToast(`Error: ${err.message}`);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.classList.remove('opacity-75');
      btnEl.innerHTML = originalContent;
    }
  }
}

// -------------------------------------------------------------
// COLIMA RESOURCE SETTINGS MODAL
// -------------------------------------------------------------

function openColimaSettingsModal() {
  const modal = document.getElementById('colimaModal');
  if (!modal) return;

  const colima = state.data?.overview?.colima || {};
  const cpu = colima.cpu || 4;
  const memory = colima.memory || 8;
  const disk = colima.disk || 100;
  const isRunning = colima.is_running || false;

  document.getElementById('colimaInputCpu').value = cpu;
  document.getElementById('colimaInputMem').value = memory;
  document.getElementById('colimaInputDisk').value = disk;

  updateColimaSettingsLabels();

  // Populate Live Usage vs Settings Text
  const mRam = document.getElementById('modalRamUsageText');
  if (mRam) {
    mRam.textContent = isRunning
      ? `${colima.memory_used_str || '0 B'} used of ${colima.memory_str || '8 GiB'} (${colima.memory_used_percent || 0}%) [Host: ${colima.host_total_ram_str || '--'}]`
      : `0 B used of ${colima.memory_str || '8 GiB'} (VM Stopped) [Host: ${colima.host_total_ram_str || '--'}]`;
  }

  const mCpu = document.getElementById('modalCpuUsageText');
  if (mCpu) {
    mCpu.textContent = isRunning
      ? `${colima.cpu_used_percent || 0}% load on ${colima.cpu_str || '4 Cores'} [Host: ${colima.host_total_cpus || '--'} Cores]`
      : `0% load (VM Stopped, limit: ${colima.cpu_str || '4 Cores'}) [Host: ${colima.host_total_cpus || '--'} Cores]`;
  }

  const mDisk = document.getElementById('modalDiskUsageText');
  if (mDisk) {
    mDisk.textContent = `${colima.disk_used_str || '--'} allocated of ${colima.disk_str || '100 GiB'} (${colima.disk_used_percent || 0}%)`;
  }

  const toggleBtn = document.getElementById('colimaToggleRunningBtn');
  if (toggleBtn) {
    toggleBtn.innerHTML = isRunning 
      ? `<span class="text-[var(--bad)] font-bold">Stop Colima VM</span>`
      : `<span class="text-[var(--ok)] font-bold">Start Colima VM</span>`;
  }

  const out = document.getElementById('colimaSettingsOutput');
  out.classList.add('hidden');
  out.textContent = '';

  modal.classList.remove('hidden');
}

function closeColimaSettingsModal() {
  const modal = document.getElementById('colimaModal');
  if (modal) modal.classList.add('hidden');
}

function updateColimaSettingsLabels() {
  const cpu = document.getElementById('colimaInputCpu').value;
  const mem = document.getElementById('colimaInputMem').value;
  const disk = document.getElementById('colimaInputDisk').value;

  const cpuDisp = document.getElementById('colimaCpuDisplay');
  if (cpuDisp) cpuDisp.textContent = `${cpu} Cores`;

  const memDisp = document.getElementById('colimaMemDisplay');
  if (memDisp) memDisp.textContent = `${mem} GiB`;

  const diskDisp = document.getElementById('colimaDiskDisplay');
  if (diskDisp) diskDisp.textContent = `${disk} GiB`;
}

function applyColimaPreset(cpu, mem) {
  document.getElementById('colimaInputCpu').value = cpu;
  document.getElementById('colimaInputMem').value = mem;
  updateColimaSettingsLabels();
}

async function saveColimaSettings(restart = true) {
  const cpu = parseInt(document.getElementById('colimaInputCpu').value, 10);
  const memory = parseInt(document.getElementById('colimaInputMem').value, 10);
  const disk = parseInt(document.getElementById('colimaInputDisk').value, 10);

  const saveBtn = document.getElementById('colimaSaveRestartBtn');
  const out = document.getElementById('colimaSettingsOutput');

  saveBtn.disabled = true;
  saveBtn.classList.add('opacity-75');
  out.classList.remove('hidden');
  out.textContent = restart ? 'Saving configuration and restarting Colima VM... please wait...' : 'Saving configuration...';

  try {
    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'colima_set_resources',
        cpu,
        memory,
        disk,
        restart
      })
    });
    const result = await res.json();
    saveBtn.disabled = false;
    saveBtn.classList.remove('opacity-75');

    if (result.success) {
      out.textContent = result.stdout || 'Colima configuration updated successfully!';
      showToast('Colima settings applied!', `${cpu} CPUs • ${memory} GB RAM • ${disk} GB Disk`);
      setTimeout(() => {
        closeColimaSettingsModal();
        triggerRefresh();
      }, 1200);
    } else {
      out.textContent = `Error: ${result.stderr || result.error || 'Failed to update Colima'}`;
    }
  } catch (err) {
    saveBtn.disabled = false;
    saveBtn.classList.remove('opacity-75');
    out.textContent = `Network error: ${err.message}`;
  }
}

async function toggleColimaLifecycle() {
  const colima = state.data?.overview?.colima || {};
  const isRunning = colima.is_running || false;
  const action = isRunning ? 'colima_stop' : 'colima_start';
  const label = isRunning ? 'Stopping Colima...' : 'Starting Colima...';

  const toggleBtn = document.getElementById('colimaToggleRunningBtn');
  if (toggleBtn) {
    toggleBtn.disabled = true;
    toggleBtn.textContent = 'Working...';
  }

  showToast(label, 'Executing Colima lifecycle transition');

  try {
    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const result = await res.json();
    if (result.success) {
      showToast(isRunning ? 'Colima stopped' : 'Colima is running!', result.stdout || '');
      closeColimaSettingsModal();
      triggerRefresh();
    } else {
      showToast('Colima error', result.stderr || result.error || 'Operation failed');
      if (toggleBtn) toggleBtn.disabled = false;
    }
  } catch (err) {
    showToast('Network error', err.message);
    if (toggleBtn) toggleBtn.disabled = false;
  }
}

async function triggerColimaRestart(btnEl) {
  let originalContent = '';
  if (btnEl) {
    originalContent = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.classList.add('opacity-75');
    const hasText = btnEl.querySelector('span');
    if (hasText) {
      btnEl.innerHTML = `
        <svg class="w-3.5 h-3.5 animate-spin text-[var(--accent)]" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <span>Restarting...</span>
      `;
    } else {
      btnEl.innerHTML = `
        <svg class="w-3.5 h-3.5 animate-spin text-[var(--accent)]" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
      `;
    }
  }

  showToast('Restarting Colima VM...', 'Running: colima restart (preserving database volumes)');

  try {
    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'colima_restart' })
    });
    const result = await res.json();
    if (result.success) {
      showToast('Colima restarted successfully!', result.command ? `$ ${result.command}` : '');
      closeColimaSettingsModal();
      triggerRefresh();
    } else {
      showToast('Colima restart failed', result.stderr || result.error || 'Operation failed', 'Details', () => {
        promptActionExec('colima_restart', 'Restart Colima VM', 'colima restart', result.stderr || result.error || 'Failed to restart Colima');
      });
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.classList.remove('opacity-75');
        btnEl.innerHTML = originalContent;
      }
    }
  } catch (err) {
    showToast('Network error', err.message);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.classList.remove('opacity-75');
      btnEl.innerHTML = originalContent;
    }
  }
}

// -------------------------------------------------------------
// ACTION EXECUTION MODAL (Direct 1-Click Execution)
// -------------------------------------------------------------

function promptActionExec(action, title, cmd, desc, target = '', profile = '') {
  state.currentAction = { action, title, cmd, desc, target, profile };
  
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalDesc').textContent = desc;
  document.getElementById('modalCmdText').textContent = cmd;
  
  const outSection = document.getElementById('modalOutputSection');
  outSection.classList.add('hidden');
  document.getElementById('modalOutputBox').textContent = '';

  const runBtn = document.getElementById('modalRunBtn');
  runBtn.disabled = false;
  document.getElementById('modalRunBtnText').textContent = 'Execute Action';
  document.getElementById('modalSpinner').classList.add('hidden');

  document.getElementById('actionModal').classList.remove('hidden');
}

function closeExecModal() {
  document.getElementById('actionModal').classList.add('hidden');
  state.currentAction = null;
}

function copyModalCmd() {
  if (state.currentAction) {
    copyToClipboard(state.currentAction.cmd, 'Copied command to clipboard!');
  }
}

async function runConfirmedAction() {
  if (!state.currentAction) return;

  const { action, target, profile } = state.currentAction;
  const runBtn = document.getElementById('modalRunBtn');
  const spinner = document.getElementById('modalSpinner');
  const btnText = document.getElementById('modalRunBtnText');
  const outSection = document.getElementById('modalOutputSection');
  const outBox = document.getElementById('modalOutputBox');

  runBtn.disabled = true;
  spinner.classList.remove('hidden');
  btnText.textContent = 'Running...';
  outSection.classList.remove('hidden');
  outBox.textContent = 'Executing command on your Mac... please wait...\n';

  try {
    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, target, profile })
    });
    const result = await res.json();
    
    spinner.classList.add('hidden');
    if (result.success) {
      const hasGain = result.saved_str && result.saved_str !== '0B' && result.saved_str !== '0 B';
      btnText.textContent = hasGain ? `Completed (+${result.saved_str})` : 'Completed';
      
      let outText = result.stdout || 'Command executed successfully with code 0.';
      if (hasGain) {
        outText += `\n\n════════════════════════════════════════════════════════════\n🎉 DISK SPACE GAIN: ${result.saved_str} reclaimed successfully!\n════════════════════════════════════════════════════════════`;
      }
      outText += `\n\n[Finished in ${result.duration}s]`;
      outBox.textContent = outText;

      if (hasGain) {
        notifyDiskSpaceGain(
          result.saved_str, 
          result.command ? `$ ${result.command}` : (state.currentAction?.title || 'Disk optimization action'),
          { isColima: action.includes('colima') }
        );
      } else {
        showToast('Action completed successfully!', result.command ? `$ ${result.command}` : 'Re-scanning disks...');
      }

      setTimeout(() => {
        closeExecModal();
        triggerRefresh();
      }, 1600);
    } else {
      btnText.textContent = 'Failed';
      outBox.textContent = `Exit Code: ${result.exit_code}\n\nSTDOUT:\n${result.stdout || '(none)'}\n\nSTDERR:\n${result.stderr || result.error || '(none)'}`;
      runBtn.disabled = false;
    }
  } catch (err) {
    spinner.classList.add('hidden');
    btnText.textContent = 'Error';
    outBox.textContent = `Failed to contact server: ${err.message}`;
    runBtn.disabled = false;
  }
}

// -------------------------------------------------------------
// UTILITIES
// -------------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function capitalize(str) {
  if (!str) return '';
  return String(str).charAt(0).toUpperCase() + String(str).slice(1);
}

function escapeQuotes(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
