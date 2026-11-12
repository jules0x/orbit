let state = {
  data: null,
  activeTab: 'ddev',
  selectedDumps: new Set(),
  lastClickedDumpIndex: null,
  dumpsSortBy: 'size',
  dumpsSortOrder: 'desc',
  artifactsSortBy: 'size',
  artifactsSortOrder: 'desc',
  dockerImagesSortBy: 'size',
  dockerImagesSortOrder: 'desc',
  currentAction: null,
  ddevFilterSearchOnly: false,
  ddevFilterDirtyOnly: false,
  startingProjects: {}
};

let toastTimeout = null;
let toastRemainingMs = 8000;
let toastStartTime = 0;

function formatPath(path) {
  if (!path) return '';
  return String(path).replace(/^\/Users\/[^\/]+/, '~');
}

function parseSizeToBytes(sizeStr) {
  if (!sizeStr) return 0;
  const s = String(sizeStr).trim().toUpperCase();
  const num = parseFloat(s);
  if (isNaN(num)) return 0;
  if (s.endsWith('GB') || s.endsWith('G')) return num * 1024 * 1024 * 1024;
  if (s.endsWith('MB') || s.endsWith('M')) return num * 1024 * 1024;
  if (s.endsWith('KB') || s.endsWith('K')) return num * 1024;
  if (s.endsWith('B')) return num;
  return num;
}


// -------------------------------------------------------------
// 1-CLICK iTERM LAUNCHER (macOS iTerm & Clipboard)
// -------------------------------------------------------------

async function launchTerminal(cmd = '', approot = '') {
  if (cmd) {
    try {
      await navigator.clipboard.writeText(cmd);
    } catch (e) {
      console.warn('Clipboard write warning:', e);
    }
    showToast(`Launching iTerm with '${cmd}'...`, 'iTerm Launch', false);
  } else {
    showToast(`Opening iTerm in project directory...`, 'iTerm Launch', false);
  }
  try {
    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'launch_terminal',
        command: cmd,
        approot: approot
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast(cmd ? `iTerm active: ${cmd}` : 'iTerm active in directory', 'Ready', false);
    }
  } catch (err) {
    console.error('Error invoking terminal launch:', err);
  }
}

// -------------------------------------------------------------
// NATIVE SEQUEL ACE DATABASE LAUNCHER (Headless / Zero Terminal)
// -------------------------------------------------------------

async function openDatabase(projectName, approot = '') {
  showToast(`Opening Sequel Ace for ${projectName}...`, 'Database', false);
  try {
    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'open_database',
        target: projectName,
        approot: approot
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Sequel Ace connected to ${projectName}`, 'Database Ready', false);
    } else {
      showToast(data.error || 'Failed to open database', 'Error', false);
    }
  } catch (err) {
    console.error('Error opening database:', err);
  }
}

// -------------------------------------------------------------
// LIVE CONTAINER LOGS VIEWER (Docker Desktop Parity)
// -------------------------------------------------------------

const logsState = {
  target: null,          // project name or container name
  isDocker: false,       // true if raw container
  service: 'web',        // web, db, all
  tail: 150,
  autoRefresh: true,
  timer: null,
  rawText: '',
  searchTerm: ''
};

function openLogsModal(target, service = 'web', isDocker = false) {
  logsState.target = target;
  logsState.service = service;
  logsState.isDocker = isDocker;
  logsState.searchTerm = '';
  
  const modal = document.getElementById('logsViewerModal');
  const title = document.getElementById('logsModalTitle');
  const sub = document.getElementById('logsModalSubtitle');
  const svcGroup = document.getElementById('logsServiceGroup');
  const searchInput = document.getElementById('logsSearchInput');
  if (searchInput) searchInput.value = '';

  if (title) title.textContent = isDocker ? `Container Logs: ${target}` : `Logs: ${target}`;
  if (sub) sub.textContent = isDocker ? 'Direct docker logs output' : `DDEV service: ${service}`;
  
  if (svcGroup) {
    svcGroup.style.display = isDocker ? 'none' : 'flex';
    updateLogServiceButtons();
  }

  const tailSel = document.getElementById('logsTailSelect');
  if (tailSel) logsState.tail = parseInt(tailSel.value, 10) || 150;

  if (modal) modal.classList.remove('hidden');

  fetchLogsData();
  startLogsAutoRefresh();
}

function closeLogsModal() {
  const modal = document.getElementById('logsViewerModal');
  if (modal) modal.classList.add('hidden');
  stopLogsAutoRefresh();
}

function changeLogsService(svc) {
  logsState.service = svc;
  updateLogServiceButtons();
  const sub = document.getElementById('logsModalSubtitle');
  if (sub) sub.textContent = `DDEV service: ${svc}`;
  fetchLogsData();
}

function updateLogServiceButtons() {
  ['web', 'db', 'all'].forEach(s => {
    const btn = document.getElementById(`logSvc-${s}`);
    if (btn) {
      if (s === logsState.service) {
        btn.className = 'px-2.5 py-1 rounded-[calc(var(--r)-2px)] font-mono text-[11px] font-semibold text-white bg-indigo-600';
      } else {
        btn.className = 'px-2.5 py-1 rounded-[calc(var(--r)-2px)] font-mono text-[11px] font-medium text-[var(--muted)] hover:text-white';
      }
    }
  });
}

async function fetchLogsData() {
  if (!logsState.target) return;
  const tailSel = document.getElementById('logsTailSelect');
  if (tailSel) logsState.tail = parseInt(tailSel.value, 10) || 150;

  try {
    let bodyObj = {};
    if (logsState.isDocker) {
      bodyObj = {
        action: 'docker_logs',
        target: logsState.target,
        tail: logsState.tail
      };
    } else {
      bodyObj = {
        action: 'ddev_logs',
        target: logsState.target,
        service: logsState.service,
        tail: logsState.tail
      };
    }

    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    });
    const data = await res.json();
    logsState.rawText = (data.stdout || '') + (data.stderr ? '\n' + data.stderr : '');
    if (!logsState.rawText.trim()) {
      logsState.rawText = '(No logs returned or container is starting up...)';
    }
    filterLogsView();
  } catch (e) {
    console.error('Failed to fetch logs:', e);
  }
}

function filterLogsView() {
  const input = document.getElementById('logsSearchInput');
  const term = (input ? input.value : '').trim().toLowerCase();
  const pre = document.getElementById('logsTerminalOutput');
  const countSpan = document.getElementById('logsMatchCount');
  
  if (!pre) return;
  const lines = logsState.rawText.split('\n');
  if (!term) {
    pre.textContent = logsState.rawText;
    if (countSpan) countSpan.textContent = `${lines.length} lines`;
  } else {
    const filtered = lines.filter(l => l.toLowerCase().includes(term));
    pre.textContent = filtered.length > 0 ? filtered.join('\n') : `(No lines match '${term}')`;
    if (countSpan) countSpan.textContent = `${filtered.length} / ${lines.length} lines`;
  }
}

function scrollLogsToBottom() {
  const box = document.getElementById('logsTerminalContainer');
  if (box) box.scrollTop = box.scrollHeight;
}

function toggleLogsAutoRefresh() {
  logsState.autoRefresh = !logsState.autoRefresh;
  const dot = document.getElementById('logsLiveDot');
  if (logsState.autoRefresh) {
    if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
    startLogsAutoRefresh();
    showToast('Live auto-refresh enabled (3s)', 'Logs', false);
  } else {
    if (dot) dot.className = 'w-2 h-2 rounded-full bg-zinc-600';
    stopLogsAutoRefresh();
    showToast('Live auto-refresh paused', 'Logs', false);
  }
}

function startLogsAutoRefresh() {
  stopLogsAutoRefresh();
  if (!logsState.autoRefresh) return;
  logsState.timer = setInterval(() => {
    const modal = document.getElementById('logsViewerModal');
    if (modal && !modal.classList.contains('hidden')) {
      fetchLogsData();
    } else {
      stopLogsAutoRefresh();
    }
  }, 3000);
}

function stopLogsAutoRefresh() {
  if (logsState.timer) {
    clearInterval(logsState.timer);
    logsState.timer = null;
  }
}

function copyLogsContent() {
  const pre = document.getElementById('logsTerminalOutput');
  if (pre && pre.textContent) {
    copyToClipboard(pre.textContent, 'Copied full container logs to clipboard!');
  }
}

function formatPortChips(portsStr) {
  if (!portsStr) return '';
  const mappings = portsStr.split(',').map(s => s.trim()).filter(Boolean);
  const seenHostPorts = new Set();
  const chips = [];

  for (const m of mappings) {
    const match = m.match(/(?:(?:\d+\.\d+\.\d+\.\d+|\[::\]|:::):)?(\d+)->(\d+)\/(\w+)/);
    if (match) {
      const hostPort = match[1];
      const containerPort = match[2];
      if (seenHostPorts.has(hostPort)) continue;
      seenHostPorts.add(hostPort);

      const isHttp = ['80', '443', '8025', '8026', '8080', '3000', '5173', '9000'].includes(hostPort) ||
                     ['80', '8025', '8026', '8080'].includes(containerPort);
      
      if (isHttp) {
        chips.push(`
          <a href="http://localhost:${hostPort}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-indigo-950/60 text-indigo-400 border border-indigo-800/40 hover:underline" title="Open http://localhost:${hostPort}">
            <span>:${hostPort}</span>
            <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
          </a>
        `);
      } else {
        chips.push(`
          <button onclick="copyToClipboard('127.0.0.1:${hostPort}', 'Copied host port 127.0.0.1:${hostPort}!')" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono text-[var(--muted)] hover:text-white bg-[var(--surface)] border border-[var(--line)] transition" title="Click to copy 127.0.0.1:${hostPort}">
            <span>:${hostPort}</span>
          </button>
        `);
      }
    }
  }

  return chips.join(' ');
}

document.addEventListener('DOMContentLoaded', () => {
  document.body.setAttribute('data-tab', 'ddev');
  loadData();
  setupGlobalShortcuts();

  // Real-time synchronization: refresh data when user switches back to window
  window.addEventListener('focus', () => {
    loadData();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadData();
  });

  // Background live sync every 12 seconds
  setInterval(() => {
    if (!document.hidden && !state.currentAction) {
      loadData();
    }
  }, 12000);
});

function setupGlobalShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Escape to close modal or clear selection
    if (e.key === 'Escape') {
      const drawerModal = document.getElementById('appDrawerModal');
      if (drawerModal && !drawerModal.classList.contains('hidden')) {
        closeAppDrawerModal();
        return;
      }
      const logsModal = document.getElementById('logsViewerModal');
      if (logsModal && !logsModal.classList.contains('hidden')) {
        closeLogsModal();
        return;
      }
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

  const actionText = isTrash ? 'Open Trash' : (state.activeTab === 'storage' ? 'Dismiss' : 'View Storage');
  const actionCb = isTrash
    ? () => { revealFile('~/.Trash'); hideToast(); }
    : () => {
        if (state.activeTab !== 'storage') {
          switchTab('storage');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        hideToast();
      };

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
  // Alias mappings
  if (tabId === 'projects') tabId = 'ddev';
  if (tabId === 'artifacts' || tabId === 'playbook' || tabId === 'dumps' || tabId === 'optimizer') tabId = 'storage';

  state.activeTab = tabId;
  
  // Aligns page background ambient aura to active section
  document.body.setAttribute('data-tab', tabId);
  
  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('tab-active');
  });

  const activeBtn = document.getElementById(`tabBtn-${tabId}`);
  if (activeBtn) {
    activeBtn.classList.add('tab-active');
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

async function triggerRefresh(silent = true) {
  const spinner = document.getElementById('refreshSpinner');
  const btnText = document.getElementById('refreshBtnText');
  if (spinner) spinner.classList.add('animate-spin');
  if (btnText) btnText.textContent = 'Scanning...';

  try {
    await fetch('/api/refresh', { method: 'POST' });
    if (!silent) {
      showToast('Environment audit scan refreshed', 'Checking Mac & Docker storage...');
    }
    setTimeout(loadData, 1200);
  } catch (err) {
    console.error('Refresh request error:', err);
  } finally {
    setTimeout(() => {
      if (spinner) spinner.classList.remove('animate-spin');
      if (btnText) btnText.textContent = 'Refresh';
    }, 1200);
  }
}

function renderAll() {
  if (!state.data) return;
  const d = state.data;

  // Overview metrics
  const dfStr = document.getElementById('diskFreeStr');
  if (dfStr) dfStr.textContent = d.overview.disk_free_str;
  const duStr = document.getElementById('diskUsedStr');
  if (duStr) duStr.textContent = d.overview.disk_used_str;
  const dtStr = document.getElementById('diskTotalStr');
  if (dtStr) dtStr.textContent = d.overview.disk_total_str;
  const dpText = document.getElementById('diskPercentText');
  if (dpText) dpText.textContent = `${d.overview.disk_used_percent}% utilized`;
  
  const pBar = document.getElementById('diskProgressBar');
  if (pBar) pBar.style.width = `${Math.min(100, d.overview.disk_used_percent)}%`;

  const freeGB = d.overview.disk_free / (1024 ** 3);

  // Header quick storage pill
  const dfh = document.getElementById('diskFreeHeaderStr');
  if (dfh) dfh.textContent = `${d.overview.disk_free_str} Free`;
  const duh = document.getElementById('diskUsedHeaderStr');
  if (duh) duh.textContent = `${d.overview.disk_used_str} (${d.overview.disk_used_percent}%)`;
  const dth = document.getElementById('diskTotalHeaderStr');
  if (dth) dth.textContent = d.overview.disk_total_str;
  const dah = document.getElementById('diskAlertBadgeHeader');
  if (dah) {
    if (freeGB < 20) {
      dah.textContent = 'Critical';
      dah.className = 'text-[10px] px-1.5 py-0.2 rounded font-mono font-medium bg-rose-950/60 text-rose-400 border border-rose-800/40';
    } else if (freeGB < 40) {
      dah.textContent = 'Low Space';
      dah.className = 'text-[10px] px-1.5 py-0.2 rounded font-mono font-medium bg-amber-950/60 text-amber-400 border border-amber-800/40';
    } else {
      dah.textContent = 'Healthy';
      dah.className = 'text-[10px] px-1.5 py-0.2 rounded font-mono font-medium bg-emerald-950/60 text-emerald-400 border border-emerald-800/40';
    }
  }

  const alertBadge = document.getElementById('diskAlertBadge');
  if (alertBadge) {
    if (freeGB < 20) {
      alertBadge.textContent = 'Critical';
      alertBadge.className = 'text-[10px] px-2 py-0.5 rounded font-mono font-medium bg-rose-950/60 text-rose-400 border border-rose-800/40';
    } else if (freeGB < 40) {
      alertBadge.textContent = 'Low Space';
      alertBadge.className = 'text-[10px] px-2 py-0.5 rounded font-mono font-medium bg-amber-950/60 text-amber-400 border border-amber-800/40';
    } else {
      alertBadge.textContent = 'Healthy';
      alertBadge.className = 'text-[10px] px-2 py-0.5 rounded font-mono font-medium bg-emerald-950/60 text-emerald-400 border border-emerald-800/40';
    }
  }

  const mColima = document.getElementById('metricColimaDisk');
  if (mColima) mColima.textContent = d.overview.colima_allocated_str;
  const mDumps = document.getElementById('metricDbDumps');
  if (mDumps) mDumps.textContent = d.db_dumps.total_dumps_size_str;
  const mDocker = document.getElementById('metricDockerVolumes');
  if (mDocker) mDocker.textContent = `${d.docker.total_volumes} vols`;
  const pSavings = document.getElementById('potentialSavingsStr');
  if (pSavings) pSavings.textContent = `~${d.potential_savings_str}`;
  
  const colimaTitle = document.getElementById('colimaAllocatedTitle');
  if (colimaTitle) {
    colimaTitle.textContent = d.overview.colima_allocated_str;
  }

  // Colima Resource Bar
  const colima = d.overview.colima || {};
  const isColimaRunning = colima.is_running || false;
  const colimaDot = document.getElementById('colimaStatusDot');
  if (colimaDot) {
    colimaDot.className = `w-2 h-2 rounded-full shrink-0 ${isColimaRunning ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`;
  }
  const colimaTxt = document.getElementById('colimaStatusText');
  if (colimaTxt) {
    colimaTxt.textContent = `Colima (${isColimaRunning ? 'Running' : 'Stopped'})`;
    colimaTxt.className = `font-medium ${isColimaRunning ? 'text-emerald-400' : 'text-[var(--muted)]'}`;
  }
  const cCpu = document.getElementById('colimaCpuPill');
  if (cCpu) {
    cCpu.textContent = `${colima.cpu_used_percent || 0}% / ${colima.cpu_str || '4 Cores'}`;
  }
  const cMem = document.getElementById('colimaMemPill');
  if (cMem) {
    cMem.textContent = `${colima.memory_used_str || '0 B'} / ${colima.memory_str || '8 GiB'}`;
  }
  const cDisk = document.getElementById('colimaDiskPill');
  if (cDisk) {
    cDisk.textContent = d.overview.colima_allocated_str || (colima.disk_used_str || '--');
  }

  // Colima Deep Dive Banner Cards
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
  const allProjs = Object.values(d.projects || {});
  const runningCount = allProjs.filter(p => p.is_running).length;

  const tcDdev = document.getElementById('tabCount-ddev');
  if (tcDdev) tcDdev.textContent = `${runningCount} active`;
  const tcStorage = document.getElementById('tabCount-storage');
  if (tcStorage) {
    const dumpCount = (d.db_dumps && d.db_dumps.total_dumps) ? `${d.db_dumps.total_dumps} dumps • ` : '';
    tcStorage.textContent = `${dumpCount}~${d.potential_savings_str}`;
  }
  const tcDumps = document.getElementById('tabCount-dumps');
  if (tcDumps) tcDumps.textContent = `${d.db_dumps.total_dumps} • ${d.db_dumps.total_dumps_size_str}`;
  const tcOpt = document.getElementById('tabCount-optimizer');
  if (tcOpt) tcOpt.textContent = `~${d.potential_savings_str}`;
  const tcDocker = document.getElementById('tabCount-docker');
  if (tcDocker) tcDocker.textContent = `${d.docker.total_volumes} vols`;

  // Render sections
  renderDumpsTable();
  renderDdevSection();
  renderArtifactsSection();
  renderDockerSection();
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
  const totalRawDumps = state.data.db_dumps?.dumps?.length || 0;
  const emptyBanner = document.getElementById('dumpsEmptyBanner');
  const fullView = document.getElementById('dumpsFullView');

  if (totalRawDumps === 0) {
    if (emptyBanner) emptyBanner.classList.remove('hidden');
    if (fullView) fullView.classList.add('hidden');
    document.getElementById('dumpsCountText').textContent = '0';
    document.getElementById('dumpsSizeText').textContent = '0 B';
    updateSelectionToolbar([]);
    return;
  }

  if (emptyBanner) emptyBanner.classList.add('hidden');
  if (fullView) fullView.classList.remove('hidden');

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
        <td class="py-2.5 px-2.5 text-center" onclick="event.stopPropagation()">
          <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleDumpSelection(${index}, this.checked)" class="w-4 h-4 rounded-[calc(var(--r)-3px)] bg-[var(--surface-2)] border-[var(--edge)] cursor-pointer">
        </td>
        <td class="py-2.5 px-2.5 font-mono text-[var(--text)]">
          <div class="truncate max-w-[150px] sm:max-w-xs xl:max-w-[190px] 2xl:max-w-sm font-bold text-[var(--text)]" title="${d.name}">
            ${d.name}
          </div>
          <div class="text-[10px] text-[var(--muted)] font-mono truncate max-w-[150px] sm:max-w-xs xl:max-w-[190px] 2xl:max-w-sm mt-0.5" title="${formatPath(d.path)}">
            ${formatPath(d.path)}
          </div>
        </td>
        <td class="py-2 px-1.5 whitespace-nowrap">${projBadge}</td>
        <td class="py-2 px-1.5 font-mono text-[var(--muted)]">
          <span class="px-2 py-0.5 rounded-[var(--r)] text-xs bg-[var(--bg-2)] border border-[var(--line)] whitespace-nowrap">${(d.location || '').replace(/\s*\([Ss]ubdir\)/g, '').trim()}</span>
        </td>
        <td class="py-2 px-1.5 font-mono font-bold text-[var(--warn)] text-xs whitespace-nowrap">${d.size_str}</td>
        <td class="py-2 px-1.5 whitespace-nowrap">
          <span class="px-2 py-0.5 rounded-[var(--r)] text-xs font-mono font-bold" style="${ageBadgeStyle}">
            ${d.age_days === 0 ? 'Today' : `${d.age_days}d`}
          </span>
        </td>
        <td class="py-2 px-1.5 text-right" onclick="event.stopPropagation()">
          <div class="flex items-center justify-end gap-1.5 whitespace-nowrap">
            <button onclick="revealFile('${escapeQuotes(d.path)}')" class="px-2 py-1 text-xs font-mono font-bold rounded-[var(--r)] desk-card-2 hover:bg-[var(--surface-3)] text-[var(--text)] transition" title="Show and highlight in Finder">
              Reveal
            </button>
            <button onclick="trashFile('${escapeQuotes(d.path)}', '${escapeQuotes(d.name)}')" class="p-1.5 rounded-[var(--r)] transition flex items-center justify-center shrink-0" style="background: var(--bad-bg); color: var(--bad); border: 1px solid var(--bad);" title="Move safely to macOS ~/.Trash">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
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
  const wrapper = document.getElementById('dumpsSelectionBarWrapper');
  const bar = document.getElementById('dumpsSelectionBar');
  const countNumber = document.getElementById('selectedCountNumber');
  const countText = document.getElementById('selectedCountText');
  const sizeText = document.getElementById('selectedSizeText');
  const selectAllBox = document.getElementById('dumpsSelectAllCheckbox');
  const revealBtn = document.getElementById('dumpsRevealBtn');
  const copyBtnText = document.getElementById('dumpsCopyBtnText');

  if (!wrapper || !bar) return;

  const selectedCount = state.selectedDumps.size;
  if (selectedCount > 0) {
    wrapper.classList.remove('max-h-0', 'opacity-0', 'pointer-events-none');
    wrapper.classList.add('max-h-40', 'opacity-100', 'pointer-events-auto');
    if (countNumber) countNumber.textContent = selectedCount;
    if (countText) countText.textContent = `${selectedCount} item${selectedCount > 1 ? 's' : ''} selected`;

    let totalBytes = 0;
    if (state.data && state.data.db_dumps) {
      state.data.db_dumps.dumps.forEach(d => {
        if (state.selectedDumps.has(d.path)) {
          totalBytes += d.size;
        }
      });
    }
    if (sizeText) sizeText.textContent = formatBytes(totalBytes);

    // "Reveal in Finder" is only appropriate for a single file; when multi, disappear
    if (revealBtn) {
      if (selectedCount === 1) {
        revealBtn.style.display = 'inline-flex';
      } else {
        revealBtn.style.display = 'none';
      }
    }
    if (copyBtnText) {
      copyBtnText.textContent = selectedCount > 1 ? 'Copy Paths' : 'Copy Path';
    }
  } else {
    wrapper.classList.add('max-h-0', 'opacity-0', 'pointer-events-none');
    wrapper.classList.remove('max-h-40', 'opacity-100', 'pointer-events-auto');
  }

  if (selectAllBox && filteredDumps && filteredDumps.length > 0) {
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
}

function copySelectedDumpPaths() {
  const paths = Array.from(state.selectedDumps).map(formatPath);
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

function renderGitStatusBadge(p, truncateSingle = false) {
  const git = p.git || {};
  if (!git.has_git) return truncateSingle ? `<div></div>` : '';

  if (git.clean) {
    return `
      <span class="px-2 py-0.5 rounded text-[10px] font-mono font-medium text-emerald-400 bg-emerald-950/60 border border-emerald-800/40 flex items-center gap-1 shrink-0" title="Working tree clean (no modified or untracked files)">
        <svg class="w-3 h-3 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
        </svg>
        <span>Clean</span>
      </span>
    `;
  }

  const clickTitle = `Click to inspect ${git.total_dirty || 0} uncommitted file(s)`;
  if (git.changed > 0 && git.untracked > 0) {
    return `
      <button type="button" data-git-changes-anchor="${escapeQuotes(p.name)}" onclick="openGitChangesPopover('${escapeQuotes(p.name)}', this, event)" class="flex flex-col gap-0.5 cursor-pointer shrink-0 text-left group/git hover:brightness-110 transition" title="${escapeQuotes(clickTitle)}">
        <span class="px-1.5 py-0.2 rounded text-[9px] font-mono font-semibold flex items-center gap-1 bg-amber-950/60 text-amber-400 border border-amber-800/40 group-hover/git:border-amber-500/70 leading-none">
          <span class="w-1 h-1 rounded-full bg-amber-400 shrink-0"></span>
          <span>${git.changed} changed</span>
        </span>
        <span class="px-1.5 py-0.2 rounded text-[9px] font-mono font-semibold flex items-center gap-1 bg-amber-950/40 text-amber-300 border border-amber-800/30 group-hover/git:border-amber-500/70 leading-none">
          <span class="w-1 h-1 rounded-full bg-amber-300 shrink-0"></span>
          <span>${git.untracked} untracked</span>
        </span>
      </button>
    `;
  }

  const singleLabel = git.changed > 0 ? `${git.changed} changed` : (git.untracked > 0 ? `${git.untracked} untracked` : `${git.total_dirty} dirty`);
  return `
    <button type="button" data-git-changes-anchor="${escapeQuotes(p.name)}" onclick="openGitChangesPopover('${escapeQuotes(p.name)}', this, event)" class="px-2 py-0.5 rounded text-[10px] font-mono font-medium flex items-center gap-1.5 shrink-0 cursor-pointer bg-amber-950/60 hover:bg-amber-950/80 text-amber-400 border border-amber-800/40 hover:border-amber-500/70 transition ${truncateSingle ? 'truncate max-w-full' : ''}" title="${escapeQuotes(clickTitle)}">
      <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0"></span>
      <span class="${truncateSingle ? 'truncate' : ''}">${singleLabel}</span>
    </button>
  `;
}

function renderGitPills(p) {
  if (!p.branch && !p.git) return '';
  const git = p.git || {};
  const branchName = p.branch || git.branch || 'git';

  const branchBadge = `
    <span class="px-2 py-0.5 rounded text-[11px] font-mono font-medium text-zinc-300 bg-[var(--surface-3)] border border-[var(--line)] flex items-center gap-1 shrink-0" title="Git Branch: ${branchName}">
      <svg class="w-3 h-3 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h10M7 7a3 3 0 100-6 3 3 0 000 6zm0 0v10m10-10a3 3 0 100-6 3 3 0 000 6zm0 0v2a4 4 0 01-4 4H7" />
      </svg>
      <span class="truncate max-w-[130px] sm:max-w-[180px]">${branchName}</span>
    </span>
  `;

  if (!git.has_git) {
    return branchBadge;
  }

  return branchBadge + renderGitStatusBadge(p, false);
}

function renderDdevSection() {
  if (!state.data) return;
  const d = state.data;
  
  const allProjects = Object.values(d.projects || {});
  const runningProjects = allProjects.filter(p => p.is_running);
  const stoppedProjectsAll = allProjects.filter(p => !p.is_running);

  runningProjects.forEach(p => {
    if (state.startingProjects[p.name]) delete state.startingProjects[p.name];
  });

  const rCountEl = document.getElementById('ddevRunningCount');
  if (rCountEl) rCountEl.textContent = runningProjects.length;
  const sCountEl = document.getElementById('ddevStoppedCount');
  if (sCountEl) sCountEl.textContent = stoppedProjectsAll.length;
  const drawerCountEl = document.getElementById('appDrawerBadgeCount');
  if (drawerCountEl) drawerCountEl.textContent = `${stoppedProjectsAll.length}`;

  // If App Drawer is currently open, refresh its grid
  const drawerModal = document.getElementById('appDrawerModal');
  if (drawerModal && !drawerModal.classList.contains('hidden')) {
    renderAppDrawerGrid();
  }

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
      rList.innerHTML = `<div class="text-xs text-[var(--muted)] py-6 col-span-2 text-center rounded-[var(--r)] bg-[var(--surface-2)] border border-[var(--line)]">No active DDEV projects running. Click "Start Everything" on any project below to spin it up.</div>`;
    } else {
      rList.innerHTML = runningProjects.map(p => {
        const search = p.search || {};
        let searchPill = '';
        let turnOnSearchBtn = '';

        if (search.configured) {
          if (search.is_running) {
            searchPill = `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-950/60 text-emerald-400 border border-emerald-800/40" title="Search container is running">
              ● ${capitalize(search.type)} Active
            </span>`;
          } else if (search.profile) {
            searchPill = `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-amber-950/60 text-amber-400 border border-amber-800/40" title="Search container not running (requires --profiles=${search.profile})">
              ○ Search Off (${search.profile})
            </span>`;
            turnOnSearchBtn = `<button onclick="triggerTurnOnSearch('${p.name}', '${search.profile || ''}', '${search.type || ''}', this)" class="px-2.5 py-1.5 text-xs font-medium rounded-[var(--r)] text-white bg-amber-600 hover:bg-amber-500 shadow-sm transition active:scale-95 flex items-center gap-1.5" title="Start ${search.type} search service (${search.profile})">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
              <span>+ Search</span>
            </button>`;
          } else {
            searchPill = `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-950/60 text-emerald-400 border border-emerald-800/40">
              ● ${capitalize(search.type)} Running
            </span>`;
          }
        }

        const dist = p.dist || {};
        let distPill = '';
        let buildDistBtn = '';
        if (dist.configured) {
          if (dist.is_built) {
            distPill = `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-medium text-emerald-400 bg-emerald-950/60 border border-emerald-800/40" title="Frontend dist assets built and ready">
              ● Dist
            </span>`;
          } else {
            distPill = `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-medium text-amber-400 bg-amber-950/60 border border-amber-800/40" title="Frontend dist missing (${dist.missing_themes?.join(', ') || 'unbuilt'})">
              ○ Dist
            </span>`;
            buildDistBtn = `<button onclick="triggerBuildDist('${p.name}', this)" class="px-2.5 py-1.5 text-xs font-medium rounded-[var(--r)] bg-[var(--surface-3)] hover:bg-zinc-700 text-amber-300 border border-amber-700/50 transition" title="Build frontend dist (${dist.build_cmd || 'build'})">
              Build Dist
            </button>`;
          }
        }

        const gitPills = renderGitPills(p);
        const phpTag = p.php_version ? `<span class="text-[11px] font-mono text-[var(--muted)] px-1.5 py-0.5 rounded bg-[var(--surface-3)] border border-[var(--line)]">PHP ${p.php_version}</span>` : '';

        return `
          <div class="p-4 rounded-[var(--r)] bg-[var(--surface-2)] border border-[var(--line)] hover:border-indigo-500/50 transition flex flex-col justify-between gap-3">
            <div>
              <div class="flex items-center justify-between gap-2 flex-wrap">
                <div class="flex items-center gap-2">
                  <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
                  <span class="text-sm font-semibold text-white tracking-wide">${p.name}</span>
                </div>
                <div class="flex items-center gap-1.5 flex-wrap">
                  ${gitPills}
                  ${searchPill}
                  ${distPill}
                </div>
              </div>

              <div class="flex items-center gap-2 mt-2 text-xs text-[var(--muted)] font-mono flex-wrap">
                ${phpTag}
                <span class="truncate text-[11px] text-[var(--faint)]" title="${escapeQuotes(formatPath(p.approot))}">${formatPath(p.approot)}</span>
              </div>

              <!-- Interactive Port Visualizer & Direct Links (Docker Desktop Parity) -->
              <div class="flex items-center gap-2 mt-2 pt-2 border-t border-[var(--line)] flex-wrap">
                <a href="${p.http_url}" target="_blank" rel="noopener noreferrer" class="px-2 py-0.5 rounded text-[11px] font-mono font-medium text-indigo-400 bg-indigo-950/40 border border-indigo-800/40 hover:underline flex items-center gap-1" title="Open primary web URL (${p.http_url})">
                  <span>Web: ${p.primary_domain || (p.http_url ? p.http_url.replace('https://', '').replace('http://', '') : p.name + '.ddev.site')}</span>
                  <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
                <a href="https://${p.name}.ddev.site:8026" target="_blank" rel="noopener noreferrer" class="px-2 py-0.5 rounded text-[11px] font-mono font-medium text-purple-400 bg-purple-950/40 border border-purple-800/40 hover:underline flex items-center gap-1" title="Open Mailpit Webmail (Port 8026 / 8025)">
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
                  <span>Mailpit :8026</span>
                </a>
              </div>
            </div>

            <!-- Action Toolbar & Dedicated Open Button -->
            <div class="flex items-start justify-between gap-3 pt-2.5 border-t border-[var(--line)]">
              <!-- Left Column: sized to fit the tools row -->
              <div class="inline-flex flex-col gap-2 w-fit">
                <div class="flex items-center gap-2">
                  <!-- 1-Click iTerm Launchers -->
                  <button onclick="launchTerminal('', '${escapeQuotes(p.approot)}')" class="px-2.5 py-1.5 text-xs font-mono font-medium rounded-[var(--r)] bg-[var(--surface)] hover:bg-[var(--surface-3)] text-zinc-200 border border-[var(--line)] transition flex items-center gap-1" title="1-Click Open iTerm in ${escapeQuotes(p.approot)}">
                    <svg class="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                    <span>iTerm</span>
                  </button>
                  <button onclick="openDatabase('${p.name}', '${escapeQuotes(p.approot)}')" class="px-2.5 py-1.5 text-xs font-mono font-medium rounded-[var(--r)] bg-[var(--surface)] hover:bg-[var(--surface-3)] text-amber-300 border border-[var(--line)] transition flex items-center gap-1" title="Open project database in Sequel Ace">
                    <svg class="w-3.5 h-3.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/></svg>
                    <span>Database</span>
                  </button>
                  <!-- Live Logs Viewer Modal Launcher -->
                  <button onclick="openLogsModal('${p.name}', 'web', false)" class="px-2.5 py-1.5 text-xs font-medium rounded-[var(--r)] bg-[var(--surface)] hover:bg-[var(--surface-3)] text-indigo-400 border border-[var(--line)] transition flex items-center gap-1" title="Open Live Logs Viewer">
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span>Logs</span>
                  </button>
                  ${p.git?.has_git ? `<button onclick="triggerGitFetch('${p.name}', this)" class="px-2.5 py-1.5 text-xs font-medium rounded-[var(--r)] bg-[var(--surface)] hover:bg-[var(--surface-3)] text-sky-300 border border-[var(--line)] transition flex items-center gap-1 whitespace-nowrap" title="Git Fetch (git fetch --all --prune)">
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    <span>Fetch</span>
                  </button>` : ''}
                  ${turnOnSearchBtn}
                  ${buildDistBtn}
                </div>

                <!-- Dedicated Button: Matches exact length of tools above, with prominent extra padding & fixed logo -->
                <a href="${p.http_url}" target="_blank" rel="noopener noreferrer" class="btn-tactile w-full py-2.5 px-4 text-xs font-bold rounded-[var(--r)] text-white bg-indigo-600 hover:bg-indigo-500 transition flex items-center justify-center gap-2 shadow-sm min-w-[140px]" title="Open ${escapeQuotes(p.name)} in browser">
                  <span>Open</span>
                  <svg class="w-4 h-4 text-white shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              </div>

              <!-- Right Column: Lifecycle controls with icons -->
              <div class="flex items-center gap-1.5 shrink-0 pt-0.5">
                <button onclick="promptActionExec('ddev_restart_project', 'Restart Project: ${p.name}', 'ddev restart ${p.name}', 'Restarts running containers for project ${p.name}.', '${p.name}')" class="px-2.5 py-1.5 text-xs font-medium rounded-[var(--r)] bg-[var(--surface)] hover:bg-[var(--surface-3)] text-zinc-300 hover:text-white border border-[var(--line)] transition flex items-center gap-1.5" title="Restart Project">
                  <svg class="w-3.5 h-3.5 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>Restart</span>
                </button>
                <button onclick="promptActionExec('ddev_stop_project', 'Stop Project: ${p.name}', 'ddev stop ${p.name}', 'Stops running containers for project ${p.name} to free RAM and Mutagen caches.', '${p.name}')" class="px-2.5 py-1.5 text-xs font-medium rounded-[var(--r)] text-rose-400 hover:bg-rose-950/40 border border-rose-800/40 transition flex items-center gap-1.5" title="Stop Project">
                  <svg class="w-3.5 h-3.5 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" stroke-width="2.2" />
                  </svg>
                  <span>Stop</span>
                </button>
                <button onclick="revealFile('${escapeQuotes(p.approot)}')" class="p-1.5 rounded-[var(--r)] bg-[var(--surface)] hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-white border border-[var(--line)] transition flex items-center justify-center" title="Reveal folder in Finder">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                </button>
                <button onclick="copyToClipboard('${escapeQuotes(formatPath(p.approot))}', 'Copied project directory path!')" class="p-1.5 rounded-[var(--r)] bg-[var(--surface)] hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-white border border-[var(--line)] transition flex items-center justify-center" title="Copy project path">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <rect x="9" y="9" width="11" height="11" rx="2" stroke-width="2" />
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                  </svg>
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
        const dist = p.dist || {};
        const git = p.git || {};
        const branchName = p.branch || git.branch || '';

        // Column 1: Project Name & Stopped status badge
        const colProject = `
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-sm text-white font-bold truncate" title="${p.name}">${p.name}</span>
            <span class="px-1.5 py-0.5 rounded text-[10px] font-mono text-[var(--muted)] bg-[var(--bg)] border border-[var(--line)] shrink-0">Stopped</span>
          </div>
        `;

        // Column 2: Git Branch (searchable switcher if working tree is clean)
        let colBranch = `<div></div>`;
        if (branchName) {
          if (git.has_git && git.clean) {
            colBranch = `
              <button data-branch-anchor="${escapeQuotes(p.name)}" onclick="openBranchSelector('${p.name}', this, event)" class="px-2 py-0.5 rounded text-[11px] font-mono font-medium text-zinc-200 bg-[var(--surface-3)] hover:bg-indigo-950/60 border border-[var(--line)] hover:border-indigo-500/70 flex items-center gap-1 max-w-full transition cursor-pointer" title="Switch Git branch (${escapeQuotes(branchName)} — working tree clean)">
                <svg class="w-3 h-3 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h10M7 7a3 3 0 100-6 3 3 0 000 6zm0 0v10m10-10a3 3 0 100-6 3 3 0 000 6zm0 0v2a4 4 0 01-4 4H7" />
                </svg>
                <span class="truncate">${escapeHtml(branchName)}</span>
                <svg class="w-2.5 h-2.5 text-[var(--muted)] shrink-0 ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            `;
          } else {
            const dirtyLockMsg = git.has_git && !git.clean
              ? `Branch: ${branchName} (Commit or stash ${git.total_dirty || 'uncommitted'} change(s) to switch branches)`
              : `Git Branch: ${branchName}`;
            colBranch = `
              <span class="px-2 py-0.5 rounded text-[11px] font-mono font-medium text-zinc-300 bg-[var(--surface-3)] border border-[var(--line)] flex items-center gap-1 max-w-full" title="${escapeQuotes(dirtyLockMsg)}">
                <svg class="w-3 h-3 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h10M7 7a3 3 0 100-6 3 3 0 000 6zm0 0v10m10-10a3 3 0 100-6 3 3 0 000 6zm0 0v2a4 4 0 01-4 4H7" />
                </svg>
                <span class="truncate">${escapeHtml(branchName)}</span>
              </span>
            `;
          }
        }

        // Column 3: Git Status (Clean, Untracked, Changed — clickable to inspect files)
        const colGit = renderGitStatusBadge(p, true);

        // Column 4: Search Service
        let colSearch = `<div></div>`;
        if (search.configured) {
          if (search.profile) {
            colSearch = `
              <span class="px-2 py-0.5 rounded text-[10px] font-mono font-medium text-indigo-300 bg-indigo-950/60 border border-indigo-800/40 truncate block" title="Requires --profiles=${search.profile}">
                ${capitalize(search.type)} (${search.profile})
              </span>
            `;
          } else {
            colSearch = `
              <span class="px-2 py-0.5 rounded text-[10px] font-mono font-medium text-[var(--muted)] bg-[var(--surface-3)] border border-[var(--line)] truncate block">
                ${capitalize(search.type)}
              </span>
            `;
          }
        }

        // Column 5: Dist Assets
        let colDist = `<div></div>`;
        if (dist.configured) {
          if (dist.is_built) {
            colDist = `
              <span class="px-2 py-0.5 rounded text-[10px] font-mono font-medium text-emerald-400 bg-emerald-950/60 border border-emerald-800/40 truncate block" title="Frontend dist assets built and ready">
                ● Dist
              </span>
            `;
          } else {
            colDist = `
              <span class="px-2 py-0.5 rounded text-[10px] font-mono font-medium text-amber-400 bg-amber-950/60 border border-amber-800/40 truncate block" title="Dist missing (${dist.missing_themes?.join(', ') || 'unbuilt'})">
                ○ Dist
              </span>
            `;
          }
        }

        // Column 6: Database Dumps
        let colDumps = `<div></div>`;
        if (p.dumps_size > 0) {
          colDumps = `
            <span class="text-[10px] font-mono text-amber-400 font-semibold truncate block" title="${p.dumps_size_str} database dumps">
              ${p.dumps_size_str} dumps
            </span>
          `;
        }

        const busyMode = state.startingProjects[p.name] || '';

        // Right Group: Button 3 (Secondary action slot: + Search or Build Dist or spacer)
        let colSecondaryBtn = `<div class="w-[98px] shrink-0"></div>`;
        if (search.configured && search.profile) {
          const isSearchBusy = busyMode === 'search';
          colSecondaryBtn = `
            <button ${isSearchBusy ? 'disabled' : ''} onclick="triggerTurnOnSearch('${p.name}', '${search.profile || ''}', '${search.type || ''}', this)" class="w-[98px] px-2 py-1.5 text-xs font-medium rounded-[var(--r)] text-white bg-amber-600 hover:bg-amber-500 shadow-sm transition active:scale-95 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${isSearchBusy ? 'opacity-90 cursor-wait' : ''}" title="Start project with search profile (${search.profile})">
              ${isSearchBusy ? renderInlineButtonSpinner('Starting...') : '<span>+ Search</span>'}
            </button>
          `;
        } else if (dist.configured && !dist.is_built) {
          const isBuildBusy = busyMode === 'build_dist';
          colSecondaryBtn = `
            <button ${isBuildBusy ? 'disabled' : ''} onclick="triggerBuildDist('${p.name}', this)" class="w-[98px] px-2 py-1.5 text-xs font-medium rounded-[var(--r)] bg-[var(--surface-3)] hover:bg-zinc-700 text-amber-300 border border-amber-700/50 transition flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${isBuildBusy ? 'opacity-90 cursor-wait' : ''}" title="Build frontend dist (${dist.build_cmd || 'build'})">
              ${isBuildBusy ? renderInlineButtonSpinner('Building...') : '<span>Build Dist</span>'}
            </button>
          `;
        }

        const isSetupBusy = busyMode === 'setup';
        const ageTag = p.last_modified_str || 'Stopped';
        const phpTag = p.php_version ? `PHP ${p.php_version}` : '';

        return `
          <div class="group ${busyMode ? 'is-starting' : ''} p-3.5 rounded-[var(--r)] bg-[var(--surface-2)] border border-[var(--line)] hover:border-zinc-700 transition flex items-center justify-between gap-4">
            <!-- Left Side: Tabular Metadata Grid + Aligned Sub-info -->
            <div class="min-w-0 pr-2">
              <div class="grid items-center gap-3" style="grid-template-columns: 140px 145px 110px 140px 90px 95px;">
                <div class="min-w-0 flex items-center">${colProject}</div>
                <div class="min-w-0 flex items-center">${colBranch}</div>
                <div class="min-w-0 flex items-center">${colGit}</div>
                <div class="min-w-0 flex items-center">${colSearch}</div>
                <div class="min-w-0 flex items-center">${colDist}</div>
                <div class="min-w-0 flex items-center">${colDumps}</div>
              </div>
              <div class="flex items-center gap-3 mt-1.5 text-xs font-mono">
                <span class="w-[55px] shrink-0 text-[11px] text-[var(--muted)]">${ageTag}</span>
                <span class="w-[55px] shrink-0 text-[10px] text-[var(--faint)]">${phpTag}</span>
                <span class="truncate text-[var(--faint)] text-[11px]" title="${escapeQuotes(formatPath(p.approot))}">${formatPath(p.approot)}</span>
              </div>
            </div>

            <!-- Right Side: Pixel-Aligned Action Buttons Grid (412px constant width) -->
            <div class="flex items-center gap-2 shrink-0">
              <div class="row-action-cluster flex items-center gap-2">
                <button ${isSetupBusy ? 'disabled' : ''} onclick="triggerStartEverything('${p.name}', '${search.profile || ''}', this)" class="w-[120px] px-2 py-1.5 text-xs font-semibold rounded-[var(--r)] text-white bg-emerald-600 hover:bg-emerald-500 shadow-sm transition active:scale-95 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${isSetupBusy ? 'opacity-90 cursor-wait' : ''}" title="Full Setup: Starts containers + runs dset (composer install, dev/build, vendor-expose) + builds dist">
                  ${isSetupBusy ? renderInlineButtonSpinner('Setting up...') : `<svg class="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg><span>Start All</span>`}
                </button>
                <button onclick="promptActionExec('ddev_start_project', 'Start Project: ${p.name}', 'ddev start ${p.name}', 'Starts project web and database containers for ${p.name}.', '${p.name}')" class="w-[58px] px-2 py-1.5 text-xs font-medium rounded-[var(--r)] bg-[var(--surface)] hover:bg-[var(--surface-3)] text-zinc-200 border border-[var(--line)] transition flex items-center justify-center whitespace-nowrap shrink-0" title="Start containers only (fast)">
                  Start
                </button>
                ${colSecondaryBtn}
              </div>
              ${git.has_git ? `
              <button onclick="triggerGitFetch('${p.name}', this)" class="w-[32px] h-[32px] p-0 flex items-center justify-center rounded-[var(--r)] bg-[var(--surface)] hover:bg-[var(--surface-3)] text-sky-300 hover:text-white border border-[var(--line)] transition shrink-0" title="Git Fetch (git fetch --all --prune)">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>` : `<div class="w-[32px] h-[32px] shrink-0"></div>`}
              <button onclick="revealFile('${escapeQuotes(p.approot)}')" class="w-[32px] h-[32px] p-0 flex items-center justify-center rounded-[var(--r)] bg-[var(--surface)] hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-white border border-[var(--line)] transition shrink-0" title="Reveal in Finder">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
              </button>
              <button onclick="copyToClipboard('${escapeQuotes(formatPath(p.approot))}', 'Copied project directory path!')" class="w-[32px] h-[32px] p-0 flex items-center justify-center rounded-[var(--r)] bg-[var(--surface)] hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-white border border-[var(--line)] transition shrink-0" title="Copy project path">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <rect x="9" y="9" width="11" height="11" rx="2" stroke-width="2" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // Re-bind open popovers if the project list just re-rendered beneath them
  const branchPopover = document.getElementById('branchSelectorPopover');
  if (branchPopover && !branchPopover.classList.contains('hidden') && activeBranchPopover.project) {
    const freshAnchor = document.querySelector(`[data-branch-anchor="${CSS.escape(activeBranchPopover.project)}"]`);
    if (freshAnchor) {
      activeBranchPopover.anchorEl = freshAnchor;
      positionAnchoredPopover(freshAnchor, branchPopover, 320);
    }
  }

  const gitChangesPop = document.getElementById('gitChangesPopover');
  if (gitChangesPop && !gitChangesPop.classList.contains('hidden') && activeGitChangesPopover.project) {
    const freshGitAnchor = document.querySelector(`[data-git-changes-anchor="${CSS.escape(activeGitChangesPopover.project)}"]`);
    if (freshGitAnchor) {
      activeGitChangesPopover.anchorEl = freshGitAnchor;
      positionAnchoredPopover(freshGitAnchor, gitChangesPop, 384);
    }
  }
}

// -------------------------------------------------------------
// TAB 4: DOCKER & COLIMA SECTION
// -------------------------------------------------------------

function getContainerTypeBadge(c) {
  const name = (c.name || '').toLowerCase();
  const image = (c.image || '').toLowerCase();

  if (name.includes('-db') || image.includes('dbserver') || image.includes('mariadb') || image.includes('mysql') || image.includes('postgres')) {
    let sub = 'MySQL/MariaDB';
    if (image.includes('mariadb') || name.includes('mariadb')) sub = 'MariaDB';
    else if (image.includes('mysql')) sub = 'MySQL';
    else if (image.includes('postgres')) sub = 'Postgres';
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950/80 text-amber-300 border border-amber-600/50" title="Database Service: ${sub}">
      <svg class="w-3 h-3 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/></svg>
      <span>${sub}</span>
    </span>`;
  }
  if (name.includes('-web') || image.includes('webserver') || image.includes('php') || image.includes('nginx') || image.includes('apache')) {
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-blue-950/80 text-blue-300 border border-blue-600/50" title="Web App & PHP Engine">
      <svg class="w-3 h-3 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg>
      <span>Web (PHP)</span>
    </span>`;
  }
  if (name.includes('solr') || image.includes('solr')) {
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-orange-950/80 text-orange-300 border border-orange-600/50" title="Solr Search Index">
      <span class="w-1.5 h-1.5 rounded-full bg-orange-400"></span>
      <span>Solr Search</span>
    </span>`;
  }
  if (name.includes('elastic') || image.includes('elastic')) {
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-teal-950/80 text-teal-300 border border-teal-600/50" title="Elasticsearch Index">
      <span class="w-1.5 h-1.5 rounded-full bg-teal-400"></span>
      <span>Elasticsearch</span>
    </span>`;
  }
  if (name.includes('redis') || image.includes('redis')) {
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-950/80 text-rose-300 border border-rose-600/50" title="Redis Cache Engine">
      <span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
      <span>Redis Cache</span>
    </span>`;
  }
  if (name.includes('router') || image.includes('traefik')) {
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-purple-950/80 text-purple-300 border border-purple-600/50" title="Traefik Global Edge Router">
      <svg class="w-3 h-3 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
      <span>Traefik Router</span>
    </span>`;
  }
  if (name.includes('ssh-agent') || image.includes('ssh-agent')) {
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-zinc-800 text-zinc-200 border border-zinc-600" title="SSH Key Authentication Agent">
      <svg class="w-3 h-3 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg>
      <span>SSH Agent</span>
    </span>`;
  }
  if (name.includes('mailpit') || image.includes('mailpit')) {
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-fuchsia-950/80 text-fuchsia-300 border border-fuchsia-600/50" title="Mailpit Local Mail Testing">
      <span>Mailpit</span>
    </span>`;
  }
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-zinc-800 text-zinc-300 border border-zinc-700">Sidecar</span>`;
}

function renderDockerSection() {
  if (!state.data) return;
  const d = state.data;
  const docker = d.docker || {};

  // 1. Containers
  const cList = document.getElementById('dockerContainersList');
  const cCount = document.getElementById('dockerContainersCount');
  const containers = docker.containers_detail || [];
  if (cCount) cCount.textContent = containers.length || (docker.running_containers ? docker.running_containers.length : 0);

  if (cList) {
    if (containers.length === 0) {
      if (docker.running_containers && docker.running_containers.length > 0) {
        cList.innerHTML = docker.running_containers.map(cName => {
          const typeBadge = getContainerTypeBadge({ name: cName, image: '' });
          return `
          <div class="p-3 rounded-[var(--r)] bg-[var(--surface-2)] border border-[var(--line)] flex items-center justify-between text-xs">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span class="font-mono text-zinc-100 font-semibold">${cName}</span>
              ${typeBadge}
            </div>
            <div class="flex items-center gap-1.5">
              <button onclick="launchTerminal('docker exec -it ${cName} /bin/sh')" class="px-2 py-1 text-xs font-mono font-medium rounded bg-[var(--surface)] hover:bg-[var(--surface-3)] text-zinc-300 border border-[var(--line)] transition flex items-center gap-1">
                <span>Shell</span>
              </button>
              <button onclick="openLogsModal('${cName}', 'web', true)" class="px-2.5 py-1 text-xs font-medium rounded bg-[var(--surface)] hover:bg-[var(--surface-3)] text-indigo-400 border border-[var(--line)] transition">
                Logs
              </button>
            </div>
          </div>
        `;
        }).join('');
      } else {
        cList.innerHTML = `<div class="text-xs text-[var(--muted)] font-mono py-6 text-center">No running Docker containers found.</div>`;
      }
    } else {
      cList.innerHTML = containers.map(c => {
        const portChips = formatPortChips(c.ports);
        const typeBadge = getContainerTypeBadge(c);
        return `
        <div class="p-3 rounded-[var(--r)] bg-[var(--surface-2)] border border-[var(--line)] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="w-2 h-2 rounded-full bg-emerald-400 shrink-0"></span>
              <span class="font-mono text-zinc-100 font-semibold truncate" title="${c.name}">${c.name}</span>
              ${typeBadge}
              <span class="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--surface)] text-[var(--muted)] border border-[var(--line)]">${c.status}</span>
            </div>
            <div class="flex items-center gap-2 mt-1 text-[11px] text-[var(--muted)] font-mono truncate">
              <span class="text-[var(--faint)] truncate max-w-xs" title="${c.image}">${c.image}</span>
            </div>
            ${portChips ? `<div class="mt-2 flex items-center gap-1.5 flex-wrap">${portChips}</div>` : ''}
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button onclick="launchTerminal('docker exec -it ${c.name} /bin/sh')" class="px-2 py-1 text-xs font-mono font-medium rounded bg-[var(--surface)] hover:bg-[var(--surface-3)] text-zinc-300 border border-[var(--line)] transition flex items-center gap-1" title="1-Click Launch Terminal inside container">
              <svg class="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
              <span>Shell</span>
            </button>
            <button onclick="openLogsModal('${c.name}', 'web', true)" class="px-2.5 py-1 text-xs font-medium rounded bg-[var(--surface)] hover:bg-[var(--surface-3)] text-indigo-400 border border-[var(--line)] transition flex items-center gap-1" title="View live container logs">
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              <span>Logs</span>
            </button>
          </div>
        </div>
      `;
      }).join('');
    }
  }

  // 2. Volumes
  renderDockerVolumes();

  // 3. Docker Images Manager
  renderDockerImages();
}

// -------------------------------------------------------------
// DOCKER VOLUMES MANAGER (Search, Filter, Individual Delete)
// -------------------------------------------------------------

let dockerVolumeFilter = 'all'; // 'all', 'orphaned', 'db', 'mutagen'

function setVolumeFilter(filter) {
  dockerVolumeFilter = filter;
  ['all', 'orphaned', 'db', 'mutagen'].forEach(f => {
    const btn = document.getElementById(`volFilter-${f}`);
    if (btn) {
      if (f === filter) {
        btn.className = 'px-2 py-1 rounded-[var(--r)] bg-indigo-600 text-white font-bold transition text-[10px]';
      } else {
        const textCol = f === 'orphaned' ? 'text-amber-400' : f === 'db' ? 'text-emerald-400' : f === 'mutagen' ? 'text-indigo-300' : 'text-zinc-300';
        btn.className = `px-2 py-1 rounded-[var(--r)] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] ${textCol} border border-[var(--line)] transition text-[10px]`;
      }
    }
  });
  renderDockerVolumes();
}

function handleVolumeFilterChange() {
  renderDockerVolumes();
}

function renderDockerVolumes() {
  if (!state.data || !state.data.docker) return;
  const volumes = state.data.docker.volumes || [];
  const vList = document.getElementById('ddevVolumesList');
  const vCount = document.getElementById('ddevVolumesCount');
  if (vCount) vCount.textContent = volumes.length;

  if (!vList) return;

  const searchInput = document.getElementById('volumeSearchInput');
  const search = (searchInput ? searchInput.value : '').trim().toLowerCase();

  let filtered = volumes.filter(v => {
    if (dockerVolumeFilter === 'orphaned' && !v.is_orphaned) return false;
    if (dockerVolumeFilter === 'db' && !(v.type && v.type.includes('Database'))) return false;
    if (dockerVolumeFilter === 'mutagen' && !(v.type && v.type.includes('Mutagen'))) return false;

    if (search) {
      const matchName = v.name && v.name.toLowerCase().includes(search);
      const matchProj = v.project && v.project.toLowerCase().includes(search);
      const matchType = v.type && v.type.toLowerCase().includes(search);
      if (!matchName && !matchProj && !matchType) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    vList.innerHTML = `<div class="text-xs text-[var(--muted)] font-mono py-8 text-center">No volumes matching filter.</div>`;
    return;
  }

  vList.innerHTML = filtered.map(v => {
    const isDb = v.type && v.type.includes('Database');
    const isMutagen = v.type && v.type.includes('Mutagen');
    let badgeClass = 'bg-zinc-800 text-zinc-300 border border-[var(--line)]';
    let badgeLabel = v.type || 'Volume';
    let tooltipText = 'Docker system volume or dangling cache layer';

    if (isDb) {
      badgeClass = 'bg-emerald-950/80 text-emerald-300 border border-emerald-600/50 font-bold';
      badgeLabel = 'Database (Preserved)';
      tooltipText = 'Contains MySQL/MariaDB database tables. Protected and preserved across ddev stop/start.';
    } else if (isMutagen) {
      badgeClass = 'bg-indigo-950/80 text-indigo-300 border border-indigo-600/50 font-bold';
      badgeLabel = 'Mutagen Cache';
      tooltipText = 'High-speed macOS-Linux two-way filesystem sync cache. Rebuilt automatically if recreated.';
    } else if (v.is_orphaned) {
      badgeClass = 'bg-amber-950/80 text-amber-300 border border-amber-600/50 font-bold';
      badgeLabel = 'Orphaned';
      tooltipText = 'Volume does not belong to any currently recognized project.';
    }

    return `
      <div class="p-2.5 rounded-[var(--r)] bg-[var(--surface-2)] border border-[var(--line)] hover:border-zinc-700 transition flex items-center justify-between gap-3 text-xs">
        <div class="min-w-0 flex-1">
          <div class="truncate font-mono text-zinc-200 font-medium" title="${escapeQuotes(v.name)}">
            ${v.name}
          </div>
          ${v.project ? `<div class="text-[10px] font-mono text-[var(--muted)] mt-0.5 truncate">project: <span class="text-zinc-300">${v.project}</span></div>` : ''}
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="text-[10px] font-mono px-2 py-0.5 rounded cursor-help ${badgeClass}" title="${tooltipText}">
            ${badgeLabel}
          </span>
          <button onclick="deleteDockerVolume('${escapeQuotes(v.name)}')" class="p-1.5 rounded bg-[var(--surface)] hover:bg-rose-950/40 text-[var(--muted)] hover:text-rose-400 border border-[var(--line)] hover:border-rose-800/40 transition flex items-center justify-center shrink-0" title="Delete volume ${escapeQuotes(v.name)}">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function deleteDockerVolume(volName) {
  if (!volName) return;
  const volumes = state.data?.docker?.volumes || [];
  const v = volumes.find(item => item.name === volName) || { name: volName, type: 'Volume' };
  const isDb = v.type && v.type.includes('Database');
  const isMutagen = v.type && v.type.includes('Mutagen');

  let desc = `Removes volume "${v.name}" to free Colima disk space. If actively used by a container, Docker will safely prevent removal.`;
  if (isDb) {
    desc = `⚠️ DANGER: Volume "${v.name}" contains persistent database tables${v.project ? ` for project "${v.project}"` : ''}. Deleting it will permanently erase project data unless you have a database dump or snapshot!`;
  } else if (isMutagen) {
    desc = `Removes Mutagen filesystem sync cache for "${v.project || v.name}". Safe to delete; Mutagen will automatically recreate it next time the project starts.`;
  } else if (v.is_orphaned) {
    desc = `Removes orphaned volume "${v.name}" to reclaim disk space.`;
  }

  promptActionExec(
    'docker_volume_rm',
    `Delete Volume: ${v.name}`,
    `docker volume rm ${v.name}`,
    desc,
    v.name
  );
}

// -------------------------------------------------------------
// DOCKER IMAGES MANAGER (Docker Desktop Parity)
// -------------------------------------------------------------

let dockerImageFilter = 'all'; // 'all', 'dangling', 'ddev'

function setDockerImageFilter(filter) {
  dockerImageFilter = filter;
  ['all', 'dangling', 'ddev'].forEach(f => {
    const btn = document.getElementById(`imgFilter-${f}`);
    if (btn) {
      if (f === filter) {
        btn.className = 'px-2.5 py-1 rounded-[var(--r)] text-xs font-mono font-medium text-white bg-indigo-600 transition';
      } else {
        btn.className = 'px-2.5 py-1 rounded-[var(--r)] text-xs font-mono font-medium text-[var(--muted)] hover:text-white bg-[var(--bg)] border border-[var(--line)] transition';
      }
    }
  });
  renderDockerImages();
}

function getImageProject(img) {
  if (img.project) return img.project;
  const tag = img.tag || '';
  if (tag.includes('-built')) {
    const withoutBuilt = tag.split('-built')[0];
    const firstDash = withoutBuilt.indexOf('-');
    if (firstDash !== -1) {
      return withoutBuilt.slice(firstDash + 1);
    }
  }
  return null;
}

function toggleDockerImagesSort(column) {
  if (state.dockerImagesSortBy === column) {
    state.dockerImagesSortOrder = state.dockerImagesSortOrder === 'asc' ? 'desc' : 'asc';
  } else {
    state.dockerImagesSortBy = column;
    state.dockerImagesSortOrder = (column === 'size') ? 'desc' : 'asc';
  }
  updateDockerImagesSortIndicators();
  renderDockerImages();
}

function updateDockerImagesSortIndicators() {
  ['repository', 'project', 'tag', 'size', 'type'].forEach(col => {
    const el = document.getElementById(`sortIndicator-img-${col}`);
    if (!el) return;
    if (state.dockerImagesSortBy === col) {
      el.textContent = state.dockerImagesSortOrder === 'asc' ? '▲' : '▼';
    } else {
      el.textContent = '';
    }
  });
}

function renderDockerImages() {
  if (!state.data || !state.data.docker) return;
  const images = state.data.docker.images || [];
  const tbody = document.getElementById('dockerImagesTableBody');
  const countSpan = document.getElementById('dockerImagesCount');
  const danglingBadge = document.getElementById('dockerDanglingBadge');
  const searchInput = document.getElementById('dockerImagesSearch');
  const search = (searchInput ? searchInput.value : '').trim().toLowerCase();

  const danglingCount = images.filter(img => img.is_dangling).length;
  if (countSpan) countSpan.textContent = images.length;
  if (danglingBadge) {
    if (danglingCount > 0) {
      danglingBadge.textContent = `${danglingCount} Dangling`;
      danglingBadge.classList.remove('hidden');
    } else {
      danglingBadge.classList.add('hidden');
    }
  }

  updateDockerImagesSortIndicators();

  if (!tbody) return;
  if (images.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-[var(--muted)]">No Docker images found.</td></tr>`;
    return;
  }

  let filtered = images.filter(img => {
    if (dockerImageFilter === 'dangling' && !img.is_dangling) return false;
    if (dockerImageFilter === 'ddev' && !img.is_ddev_custom) return false;
    if (search) {
      const proj = (getImageProject(img) || '').toLowerCase();
      const match = (img.repository || '').toLowerCase().includes(search) ||
                    (img.tag || '').toLowerCase().includes(search) ||
                    (img.id || '').toLowerCase().includes(search) ||
                    proj.includes(search);
      if (!match) return false;
    }
    return true;
  });

  // Sort images by state.dockerImagesSortBy ('size', 'project', 'type', 'repository', 'tag')
  filtered.sort((a, b) => {
    let comparison = 0;
    if (state.dockerImagesSortBy === 'size') {
      const aBytes = a.size_bytes !== undefined ? a.size_bytes : parseSizeToBytes(a.size_str);
      const bBytes = b.size_bytes !== undefined ? b.size_bytes : parseSizeToBytes(b.size_str);
      comparison = aBytes - bBytes;
    } else if (state.dockerImagesSortBy === 'project') {
      const aProj = (getImageProject(a) || '').toLowerCase();
      const bProj = (getImageProject(b) || '').toLowerCase();
      if (!aProj && bProj) comparison = 1;
      else if (aProj && !bProj) comparison = -1;
      else comparison = aProj.localeCompare(bProj);
    } else if (state.dockerImagesSortBy === 'type') {
      const aType = a.is_ddev_custom ? 'DDEV Build' : (a.is_dangling ? 'Dangling Layer' : 'Base Image');
      const bType = b.is_ddev_custom ? 'DDEV Build' : (b.is_dangling ? 'Dangling Layer' : 'Base Image');
      comparison = aType.localeCompare(bType);
    } else if (state.dockerImagesSortBy === 'repository') {
      comparison = (a.repository || '').localeCompare(b.repository || '');
    } else if (state.dockerImagesSortBy === 'tag') {
      comparison = (a.tag || '').localeCompare(b.tag || '');
    }
    return state.dockerImagesSortOrder === 'desc' ? -comparison : comparison;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-[var(--muted)]">No images match the active filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(img => {
    const isDangling = img.is_dangling;
    const isDdev = img.is_ddev_custom;
    const typeBadge = isDangling 
      ? '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-950/60 text-amber-400 border border-amber-800/40">Dangling Layer</span>'
      : isDdev 
        ? '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-950/60 text-indigo-400 border border-indigo-800/40">DDEV Build</span>'
        : '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-[var(--surface-2)] text-[var(--muted)] border border-[var(--line)]">Base Image</span>';

    const proj = getImageProject(img);
    const projBadge = proj
      ? `<span class="px-2 py-0.5 rounded text-xs font-mono font-bold bg-indigo-950/60 text-indigo-300 border border-indigo-800/40 truncate max-w-[150px] inline-block" title="${escapeQuotes(proj)}">${proj}</span>`
      : `<span class="text-[var(--faint)] text-xs font-mono">--</span>`;

    const targetId = img.id || `${img.repository}:${img.tag}`;
    return `
      <tr class="hover:bg-[var(--surface-2)] transition">
        <td class="py-2.5 px-3 text-zinc-100 font-medium truncate max-w-xs" title="${img.repository}">
          ${img.repository}
        </td>
        <td class="py-2.5 px-3 whitespace-nowrap">
          ${projBadge}
        </td>
        <td class="py-2.5 px-3 text-zinc-300 truncate max-w-[140px]" title="${img.tag}">
          ${img.tag}
        </td>
        <td class="py-2.5 px-3 text-[var(--muted)] text-[11px]">
          ${img.id ? img.id.substring(0, 12) : '--'}
        </td>
        <td class="py-2.5 px-3 font-semibold text-indigo-400">
          ${img.size_str}
        </td>
        <td class="py-2.5 px-3">
          ${typeBadge}
        </td>
        <td class="py-2.5 px-3 text-right">
          <button onclick="promptActionExec('docker_rmi', 'Delete Image: ${escapeQuotes(targetId)}', 'docker rmi ${escapeQuotes(targetId)}', 'Removes this Docker image layer from the VM. If it is in use by an active container, Docker will safely prevent removal.', '${escapeQuotes(targetId)}')" class="px-2 py-1 rounded bg-[var(--bad-bg)] text-[var(--bad)] border border-[var(--bad)] hover:opacity-80 transition text-[11px] font-semibold" title="Remove Docker Image">
            Delete
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// -------------------------------------------------------------
// BUILD ARTIFACTS SORTING & RENDERING
// -------------------------------------------------------------

function toggleArtifactsSort(column) {
  if (state.artifactsSortBy === column) {
    state.artifactsSortOrder = state.artifactsSortOrder === 'asc' ? 'desc' : 'asc';
  } else {
    state.artifactsSortBy = column;
    state.artifactsSortOrder = column === 'size' ? 'desc' : 'asc';
  }
  syncArtifactsSortControls();
  renderArtifactsSection();
}

function handleArtifactsSortSelect(val) {
  if (!val) return;
  const parts = val.split('_');
  state.artifactsSortBy = parts[0];
  state.artifactsSortOrder = parts[1] || 'desc';
  syncArtifactsSortControls();
  renderArtifactsSection();
}

function syncArtifactsSortControls() {
  ['project', 'type', 'size'].forEach(col => {
    const el = document.getElementById(`sortIndicator-art-${col}`);
    if (!el) return;
    if (state.artifactsSortBy === col) {
      el.textContent = state.artifactsSortOrder === 'asc' ? '▲' : '▼';
    } else {
      el.textContent = '';
    }
  });

  const select = document.getElementById('artifactsSortSelect');
  if (select) {
    const expectedVal = `${state.artifactsSortBy}_${state.artifactsSortOrder}`;
    for (let opt of select.options) {
      if (opt.value === expectedVal) {
        select.value = expectedVal;
        break;
      }
    }
  }
}

function renderArtifactsSection() {
  if (!state.data || !state.data.artifacts) return;
  const rawArtifacts = state.data.artifacts.artifacts || [];
  
  const countEl = document.getElementById('artifactsCountText');
  if (countEl) {
    countEl.textContent = rawArtifacts.length;
  }
  const sizeTotalEl = document.getElementById('artifactsTotalSize');
  if (sizeTotalEl) {
    sizeTotalEl.textContent = state.data.artifacts.total_artifacts_size_str;
  }
  
  syncArtifactsSortControls();

  const aList = document.getElementById('artifactsList');
  if (!aList) return;
  if (rawArtifacts.length === 0) {
    aList.innerHTML = `<div class="text-xs text-[var(--muted)] font-mono py-8 text-center">No heavy build artifacts detected.</div>`;
    return;
  }

  // Clone and sort
  const artifacts = [...rawArtifacts];
  artifacts.sort((a, b) => {
    let comparison = 0;
    if (state.artifactsSortBy === 'size') {
      comparison = (a.size || 0) - (b.size || 0);
    } else if (state.artifactsSortBy === 'project') {
      comparison = (a.project || '').localeCompare(b.project || '');
    } else if (state.artifactsSortBy === 'type') {
      comparison = (a.type || '').localeCompare(b.type || '');
    }
    // Secondary tie-breaker by size descending or project name
    if (comparison === 0) {
      comparison = (b.size || 0) - (a.size || 0);
    }
    return state.artifactsSortOrder === 'desc' ? -comparison : comparison;
  });

  aList.innerHTML = artifacts.map(a => `
    <div class="py-3 flex items-center justify-between hover:bg-[var(--surface-2)] px-4 rounded-[var(--r)] transition">
      <div class="min-w-0 flex-1 pr-3">
        <div class="flex items-center gap-2">
          <span class="text-xs font-bold text-[var(--text)] font-sans truncate">${a.project}</span>
          <span class="px-2 py-0.5 rounded-[var(--r)] text-[11px] desk-card-2 text-[var(--accent)] font-mono font-bold shrink-0">${a.type}</span>
        </div>
        <div class="text-[11px] text-[var(--muted)] font-mono mt-0.5 truncate max-w-xl" title="${formatPath(a.path)}">
          ${formatPath(a.path)}
        </div>
      </div>
      <div class="flex items-center gap-4 shrink-0">
        <span class="text-xs font-mono font-bold text-[var(--warn)] min-w-[65px] text-right">${a.size_str}</span>
        <button onclick="promptActionExec('trash_artifact', 'Move Artifact to Trash: ${escapeQuotes(a.type)}', 'rm -rf &quot;${escapeQuotes(formatPath(a.path))}&quot;', 'Safely moves this build artifact to macOS Trash (~/.Trash). It automatically re-generates when running npm install or build.', '${escapeQuotes(a.path)}')" class="px-3 py-1.5 text-xs font-mono font-bold rounded-[var(--r)] transition" style="background: var(--bad-bg); color: var(--bad); border: 1px solid var(--bad);" title="Move safely to macOS Trash">
          Trash Artifact
        </button>
        <button onclick="copyToClipboard('rm -rf &quot;${escapeQuotes(formatPath(a.path))}&quot;', 'Copied delete command!')" class="p-1.5 rounded-[var(--r)] desk-card hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-white transition" title="Copy CLI Command">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
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

function renderInlineButtonSpinner(label) {
  return `
    <svg class="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
    </svg>
    <span class="whitespace-nowrap">${label}</span>
  `;
}

function setProjectButtonBusy(projectName, mode, btnEl, label) {
  state.startingProjects[projectName] = mode;
  if (!btnEl) return '';
  const originalContent = btnEl.innerHTML;
  const row = btnEl.closest('.group');
  if (row) row.classList.add('is-starting');
  btnEl.disabled = true;
  btnEl.classList.add('opacity-90', 'cursor-wait', 'whitespace-nowrap');
  btnEl.innerHTML = renderInlineButtonSpinner(label);
  return originalContent;
}

function clearProjectButtonBusy(projectName, btnEl, originalContent) {
  delete state.startingProjects[projectName];
  if (!btnEl) return;
  const row = btnEl.closest('.group');
  if (row) row.classList.remove('is-starting');
  btnEl.disabled = false;
  btnEl.classList.remove('opacity-90', 'cursor-wait');
  if (originalContent) btnEl.innerHTML = originalContent;
}

async function triggerTurnOnSearch(projectName, profile, searchType, btnEl) {
  const safeProfile = profile || 'search';
  const label = searchType ? capitalize(searchType) : 'Search';
  const originalContent = setProjectButtonBusy(projectName, 'search', btnEl, 'Starting...');

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
      clearProjectButtonBusy(projectName, btnEl, originalContent);
    }
  } catch (err) {
    showToast(`Error contacting server: ${err.message}`);
    clearProjectButtonBusy(projectName, btnEl, originalContent);
  }
}

async function triggerStartEverything(projectName, profile, btnEl) {
  const originalContent = setProjectButtonBusy(projectName, 'setup', btnEl, 'Setting up...');

  showToast(`Running setup for ${projectName}...`, `Starting DDEV${profile ? ' (' + profile + ')' : ''}, running dset, & building dist`);

  try {
    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'ddev_setup_project',
        target: projectName,
        profile: profile || ''
      })
    });
    const result = await res.json();
    if (result.success) {
      const p = state.data && state.data.projects ? state.data.projects[projectName] : null;
      const targetUrl = p && p.http_url ? p.http_url : `https://${projectName}.ddev.site`;
      showToast(`${projectName} setup complete!`, `Finished in ${result.duration}s`, 'Open Site', () => {
        window.open(targetUrl, '_blank');
      });
      triggerRefresh();
    } else {
      const errMsg = result.stderr || result.error || 'Failed to complete full setup';
      showToast(`Error setting up ${projectName}`, errMsg, 'Details', () => {
        promptActionExec('ddev_setup_project', `Setup Project: ${projectName}`, `ddev start ${projectName}${profile ? ' --profiles=' + profile : ''} && dset`, result.stdout || errMsg, projectName, profile);
      });
      clearProjectButtonBusy(projectName, btnEl, originalContent);
    }
  } catch (err) {
    showToast(`Error contacting server: ${err.message}`);
    clearProjectButtonBusy(projectName, btnEl, originalContent);
  }
}

async function triggerBuildDist(projectName, btnEl) {
  const originalContent = setProjectButtonBusy(projectName, 'build_dist', btnEl, 'Building...');

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
      delete state.startingProjects[projectName];
      showToast(`${projectName}: Dist built successfully!`, result.command ? `$ ${result.command}` : '');
      triggerRefresh();
    } else {
      const errMsg = result.stderr || result.error || 'Frontend build failed';
      showToast(`Build error for ${projectName}`, errMsg, 'Details', () => {
        promptActionExec('ddev_build_dist', `Build Dist: ${projectName}`, result.command || 'make buildall', errMsg, projectName);
      });
      clearProjectButtonBusy(projectName, btnEl, originalContent);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`);
    clearProjectButtonBusy(projectName, btnEl, originalContent);
  }
}

// -------------------------------------------------------------
// GIT FETCH & SEARCHABLE BRANCH SELECTOR
// -------------------------------------------------------------

let activeBranchPopover = {
  project: null,
  branches: [],
  anchorEl: null,
  isSwitching: false
};

async function triggerGitFetch(projectName, btnEl) {
  let originalContent = '';
  if (btnEl) {
    originalContent = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.classList.add('opacity-75', 'cursor-wait');
    const hasText = btnEl.querySelector('span');
    btnEl.innerHTML = hasText
      ? renderInlineButtonSpinner('Fetching...')
      : `<svg class="w-3.5 h-3.5 animate-spin text-sky-300" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg>`;
  }

  try {
    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'git_fetch',
        target: projectName
      })
    });
    const result = await res.json();
    if (result.success) {
      if (result.git && state.data?.projects?.[projectName]) {
        state.data.projects[projectName].git = result.git;
        if (result.git.branch) state.data.projects[projectName].branch = result.git.branch;
      }
      const combined = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
      const summary = combined ? combined.split('\n').slice(0, 2).join(' • ') : 'Remote refs up to date';
      showToast(`Fetched ${projectName}`, summary);
      if (activeBranchPopover.project === projectName) {
        await loadBranchesForPopover(projectName);
      }
    } else {
      showToast(`Git fetch failed for ${projectName}`, result.stderr || result.error || 'Failed to fetch');
    }
  } catch (err) {
    showToast('Git fetch error', err.message);
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.classList.remove('opacity-75', 'cursor-wait');
      btnEl.innerHTML = originalContent;
    }
  }
}

async function openBranchSelector(projectName, anchorEl, event) {
  if (event) event.stopPropagation();
  closeGitChangesPopover();
  const popover = document.getElementById('branchSelectorPopover');
  if (!popover) return;

  // Toggle closed if clicking the same active button
  if (!popover.classList.contains('hidden') && activeBranchPopover.project === projectName) {
    closeBranchSelector();
    return;
  }

  activeBranchPopover = {
    project: projectName,
    branches: [],
    anchorEl,
    isSwitching: false
  };

  const titleEl = document.getElementById('branchPopoverTitle');
  const subEl = document.getElementById('branchPopoverSubtitle');
  const searchInput = document.getElementById('branchSearchInput');
  const listEl = document.getElementById('branchOptionsList');

  if (titleEl) titleEl.textContent = `${projectName} — Switch Branch`;
  if (subEl) subEl.textContent = 'Clean working tree • matches anywhere';
  if (searchInput) searchInput.value = '';
  if (listEl) {
    listEl.innerHTML = `<div class="py-6 text-center text-xs font-mono text-[var(--muted)] flex items-center justify-center gap-2"><svg class="w-3.5 h-3.5 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg><span>Loading branches...</span></div>`;
  }

  popover.classList.remove('hidden');
  positionBranchPopover(anchorEl, popover);
  if (searchInput) setTimeout(() => searchInput.focus(), 10);

  await loadBranchesForPopover(projectName);
}

function positionAnchoredPopover(anchorEl, popover, preferredWidth = 320, fallbackSelector = null) {
  if (!popover) return null;
  if ((!anchorEl || !document.body.contains(anchorEl)) && fallbackSelector) {
    anchorEl = document.querySelector(fallbackSelector);
  }
  if (!anchorEl || !document.body.contains(anchorEl)) return null;

  const rect = anchorEl.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  const popWidth = Math.min(preferredWidth, window.innerWidth - 24);
  const popHeight = Math.min(popover.offsetHeight || 340, 380);
  let left = rect.left;
  if (left + popWidth > window.innerWidth - 12) {
    left = Math.max(12, window.innerWidth - popWidth - 12);
  }
  let top = rect.bottom + 6;
  if (top + popHeight > window.innerHeight - 12 && rect.top - popHeight - 6 > 12) {
    top = rect.top - popHeight - 6;
  }
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
  return anchorEl;
}

function positionBranchPopover(anchorEl, popover) {
  const selector = activeBranchPopover.project
    ? `[data-branch-anchor="${CSS.escape(activeBranchPopover.project)}"]`
    : null;
  const resolved = positionAnchoredPopover(anchorEl, popover, 320, selector);
  if (resolved) activeBranchPopover.anchorEl = resolved;
}

async function loadBranchesForPopover(projectName) {
  const listEl = document.getElementById('branchOptionsList');
  try {
    const res = await fetch(`/api/git/branches?project=${encodeURIComponent(projectName)}`);
    const data = await res.json();
    if (activeBranchPopover.project !== projectName) return;

    if (!data.success) {
      if (listEl) {
        listEl.innerHTML = `<div class="p-4 text-xs font-mono text-rose-400">${escapeHtml(data.error || 'Failed to load branches')}</div>`;
      }
      return;
    }

    if (!data.clean) {
      if (listEl) {
        listEl.innerHTML = `<div class="p-4 text-xs font-mono text-amber-400">Working tree has uncommitted changes. Commit or stash them before switching branches.</div>`;
      }
      return;
    }

    activeBranchPopover.branches = data.branches || [];
    filterBranchOptions();
    positionBranchPopover(activeBranchPopover.anchorEl, document.getElementById('branchSelectorPopover'));
  } catch (err) {
    if (listEl) {
      listEl.innerHTML = `<div class="p-4 text-xs font-mono text-rose-400">Network error: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function highlightBranchMatch(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return safe;
  const before = escapeHtml(text.slice(0, idx));
  const match = escapeHtml(text.slice(idx, idx + query.length));
  const after = escapeHtml(text.slice(idx + query.length));
  return `${before}<mark class="bg-indigo-500/40 text-white rounded px-0.5">${match}</mark>${after}`;
}

function filterBranchOptions() {
  const listEl = document.getElementById('branchOptionsList');
  const searchInput = document.getElementById('branchSearchInput');
  if (!listEl) return;

  const query = (searchInput?.value || '').trim().toLowerCase();
  const matches = activeBranchPopover.branches.filter(b =>
    !query ||
    b.name.toLowerCase().includes(query) ||
    (b.full_ref && b.full_ref.toLowerCase().includes(query))
  );

  if (matches.length === 0) {
    listEl.innerHTML = `<div class="py-6 px-3 text-center text-xs font-mono text-[var(--muted)]">No branches matching "${escapeHtml(searchInput?.value || '')}"</div>`;
    return;
  }

  listEl.innerHTML = matches.map(b => {
    const typeBadge = b.is_current
      ? `<span class="px-1.5 py-0.2 rounded text-[9px] font-mono font-bold bg-emerald-950/70 text-emerald-400 border border-emerald-800/50 shrink-0">Current</span>`
      : b.type === 'remote'
      ? `<span class="px-1.5 py-0.2 rounded text-[9px] font-mono bg-indigo-950/60 text-indigo-300 border border-indigo-800/40 shrink-0" title="${escapeQuotes(b.full_ref)}">Remote</span>`
      : '';

    const disabledAttr = (b.is_current || activeBranchPopover.isSwitching) ? 'disabled' : '';
    const rowCls = b.is_current
      ? 'bg-emerald-950/20 cursor-default'
      : 'hover:bg-[var(--surface-2)] cursor-pointer';

    return `
      <button ${disabledAttr} onclick="selectGitBranch('${escapeQuotes(activeBranchPopover.project)}', '${escapeQuotes(b.full_ref || b.name)}', '${escapeQuotes(b.name)}')" class="w-full px-3 py-2 text-left transition flex items-center justify-between gap-2 ${rowCls}">
        <div class="min-w-0 flex-1">
          <div class="text-xs font-mono font-medium text-zinc-100 truncate">${highlightBranchMatch(b.name, (searchInput?.value || '').trim())}</div>
          ${b.age ? `<div class="text-[10px] font-mono text-[var(--faint)] truncate">${escapeHtml(b.age)}${b.type === 'remote' ? ` • ${escapeHtml(b.full_ref)}` : ''}</div>` : ''}
        </div>
        ${typeBadge}
      </button>
    `;
  }).join('');
}

async function fetchFromBranchPopover() {
  if (!activeBranchPopover.project) return;
  const fetchBtn = document.getElementById('branchPopoverFetchBtn');
  await triggerGitFetch(activeBranchPopover.project, fetchBtn);
}

async function selectGitBranch(projectName, refToCheckout, displayName) {
  if (!projectName || activeBranchPopover.isSwitching) return;
  activeBranchPopover.isSwitching = true;

  const listEl = document.getElementById('branchOptionsList');
  if (listEl) {
    listEl.innerHTML = `<div class="py-6 text-center text-xs font-mono text-indigo-300 flex items-center justify-center gap-2"><svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg><span>Switching to ${escapeHtml(displayName)}...</span></div>`;
  }

  try {
    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'git_checkout_branch',
        target: projectName,
        branch: refToCheckout
      })
    });
    const result = await res.json();
    if (result.success) {
      if (state.data?.projects?.[projectName]) {
        if (result.git) state.data.projects[projectName].git = result.git;
        if (result.branch) state.data.projects[projectName].branch = result.branch;
      }
      closeBranchSelector();
      renderDdevSection();
      showToast(`Switched ${projectName} branch`, `Now on ${result.branch || displayName}`);
    } else {
      activeBranchPopover.isSwitching = false;
      showToast(`Branch switch failed (${projectName})`, result.stderr || result.error || 'Checkout failed');
      await loadBranchesForPopover(projectName);
    }
  } catch (err) {
    activeBranchPopover.isSwitching = false;
    showToast('Network error', err.message);
    await loadBranchesForPopover(projectName);
  }
}

function closeBranchSelector() {
  const popover = document.getElementById('branchSelectorPopover');
  if (popover) popover.classList.add('hidden');
  activeBranchPopover = { project: null, branches: [], anchorEl: null, isSwitching: false };
}

let activeGitChangesPopover = {
  project: null,
  anchorEl: null
};

function openGitChangesPopover(projectName, anchorEl, event) {
  if (event) event.stopPropagation();
  closeBranchSelector();

  const popover = document.getElementById('gitChangesPopover');
  const proj = state.data?.projects?.[projectName];
  if (!popover || !proj || !proj.git) return;

  if (!popover.classList.contains('hidden') && activeGitChangesPopover.project === projectName) {
    closeGitChangesPopover();
    return;
  }

  activeGitChangesPopover = { project: projectName, anchorEl };

  const git = proj.git;
  const titleEl = document.getElementById('gitChangesTitle');
  const subEl = document.getElementById('gitChangesSubtitle');
  const listEl = document.getElementById('gitChangesFileList');
  const termBtn = document.getElementById('gitChangesTermBtn');
  const revealBtn = document.getElementById('gitChangesRevealBtn');

  if (titleEl) titleEl.textContent = `${projectName} (${proj.branch || git.branch || 'git'})`;
  if (subEl) {
    const parts = [];
    if (git.changed > 0) parts.push(`${git.changed} changed`);
    if (git.untracked > 0) parts.push(`${git.untracked} untracked`);
    subEl.textContent = parts.length ? parts.join(' • ') : `${git.total_dirty || 0} uncommitted files`;
  }

  const files = git.files || [];
  if (listEl) {
    if (files.length === 0) {
      listEl.innerHTML = `<div class="py-5 px-3 text-center text-xs font-mono text-[var(--muted)]">No modified or untracked files cached.</div>`;
    } else {
      const itemsHtml = files.map(f => {
        const badgeCls = f.untracked
          ? 'bg-amber-950/70 text-amber-300 border-amber-700/50'
          : f.status === 'D'
          ? 'bg-rose-950/70 text-rose-300 border-rose-700/50'
          : 'bg-sky-950/70 text-sky-300 border-sky-700/50';
        const statusLabel = escapeHtml(f.status || (f.untracked ? '??' : 'M'));
        return `
          <div class="px-3 py-1.5 flex items-center gap-2 hover:bg-[var(--surface-2)] transition">
            <span class="w-6 text-center px-1 py-0.2 rounded text-[10px] font-mono font-bold border shrink-0 ${badgeCls}">${statusLabel}</span>
            <span class="text-[11px] font-mono text-zinc-200 truncate flex-1" title="${escapeQuotes(f.file)}">${escapeHtml(f.file)}</span>
          </div>
        `;
      }).join('');

      const remaining = (git.total_dirty || 0) - files.length;
      const moreFooter = remaining > 0
        ? `<div class="px-3 py-1.5 text-[10px] font-mono text-[var(--muted)] bg-[var(--surface-2)]">...and ${remaining} more file(s)</div>`
        : '';
      listEl.innerHTML = itemsHtml + moreFooter;
    }
  }

  if (termBtn) termBtn.onclick = () => { launchTerminal('git status', proj.approot); closeGitChangesPopover(); };
  if (revealBtn) revealBtn.onclick = () => { revealFile(proj.approot); closeGitChangesPopover(); };

  popover.classList.remove('hidden');
  positionAnchoredPopover(anchorEl, popover, 384, `[data-git-changes-anchor="${CSS.escape(projectName)}"]`);
}

function closeGitChangesPopover() {
  const popover = document.getElementById('gitChangesPopover');
  if (popover) popover.classList.add('hidden');
  activeGitChangesPopover = { project: null, anchorEl: null };
}

document.addEventListener('click', (e) => {
  const branchPop = document.getElementById('branchSelectorPopover');
  if (branchPop && !branchPop.classList.contains('hidden')) {
    if (!branchPop.contains(e.target) && (!activeBranchPopover.anchorEl || !activeBranchPopover.anchorEl.contains(e.target))) {
      closeBranchSelector();
    }
  }

  const gitPop = document.getElementById('gitChangesPopover');
  if (gitPop && !gitPop.classList.contains('hidden')) {
    if (!gitPop.contains(e.target) && (!activeGitChangesPopover.anchorEl || !activeGitChangesPopover.anchorEl.contains(e.target))) {
      closeGitChangesPopover();
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeBranchSelector();
    closeGitChangesPopover();
  } else if (e.key === 'Enter' && document.activeElement?.id === 'branchSearchInput') {
    const query = document.activeElement.value.trim().toLowerCase();
    const matches = activeBranchPopover.branches.filter(b =>
      !b.is_current && (!query || b.name.toLowerCase().includes(query) || (b.full_ref && b.full_ref.toLowerCase().includes(query)))
    );
    if (matches.length === 1) {
      e.preventDefault();
      selectGitBranch(activeBranchPopover.project, matches[0].full_ref || matches[0].name, matches[0].name);
    }
  }
});

// -------------------------------------------------------------
// COLIMA RESOURCE SETTINGS MODAL
// -------------------------------------------------------------

let colimaAutoDismissTimer = null;

function setColimaCancelVisible(visible) {
  const cancelBtn = document.getElementById('colimaCancelBtn');
  if (!cancelBtn) return;
  if (visible) {
    cancelBtn.classList.remove('hidden');
    cancelBtn.style.display = '';
  } else {
    cancelBtn.classList.add('hidden');
    cancelBtn.style.setProperty('display', 'none', 'important');
  }
}

function setColimaControlsDisabled(disabled) {
  ['colimaToggleRunningBtn', 'colimaRestartModalBtn', 'colimaSaveRestartBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

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

  if (colimaAutoDismissTimer) {
    clearTimeout(colimaAutoDismissTimer);
    colimaAutoDismissTimer = null;
  }

  const autoDismissCheckbox = document.getElementById('colimaAutoDismissCheckbox');
  if (autoDismissCheckbox) {
    try {
      autoDismissCheckbox.checked = (localStorage.getItem('orbit_auto_dismiss') === 'true');
    } catch (e) {}
  }

  setColimaCancelVisible(true);
  setColimaControlsDisabled(false);

  const saveBtn = document.getElementById('colimaSaveRestartBtn');
  const saveSpinner = document.getElementById('colimaSaveSpinner');
  const saveText = document.getElementById('colimaSaveBtnText');
  if (saveBtn) {
    saveBtn.classList.remove('opacity-75');
    saveBtn.onclick = () => saveColimaSettings(true);
  }
  if (saveSpinner) saveSpinner.classList.add('hidden');
  if (saveText) saveText.textContent = 'Save & Apply';

  const out = document.getElementById('colimaSettingsOutput');
  out.classList.add('hidden');
  out.textContent = '';

  modal.classList.remove('hidden');
}

function closeColimaSettingsModal() {
  if (colimaAutoDismissTimer) {
    clearTimeout(colimaAutoDismissTimer);
    colimaAutoDismissTimer = null;
  }
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

  if (colimaAutoDismissTimer) {
    clearTimeout(colimaAutoDismissTimer);
    colimaAutoDismissTimer = null;
  }

  const saveBtn = document.getElementById('colimaSaveRestartBtn');
  const saveSpinner = document.getElementById('colimaSaveSpinner');
  const saveText = document.getElementById('colimaSaveBtnText');
  const out = document.getElementById('colimaSettingsOutput');

  setColimaCancelVisible(false);
  setColimaControlsDisabled(true);
  if (saveBtn) saveBtn.classList.add('opacity-75');
  if (saveSpinner) saveSpinner.classList.remove('hidden');
  if (saveText) saveText.textContent = restart ? 'Applying...' : 'Saving...';

  const statusMsg = restart
    ? 'Saving configuration and restarting Colima VM... please wait...'
    : 'Saving configuration...';
  out.classList.remove('hidden');
  out.innerHTML = `<div class="flex items-center gap-2 text-zinc-300"><svg class="w-3.5 h-3.5 animate-spin text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg><span>${statusMsg}</span></div>`;

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
    if (saveSpinner) saveSpinner.classList.add('hidden');

    if (result.success) {
      setColimaControlsDisabled(false);
      if (saveBtn) saveBtn.classList.remove('opacity-75');
      out.textContent = result.stdout || 'Colima configuration updated successfully!';
      showToast('Colima settings applied!', `${cpu} CPUs • ${memory} GB RAM • ${disk} GB Disk`);
      triggerRefresh();

      let autoDismiss = false;
      try {
        autoDismiss = document.getElementById('colimaAutoDismissCheckbox')?.checked ?? (localStorage.getItem('orbit_auto_dismiss') === 'true');
      } catch (e) {}

      if (autoDismiss) {
        if (saveBtn) {
          saveBtn.disabled = true;
          if (saveText) saveText.textContent = 'Applied ✓';
        }
        colimaAutoDismissTimer = setTimeout(() => {
          closeColimaSettingsModal();
        }, 1200);
      } else {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.onclick = closeColimaSettingsModal;
          if (saveText) saveText.textContent = 'Close';
        }
      }
    } else {
      setColimaCancelVisible(true);
      setColimaControlsDisabled(false);
      if (saveBtn) {
        saveBtn.classList.remove('opacity-75');
        saveBtn.onclick = () => saveColimaSettings(true);
      }
      if (saveText) saveText.textContent = 'Save & Apply';
      out.textContent = `Error: ${result.stderr || result.error || 'Failed to update Colima'}`;
    }
  } catch (err) {
    if (saveSpinner) saveSpinner.classList.add('hidden');
    setColimaCancelVisible(true);
    setColimaControlsDisabled(false);
    if (saveBtn) {
      saveBtn.classList.remove('opacity-75');
      saveBtn.onclick = () => saveColimaSettings(true);
    }
    if (saveText) saveText.textContent = 'Save & Apply';
    out.textContent = `Network error: ${err.message}`;
  }
}

async function toggleColimaLifecycle() {
  const colima = state.data?.overview?.colima || {};
  const isRunning = colima.is_running || false;
  const action = isRunning ? 'colima_stop' : 'colima_start';
  const label = isRunning ? 'Stopping Colima...' : 'Starting Colima...';

  const toggleBtn = document.getElementById('colimaToggleRunningBtn');
  const originalContent = toggleBtn ? toggleBtn.innerHTML : '';
  setColimaCancelVisible(false);
  setColimaControlsDisabled(true);
  if (toggleBtn) {
    toggleBtn.innerHTML = `
      <svg class="w-3.5 h-3.5 animate-spin text-zinc-300" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
      </svg>
      <span>${isRunning ? 'Stopping...' : 'Starting...'}</span>
    `;
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
      if (toggleBtn) toggleBtn.innerHTML = originalContent;
      setColimaCancelVisible(true);
      setColimaControlsDisabled(false);
    }
  } catch (err) {
    showToast('Network error', err.message);
    if (toggleBtn) toggleBtn.innerHTML = originalContent;
    setColimaCancelVisible(true);
    setColimaControlsDisabled(false);
  }
}

async function triggerColimaRestart(btnEl) {
  const inModal = btnEl?.id === 'colimaRestartModalBtn';
  let originalContent = '';
  if (inModal) {
    setColimaCancelVisible(false);
    setColimaControlsDisabled(true);
  }
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
      if (inModal) {
        setColimaCancelVisible(true);
        setColimaControlsDisabled(false);
      }
    }
  } catch (err) {
    showToast('Network error', err.message);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.classList.remove('opacity-75');
      btnEl.innerHTML = originalContent;
    }
    if (inModal) {
      setColimaCancelVisible(true);
      setColimaControlsDisabled(false);
    }
  }
}

// -------------------------------------------------------------
// ACTION EXECUTION MODAL (Direct 1-Click Execution)
// -------------------------------------------------------------

function toggleAutoDismiss(checked) {
  try {
    localStorage.setItem('orbit_auto_dismiss', checked ? 'true' : 'false');
  } catch (e) {}
  ['modalAutoDismissCheckbox', 'colimaAutoDismissCheckbox'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = checked;
  });
}

function promptActionExec(action, title, cmd, desc, target = '', profile = '') {
  state.currentAction = { action, title, cmd, desc, target, profile };
  
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalDesc').textContent = desc;
  document.getElementById('modalCmdText').textContent = cmd;
  
  const outSection = document.getElementById('modalOutputSection');
  outSection.classList.add('hidden');
  document.getElementById('modalOutputBox').textContent = '';

  const cancelBtn = document.getElementById('modalCancelBtn');
  if (cancelBtn) {
    cancelBtn.classList.remove('hidden');
    cancelBtn.style.display = '';
  }

  const runBtn = document.getElementById('modalRunBtn');
  runBtn.disabled = false;
  runBtn.onclick = runConfirmedAction;
  document.getElementById('modalRunBtnText').textContent = 'Execute Action';
  document.getElementById('modalSpinner').classList.add('hidden');

  const chk = document.getElementById('modalAutoDismissCheckbox');
  if (chk) {
    try {
      chk.checked = localStorage.getItem('orbit_auto_dismiss') === 'true';
    } catch (e) {
      chk.checked = false;
    }
  }

  document.getElementById('actionModal').classList.remove('hidden');
}

function closeExecModal() {
  document.getElementById('actionModal').classList.add('hidden');
  const cancelBtn = document.getElementById('modalCancelBtn');
  if (cancelBtn) {
    cancelBtn.classList.remove('hidden');
    cancelBtn.style.display = '';
  }
}

function copyModalCmd() {
  if (state.currentAction) {
    copyToClipboard(state.currentAction.cmd, 'Copied command to clipboard!');
  }
}

async function runConfirmedAction() {
  if (!state.currentAction) return;

  const current = state.currentAction;
  const { action, target, profile, title } = current;
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
    let autoDismiss = false;
    try {
      autoDismiss = localStorage.getItem('orbit_auto_dismiss') === 'true';
    } catch (e) {}

    if (result.success) {
      const cancelBtn = document.getElementById('modalCancelBtn');
      if (cancelBtn) {
        cancelBtn.classList.add('hidden');
        cancelBtn.style.setProperty('display', 'none', 'important');
      }

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
          result.command ? `$ ${result.command}` : (title || 'Disk optimization action'),
          { isColima: action.includes('colima') }
        );
      } else {
        showToast('Action completed successfully!', result.command ? `$ ${result.command}` : (title || 'Action completed'));
      }

      if (action.includes('trash')) {
        state.selectedDumps.clear();
      }

      triggerRefresh();

      if (autoDismiss) {
        setTimeout(() => {
          closeExecModal();
        }, 1600);
      } else {
        runBtn.disabled = false;
        btnText.textContent = 'Close';
        runBtn.onclick = closeExecModal;
      }
    } else {
      const cancelBtn = document.getElementById('modalCancelBtn');
      if (cancelBtn) cancelBtn.classList.remove('hidden');
      btnText.textContent = 'Failed';
      outBox.textContent = `Exit Code: ${result.exit_code}\n\nSTDOUT:\n${result.stdout || '(none)'}\n\nSTDERR:\n${result.stderr || result.error || '(none)'}`;
      runBtn.disabled = false;
      runBtn.onclick = runConfirmedAction;
    }
  } catch (err) {
    spinner.classList.add('hidden');
    const cancelBtn = document.getElementById('modalCancelBtn');
    if (cancelBtn) cancelBtn.classList.remove('hidden');
    btnText.textContent = 'Error';
    outBox.textContent = `Failed to contact server: ${err.message}`;
    runBtn.disabled = false;
    runBtn.onclick = runConfirmedAction;
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
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// -------------------------------------------------------------
// APP DRAWER MODAL (Visual Grid App Launcher)
// -------------------------------------------------------------

function openAppDrawerModal() {
  const modal = document.getElementById('appDrawerModal');
  const box = document.getElementById('appDrawerBox');
  if (!modal || !box) return;

  renderAppDrawerGrid();

  modal.classList.remove('hidden');
  requestAnimationFrame(() => {
    modal.classList.remove('opacity-0', 'pointer-events-none');
    box.classList.remove('scale-95');
    box.classList.add('scale-100');
  });

  const searchInput = document.getElementById('appDrawerSearchInput');
  if (searchInput) {
    searchInput.value = '';
    setTimeout(() => searchInput.focus(), 150);
  }
}

function closeAppDrawerModal() {
  const modal = document.getElementById('appDrawerModal');
  const box = document.getElementById('appDrawerBox');
  if (!modal || !box) return;

  modal.classList.add('opacity-0', 'pointer-events-none');
  box.classList.remove('scale-100');
  box.classList.add('scale-95');
  setTimeout(() => {
    modal.classList.add('hidden');
  }, 200);
}

function filterAppDrawerGrid() {
  renderAppDrawerGrid();
}

function renderAppDrawerGrid() {
  if (!state.data) return;
  const gridEl = document.getElementById('appDrawerGrid');
  const countEl = document.getElementById('appDrawerModalCount');
  if (!gridEl) return;

  const allProjects = Object.values(state.data.projects || {});
  const stoppedProjects = allProjects.filter(p => !p.is_running);

  if (countEl) {
    countEl.textContent = `${stoppedProjects.length} Stopped`;
  }

  const query = (document.getElementById('appDrawerSearchInput')?.value || '').toLowerCase().trim();

  const filtered = stoppedProjects.filter(p => {
    if (!query) return true;
    const name = (p.name || '').toLowerCase();
    const branch = (p.branch || '').toLowerCase();
    const php = (p.php_version || '').toLowerCase();
    const searchType = (p.search?.type || '').toLowerCase();
    return name.includes(query) || branch.includes(query) || php.includes(query) || searchType.includes(query);
  });

  if (filtered.length === 0) {
    gridEl.innerHTML = `
      <div class="col-span-full py-16 text-center text-xs font-mono text-[var(--muted)]">
        No stopped projects matching "${escapeHtml(query)}"
      </div>
    `;
    return;
  }

  gridEl.innerHTML = filtered.map(p => {
    const branding = p.branding || {};
    const brandColor = branding.brand_color || '#3b82f6';
    const hasLogo = branding.has_logo;
    const monogram = branding.monogram || p.name.substring(0, 3).toUpperCase();
    const hasSearch = p.search && p.search.configured;
    const branch = p.branch || '';
    const php = p.php_version || '';

    return `
      <div onclick="handleAppDrawerTileClick(event, '${escapeHtml(p.name)}', ${hasSearch})"
           id="appTile-${escapeHtml(p.name)}"
           class="app-drawer-tile group relative flex flex-col items-center justify-between p-4 rounded-2xl bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border-2 border-black shadow-[3.5px_3.5px_0px_#000] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none cursor-pointer transition-colors duration-150 select-none overflow-hidden"
           title="Click to start ${escapeHtml(p.name)} (Hold Shift for +Search)">

        <!-- Brand Color Accent Bar -->
        <div class="absolute top-0 left-0 right-0 h-1.5" style="background-color: ${brandColor};"></div>

        <!-- Centerpiece App Icon Stage -->
        <div class="w-20 h-20 mt-1 mb-2.5 rounded-2xl flex items-center justify-center p-3 relative bg-[var(--bg)]/90 border border-white/10 shadow-inner transition-transform group-hover:scale-105">
          ${hasLogo ? `
            <img src="/api/project_logo?name=${encodeURIComponent(p.name)}" 
                 alt="${escapeHtml(p.name)} logo" 
                 class="max-w-full max-h-full object-contain drop-shadow" 
                 loading="lazy"
                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
            <div class="hidden w-full h-full rounded-xl items-center justify-center font-black text-xl text-white tracking-wider font-mono shadow-inner border border-white/10" style="background: linear-gradient(135deg, ${brandColor}, #111827);">
              ${monogram}
            </div>
          ` : `
            <div class="w-full h-full rounded-xl flex items-center justify-center font-black text-xl text-white tracking-wider font-mono shadow-inner border border-white/10" style="background: linear-gradient(135deg, ${brandColor}, #18191e);">
              ${monogram}
            </div>
          `}

          ${hasSearch ? `
            <span class="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-amber-500 border-2 border-[var(--surface-2)] flex items-center justify-center text-[9px] font-bold text-black" title="Search service available (+Solr/Elastic)">⚡</span>
          ` : ''}
        </div>

        <!-- Label Underneath: Name and Tags -->
        <div class="w-full text-center min-w-0">
          <div class="font-bold text-xs sm:text-sm text-white group-hover:text-amber-300 transition-colors truncate px-1" title="${escapeHtml(p.name)}">
            ${escapeHtml(p.name)}
          </div>
          
          <div class="flex items-center justify-center gap-1.5 mt-1.5 flex-wrap">
            ${branch ? `
              <span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-black/50 text-[var(--muted)] truncate max-w-[105px]" title="${escapeHtml(branch)}">
                ${escapeHtml(branch)}
              </span>
            ` : ''}
            ${php ? `
              <span class="text-[9px] font-mono px-1 py-0.5 rounded bg-black/40 text-[var(--faint)]">
                ${escapeHtml(php)}
              </span>
            ` : ''}
          </div>
        </div>

        <!-- Launching Overlay Spinner -->
        <div id="appTileOverlay-${escapeHtml(p.name)}" class="absolute inset-0 bg-black/85 backdrop-blur-sm rounded-2xl flex flex-col items-center justify-center gap-2 p-2 hidden z-10">
          <svg class="w-7 h-7 text-emerald-400 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span class="text-xs font-bold text-white font-mono">Starting...</span>
        </div>

      </div>
    `;
  }).join('');
}

async function handleAppDrawerTileClick(event, projectName, hasSearch) {
  // If Shift key was held down and search is configured, launch with search
  const withSearch = (event.shiftKey && hasSearch);
  await launchAppDrawerProject(projectName, withSearch);
}

async function launchAppDrawerProject(projectName, withSearch = false) {
  const overlay = document.getElementById(`appTileOverlay-${projectName}`);
  if (overlay) overlay.classList.remove('hidden');

  const p = state.data && state.data.projects ? state.data.projects[projectName] : null;
  const profile = (withSearch && p && p.search && p.search.profile) ? p.search.profile : (withSearch ? 'search' : '');

  showToast(`Starting ${projectName}...`, withSearch ? 'Starting with search containers' : 'Running: ddev start ' + projectName);

  try {
    const res = await fetch('/api/action/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: withSearch ? 'ddev_start_search' : 'ddev_start_project',
        target: projectName,
        profile: profile
      })
    });
    const result = await res.json();
    if (result.success) {
      const p = state.data && state.data.projects ? state.data.projects[projectName] : null;
      const targetUrl = p && p.http_url ? p.http_url : `https://${projectName}.ddev.site`;
      showToast(`${projectName} is running!`, `Finished in ${result.duration}s`, 'Open Site', () => {
        window.open(targetUrl, '_blank');
      });
      triggerRefresh(false);
      setTimeout(() => {
        if (overlay) overlay.classList.add('hidden');
        closeAppDrawerModal();
      }, 700);
    } else {
      if (overlay) overlay.classList.add('hidden');
      const errMsg = result.stderr || result.error || 'Failed to start project';
      showToast(`Error starting ${projectName}`, errMsg, 'Details', () => {
        promptActionExec('ddev_start_project', `Start Project: ${projectName}`, `ddev start ${projectName}`, errMsg, projectName);
      });
    }
  } catch (err) {
    if (overlay) overlay.classList.add('hidden');
    showToast(`Error contacting server: ${err.message}`);
  }
}

// -------------------------------------------------------------
// PWA (PROGRESSIVE WEB APP) & SERVICE WORKER
// -------------------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('PWA service worker registration failed:', err);
    });
  });
}

let deferredPwaPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPwaPrompt = e;
  const installBtn = document.getElementById('pwaInstallBtn');
  if (installBtn) {
    installBtn.classList.remove('hidden');
    installBtn.classList.add('flex');
  }
});

window.addEventListener('appinstalled', () => {
  deferredPwaPrompt = null;
  const installBtn = document.getElementById('pwaInstallBtn');
  if (installBtn) {
    installBtn.classList.add('hidden');
    installBtn.classList.remove('flex');
  }
  showToast('DDev Orbit Installed!', 'App is running in standalone desktop mode.');
});

async function triggerPwaInstall() {
  if (deferredPwaPrompt) {
    deferredPwaPrompt.prompt();
    const { outcome } = await deferredPwaPrompt.userChoice;
    if (outcome === 'accepted') {
      deferredPwaPrompt = null;
      const installBtn = document.getElementById('pwaInstallBtn');
      if (installBtn) {
        installBtn.classList.add('hidden');
        installBtn.classList.remove('flex');
      }
    }
  } else {
    // Helpful guide for macOS Safari Sonoma+ or already installed
    showToast(
      'Install DDev Orbit on Mac',
      'In Safari: click File → "Add to Dock..." to install Orbit as a standalone Mac application!'
    );
  }
}
