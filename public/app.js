const EXPANDED_KEY = 'dlm.expanded';

function loadExpanded() {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

function saveExpanded() {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...state.expanded]));
  } catch {
    /* storage unavailable; expansion just won't survive a reload */
  }
}

const state = {
  pollIntervalMs: 15000,
  projects: new Map(), // name -> latest status
  aheadBehind: new Map(), // name -> { ahead, behind, checkedAt }
  history: new Map(), // name -> commit list
  logs: new Map(), // name -> { lines, status, exitCode, es }
  selectedCommit: new Map(), // name -> hash chosen in the rollback dropdown
  pullFirst: new Set(), // names with "pull first" checked
  rebuildAfter: new Set(), // names with "rebuild after" checked
  expanded: loadExpanded(), // names showing full detail instead of the one-line summary
  containerLogs: new Map(), // name -> { service, text } shown under the card
  scrollLogsFor: null, // card whose freshly loaded logs should be scrolled to the end
  menuOpen: null, // name of the card whose kebab menu is open
  rollbackOpen: new Set(), // names showing the rollback controls within an expanded card
  selfCheckIntervalMs: 300000,
  self: { detected: false, project: null, bootId: null }, // the manager's own container/project
  selfUpdate: null, // latest { available, ahead, behind } from /api/self/check
  selfUpdateDismissed: null, // the `behind` count the user dismissed the banner at
  selfCheckedAt: 0,
  restarting: false,
};

const RESTART_COUNTDOWN_S = 60;

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data;
}

function escapeHtml(str = '') {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function truncate(str = '', n) {
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function timeAgo(iso) {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One line for the collapsed card -- enough to tell "does this need attention" at a glance. */
function summaryText(p) {
  const parts = [];
  if (p.git) {
    parts.push(p.git.detached ? `${p.git.hash} (detached)` : p.git.hash);
  } else {
    parts.push('no git');
  }
  if (!p.composeFilePresent) {
    parts.push('no compose file');
  } else if (p.services.length) {
    const running = p.services.filter((s) => s.state === 'running').length;
    parts.push(`${running}/${p.services.length} running`);
  } else {
    parts.push('not started');
  }
  return parts.join(' · ');
}

function reasons(p) {
  const out = [];
  if (!p.git) {
    out.push('not a git repository — pull/rollback unavailable');
  } else {
    if (p.git.detached) out.push(`HEAD detached at ${p.git.hash} — "Return to latest" to resume pulling`);
    if (p.git.dirty) out.push('uncommitted changes — commit or discard to pull/roll back');
  }
  if (!p.composeFilePresent) out.push('no compose file at the current commit — rebuild unavailable');
  if (p.running) out.push('an operation is already running for this project');
  return out;
}

function renderLog(log) {
  const lines = log.lines.map((l) => `<span class="${l.stream}">${escapeHtml(l.text)}\n</span>`).join('');
  const statusLine =
    log.status && log.status !== 'running'
      ? `<div class="log-status ${log.status}">${log.status === 'success' ? '✓ succeeded' : '✗ failed'}${
          log.exitCode != null ? ` (exit ${log.exitCode})` : ''
        }</div>`
      : '';
  return `<div class="log" data-role="log">${lines}</div>${statusLine}`;
}

function renderGitBlock(p) {
  const git = p.git;
  const ab = state.aheadBehind.get(p.name);
  return git
    ? `<div class="git-line">
        <code>${git.hash}</code> ${escapeHtml(git.message)}
        ${git.detached ? '<span class="tag warn">detached</span>' : `<span class="tag">${escapeHtml(git.branch ?? '')}</span>`}
        ${git.dirty ? '<span class="tag warn">dirty</span>' : ''}
        ${ab ? `<span class="tag">${ab.ahead}↑ ${ab.behind}↓ · checked ${timeAgo(ab.checkedAt)}</span>` : ''}
      </div>`
    : '<div class="git-line">not a git repository</div>';
}

function renderServicesBlock(p) {
  if (!p.composeFilePresent) {
    return '<p class="git-line tag warn" style="display:block">No compose file at the current commit — "Return to latest" or pick a different commit.</p>';
  }
  if (!p.services.length) {
    return '<p class="git-line">No containers created yet.</p>';
  }
  const busyReason = p.running ? 'An operation is already running for this project' : '';
  const btn = (op, service, label, reason = busyReason) =>
    `<button class="small" type="button" data-action="${op === 'logs' ? 'logs' : 'container-op'}" data-op="${op}" data-service="${escapeHtml(service)}" ${gate(reason)}>${label}</button>`;
  return `<div class="table-wrap"><table class="services">
      <thead><tr><th>Service</th><th>Image</th><th>State</th><th>Image created</th><th></th></tr></thead>
      <tbody>
        ${p.services
          .map((s) => {
            const running = s.state === 'running';
            const stopReason = p.isSelf ? "The manager can't stop itself" : busyReason;
            return `<tr>
              <td>${escapeHtml(s.service)}</td>
              <td>${escapeHtml(s.image)}</td>
              <td>${escapeHtml(s.state)}</td>
              <td>${timeAgo(s.builtAt)}</td>
              <td class="row-actions">
                ${btn('logs', s.service, 'Logs', '')}
                ${running ? btn('restart', s.service, 'Restart') : ''}
                ${running ? btn('stop', s.service, 'Stop', stopReason) : btn('start', s.service, 'Start')}
              </td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table></div>`;
}

function renderContainerLogs(p) {
  const logs = state.containerLogs.get(p.name);
  if (!logs) return '';
  return `<div class="container-logs-head">
      <span>Logs — ${escapeHtml(logs.service ?? 'all services')}</span>
      <span>
        <button class="small" type="button" data-action="logs" data-service="${escapeHtml(logs.service ?? '')}">Refresh</button>
        <button class="small" type="button" data-action="close-logs">Close</button>
      </span>
    </div>
    <div class="log" data-role="container-logs">${escapeHtml(logs.text.trim() || '(no output)')}</div>`;
}

/** Why a git/compose action is unavailable, or '' if it's fine. Used for the button tooltip. */
function disabledReason(p, action) {
  if (p.running) return 'An operation is already running for this project';
  const git = p.git;
  if (action === 'rebuild') return p.composeFilePresent ? '' : 'No compose file at the current commit';
  if (!git) return 'Not a git repository';
  if (action === 'fetch') return '';
  if (action === 'rollback') return git.dirty ? 'Uncommitted changes — commit or discard first' : '';
  if (git.detached) return 'HEAD is detached — use "Return to latest" first';
  if (git.dirty) return 'Uncommitted changes — commit or discard first';
  return '';
}

/** disabled + title attributes for a button, given the reason it's unavailable. */
const gate = (reason) => (reason ? `disabled title="${escapeHtml(reason)}"` : '');

function renderRollbackSection(p) {
  const open = state.rollbackOpen.has(p.name);
  const busy = p.running;
  const canCheckout = p.git && !p.git.dirty && !busy;
  const history = state.history.get(p.name);

  if (!open) {
    return `<div class="actions">
      <button data-action="toggle-rollback" type="button" ${gate(disabledReason(p, 'rollback'))}>Roll back…</button>
    </div>`;
  }

  return `<div class="actions">
      <select data-role="history-select" ${canCheckout ? '' : 'disabled'}>
        <option value="">${history ? 'Pick a commit to roll back to…' : 'Click to load history…'}</option>
        ${(history ?? [])
          .map(
            (c) =>
              `<option value="${c.hash}" ${state.selectedCommit.get(p.name) === c.hash ? 'selected' : ''}>${c.hash} ${escapeHtml(
                truncate(c.message, 50),
              )}</option>`,
          )
          .join('')}
      </select>
      <button data-action="checkout" ${canCheckout ? '' : 'disabled'}>Roll back</button>
      <label class="toggle"><input type="checkbox" data-role="rebuild-after" ${busy ? 'disabled' : ''} ${
        state.rebuildAfter.has(p.name) ? 'checked' : ''
      }/> rebuild after</label>
      <button data-action="toggle-rollback" type="button">Hide</button>
    </div>`;
}

function renderContainerActions(p) {
  if (!p.composeFilePresent) return '';
  const running = p.services.filter((s) => s.state === 'running').length;
  const busy = p.running ? 'An operation is already running for this project' : '';
  const pick = (...reasons) => reasons.find(Boolean) ?? '';
  const btn = (op, label, reason) =>
    `<button type="button" data-action="container-op" data-op="${op}" data-service="" ${gate(reason)}>${label}</button>`;
  return `<div class="actions">
      ${btn('start', 'Start', pick(busy, p.isSelf && 'The manager is already running', running === p.services.length && p.services.length > 0 && 'All services are running'))}
      ${btn('restart', 'Restart', pick(busy, !running && 'Nothing is running'))}
      ${btn('stop', 'Stop', pick(busy, p.isSelf && "The manager can't stop itself", !running && 'Nothing is running'))}
      <button type="button" data-action="logs" data-service="">Logs</button>
    </div>
    ${renderContainerLogs(p)}`;
}

function renderCardBody(p) {
  const git = p.git;
  const log = state.logs.get(p.name);
  const busy = p.running;

  const canReattach = git?.detached && !busy;
  const hint = reasons(p);

  return `
      <div class="card-tools">
        <button class="kebab" data-action="menu" type="button" aria-label="More actions" aria-haspopup="menu" aria-expanded="${state.menuOpen === p.name}">⋮</button>
        ${
          state.menuOpen === p.name
            ? `<div class="menu" role="menu">
                <button role="menuitem" data-action="${p.dismissed ? 'restore' : 'dismiss'}" type="button">${
                  p.dismissed ? 'Restore to the dashboard' : 'Dismiss (dim and move to bottom)'
                }</button>
              </div>`
            : ''
        }
      </div>
      ${renderGitBlock(p)}
      ${renderServicesBlock(p)}
      <div class="actions">
        <button data-action="fetch" ${gate(disabledReason(p, 'fetch'))}>Check for Updates</button>
        <button data-action="pull" ${gate(disabledReason(p, 'pull'))}>Pull</button>
        <button class="primary" data-action="rebuild" ${gate(disabledReason(p, 'rebuild'))}>${
          state.pullFirst.has(p.name) ? 'Pull + Rebuild' : 'Rebuild'
        }</button>
        <label class="toggle"><input type="checkbox" data-role="pull-first" ${busy ? 'disabled' : ''} ${
          state.pullFirst.has(p.name) ? 'checked' : ''
        }/> pull first</label>
        ${canReattach ? '<button data-action="reattach">Return to latest</button>' : ''}
      </div>
      ${
        p.isSelf && !state.self.detected
          ? '<p class="git-line tag warn" style="display:block">This is the manager\'s own project, but its container couldn\'t be identified, so a rebuild here will tear down the container handling the request and may leave a stale container behind. Prefer <code>docker compose up -d --build</code> from the terminal.</p>'
          : ''
      }
      ${renderContainerActions(p)}
      ${p.git ? renderRollbackSection(p) : ''}
      ${hint.length ? `<p class="git-line">${hint.join(' · ')}</p>` : ''}
      ${log ? renderLog(log) : ''}
  `;
}

function renderCard(p) {
  const expanded = state.expanded.has(p.name);

  return `
    <section class="card ${p.dismissed ? 'dismissed' : ''}" data-project="${escapeHtml(p.name)}">
      <button class="card-header" data-action="toggle" type="button">
        <span class="card-title">
          <span class="chevron">${expanded ? '▾' : '▸'}</span>
          <h2>${escapeHtml(p.name)}</h2>
          ${p.isSelf ? '<span class="self-badge" title="This dashboard is running from this project">this manager</span>' : ''}
        </span>
        <span class="card-summary">
          <span class="summary-text">${escapeHtml(summaryText(p))}</span>
          ${p.git?.dirty ? '<span class="tag warn">dirty</span>' : ''}
          <span class="badge ${p.dismissed ? 'dismissed' : p.rollup}">${p.rollup}</span>
        </span>
      </button>
      ${expanded ? renderCardBody(p) : ''}
    </section>
  `;
}

// Most active first: running, then partially running, then down; name breaks ties.
const ROLLUP_ORDER = { up: 0, partial: 1, down: 2 };
const byActivity = (a, b) => ROLLUP_ORDER[a.rollup] - ROLLUP_ORDER[b.rollup] || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

function renderDashboardSummary(projects, dismissedCount) {
  if (!projects.length) return '';
  const counts = { up: 0, partial: 0, down: 0 };
  for (const p of projects) counts[p.rollup]++;
  return `<p class="dashboard-summary">${projects.length} projects · ${counts.up} up${
    counts.partial ? ` · ${counts.partial} partial` : ''
  }${counts.down ? ` · ${counts.down} down` : ''}${dismissedCount ? ` · ${dismissedCount} dismissed` : ''}</p>`;
}

function render() {
  const main = document.getElementById('projects');
  const all = [...state.projects.values()].sort(byActivity);
  const active = all.filter((p) => !p.dismissed);
  const dismissed = all.filter((p) => p.dismissed);
  main.innerHTML = all.length
    ? renderDashboardSummary(active, dismissed.length) +
      active.map(renderCard).join('') +
      (dismissed.length
        ? `<h3 class="section-title">Dismissed (${dismissed.length})</h3>${dismissed.map(renderCard).join('')}`
        : '')
    : '<p class="empty">No projects found under the configured root.</p>';

  if (state.scrollLogsFor) {
    const el = document.querySelector(`.card[data-project="${CSS.escape(state.scrollLogsFor)}"] [data-role="container-logs"]`);
    if (el) el.scrollTop = el.scrollHeight;
    state.scrollLogsFor = null;
  }
}

function appendLogLine(name, line) {
  const el = document.querySelector(`.card[data-project="${CSS.escape(name)}"] [data-role="log"]`);
  if (!el) {
    render();
    return;
  }
  const span = document.createElement('span');
  span.className = line.stream;
  span.textContent = `${line.text}\n`;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function closeStream(name) {
  const log = state.logs.get(name);
  if (log?.es) log.es.close();
}

function attachStream(name, { onDone, restartOnSuccess = false } = {}) {
  state.expanded.add(name); // so the log is visible without the user having to find and expand the card
  closeStream(name);
  const es = new EventSource(`/api/projects/${encodeURIComponent(name)}/stream`);
  const log = { lines: [], status: 'running', exitCode: null, es };
  state.logs.set(name, log);

  es.addEventListener('line', (e) => {
    const data = JSON.parse(e.data);
    log.lines.push(data);
    appendLogLine(name, data);
  });

  es.addEventListener('done', (e) => {
    const { status, exitCode } = JSON.parse(e.data);
    log.status = status;
    log.exitCode = exitCode;
    es.close();
    refresh();
    if (status === 'success' && restartOnSuccess) startRestart();
    if (status !== 'idle' && onDone) onDone(status);
  });

  es.onerror = () => {
    // EventSource retries automatically. But if this operation is replacing
    // our own container, a dropped stream most likely means we just died.
    if (restartOnSuccess) startRestart();
  };

  render();
}

async function refresh() {
  try {
    const projects = await fetchJSON('/api/projects');
    for (const p of projects) {
      state.projects.set(p.name, p);
      if (p.running && !state.logs.get(p.name)?.es) {
        attachStream(p.name);
      }
    }
    render();
  } catch (err) {
    console.error('refresh failed', err);
  }
}

async function onClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const card = e.target.closest('.card');
  const name = card.dataset.project;
  const action = btn.dataset.action;

  if (action === 'toggle') {
    state.expanded.has(name) ? state.expanded.delete(name) : state.expanded.add(name);
    saveExpanded();
    render();
    return;
  }
  if (action === 'menu') {
    state.menuOpen = state.menuOpen === name ? null : name;
    render();
    return;
  }
  if (action === 'dismiss' || action === 'restore') {
    state.menuOpen = null;
    try {
      await fetchJSON(`/api/projects/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
      state.expanded.delete(name);
      await refresh();
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if (action === 'close-logs') {
    state.containerLogs.delete(name);
    render();
    return;
  }
  if (action === 'logs') {
    const service = btn.dataset.service;
    try {
      const qs = service ? `?service=${encodeURIComponent(service)}` : '';
      const { text } = await fetchJSON(`/api/projects/${encodeURIComponent(name)}/logs${qs}`);
      state.containerLogs.set(name, { service: service || null, text });
      state.scrollLogsFor = name;
      render();
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if (action === 'container-op') {
    const { op, service } = btn.dataset;
    const target = service || 'all services in this project';
    const prompts = {
      stop: `Stop ${target}?`,
      restart: service ? '' : `Restart ${target}?`,
    };
    const selfRestart = op === 'restart' && state.projects.get(name)?.isSelf && state.self.detected;
    if (selfRestart && !confirm('Restart the manager itself? The dashboard will be unavailable for a short while.')) return;
    if (!selfRestart && prompts[op] && !confirm(prompts[op])) return;
    try {
      await fetchJSON(`/api/projects/${encodeURIComponent(name)}/containers/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: service || undefined }),
      });
      attachStream(name, { restartOnSuccess: selfRestart });
      await refresh();
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if (action === 'toggle-rollback') {
    state.rollbackOpen.has(name) ? state.rollbackOpen.delete(name) : state.rollbackOpen.add(name);
    render();
    return;
  }

  try {
    if (action === 'fetch') {
      await fetchJSON(`/api/projects/${encodeURIComponent(name)}/fetch`, { method: 'POST' });
      attachStream(name, {
        onDone: async (status) => {
          if (status !== 'success') return;
          const ab = await fetchJSON(`/api/projects/${encodeURIComponent(name)}/ahead-behind`);
          state.aheadBehind.set(name, ab);
          render();
        },
      });
    } else if (action === 'pull') {
      await fetchJSON(`/api/projects/${encodeURIComponent(name)}/pull`, { method: 'POST' });
      attachStream(name);
    } else if (action === 'rebuild') {
      const pull = state.pullFirst.has(name);
      const isSelf = state.projects.get(name)?.isSelf && state.self.detected;
      if (isSelf && !confirm('Rebuild and restart the manager itself? The dashboard will be unavailable for a short while.')) return;
      await fetchJSON(`/api/projects/${encodeURIComponent(name)}/rebuild`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pull }),
      });
      state.pullFirst.delete(name);
      attachStream(name, { restartOnSuccess: isSelf });
    } else if (action === 'checkout') {
      const hash = state.selectedCommit.get(name);
      if (!hash) {
        alert('Pick a commit from the dropdown first.');
        return;
      }
      const rebuild = state.rebuildAfter.has(name);
      await fetchJSON(`/api/projects/${encodeURIComponent(name)}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash, rebuild }),
      });
      state.selectedCommit.delete(name);
      state.rebuildAfter.delete(name);
      attachStream(name, { restartOnSuccess: rebuild && state.projects.get(name)?.isSelf && state.self.detected });
    } else if (action === 'reattach') {
      await fetchJSON(`/api/projects/${encodeURIComponent(name)}/reattach`, { method: 'POST' });
      attachStream(name);
    }
    await refresh();
  } catch (err) {
    alert(err.message);
  }
}

function onChange(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  const name = card.dataset.project;

  if (e.target.matches('[data-role="history-select"]')) {
    state.selectedCommit.set(name, e.target.value);
  } else if (e.target.matches('[data-role="pull-first"]')) {
    e.target.checked ? state.pullFirst.add(name) : state.pullFirst.delete(name);
    const rebuild = card.querySelector('[data-action="rebuild"]');
    if (rebuild) rebuild.textContent = e.target.checked ? 'Pull + Rebuild' : 'Rebuild';
  } else if (e.target.matches('[data-role="rebuild-after"]')) {
    e.target.checked ? state.rebuildAfter.add(name) : state.rebuildAfter.delete(name);
  }
}

async function onFocusIn(e) {
  const select = e.target.closest('[data-role="history-select"]');
  if (!select) return;
  const name = select.closest('.card').dataset.project;
  if (state.history.has(name)) return;
  try {
    const history = await fetchJSON(`/api/projects/${encodeURIComponent(name)}/history`);
    state.history.set(name, history);
    render();
  } catch (err) {
    console.error('history load failed', err);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One health probe with a short timeout, so a half-dead host can't stall the loop. */
async function probeHealth(timeoutMs = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Replaces the dashboard with a countdown while the manager's own container
 * is replaced, polling /api/health until the *new* instance answers (a
 * different bootId, or any answer after we've seen the host go away), then
 * reloads straight into the manager. The countdown is only an estimate: if
 * it runs out we keep polling and say so.
 */
async function startRestart() {
  if (state.restarting) return;
  state.restarting = true;
  for (const log of state.logs.values()) log.es?.close();

  const overlay = document.getElementById('restart-overlay');
  const deadline = Date.now() + RESTART_COUNTDOWN_S * 1000;
  overlay.hidden = false;

  const paint = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const pct = Math.min(100, ((RESTART_COUNTDOWN_S - left) / RESTART_COUNTDOWN_S) * 100);
    overlay.innerHTML = `
      <div class="restart-box">
        <h2>Restarting the manager…</h2>
        <div class="restart-count">${left > 0 ? left : '…'}</div>
        <div class="restart-bar"><span style="width:${pct}%"></span></div>
        <p>${
          left > 0
            ? 'Rebuilding and restarting. You’ll be taken back automatically once it’s up.'
            : 'Taking longer than expected — still checking. A long build is normal; if it keeps going, the rebuild may have failed.'
        }</p>
        ${left > 0 ? '' : '<button type="button" data-action="dismiss-restart">Back to the dashboard</button>'}
      </div>`;
  };
  paint();
  const ticker = setInterval(paint, 1000);
  overlay.onclick = (e) => {
    if (!e.target.closest('[data-action="dismiss-restart"]')) return;
    state.restarting = false;
    clearInterval(ticker);
    overlay.hidden = true;
    refresh();
  };

  let sawDown = false;
  while (state.restarting) {
    const health = await probeHealth();
    if (!health) {
      sawDown = true;
    } else if (health.bootId !== state.self.bootId || sawDown) {
      clearInterval(ticker);
      location.reload();
      return;
    }
    await sleep(500);
  }
}

function renderSelfBanner() {
  const el = document.getElementById('self-banner');
  const u = state.selfUpdate;
  const show = state.self.detected && u?.available && state.selfUpdateDismissed !== u.behind;
  el.hidden = !show;
  if (!show) return;
  el.innerHTML = `
    <span>Manager update available — ${u.behind} new commit${u.behind === 1 ? '' : 's'} upstream.</span>
    <span class="self-banner-actions">
      <button class="primary" type="button" data-action="self-update">Update &amp; restart</button>
      <button type="button" data-action="self-dismiss">Later</button>
    </span>`;
}

async function checkSelfUpdate({ force = false } = {}) {
  if (!state.self.detected || state.restarting) return;
  if (!force && (document.hidden || Date.now() - state.selfCheckedAt < state.selfCheckIntervalMs - 1000)) return;
  state.selfCheckedAt = Date.now();
  try {
    state.selfUpdate = await fetchJSON('/api/self/check', { method: 'POST' });
    renderSelfBanner();
  } catch (err) {
    console.error('self update check failed', err);
  }
}

async function onSelfBannerClick(e) {
  const action = e.target.closest('button[data-action]')?.dataset.action;
  if (action === 'self-dismiss') {
    state.selfUpdateDismissed = state.selfUpdate.behind;
    renderSelfBanner();
  } else if (action === 'self-update') {
    if (!confirm('Pull the latest changes and restart the manager? The dashboard will be unavailable for a short while.')) return;
    try {
      const { project } = await fetchJSON('/api/self/update', { method: 'POST' });
      attachStream(project, { restartOnSuccess: true });
      document.getElementById('self-banner').hidden = true;
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  }
}

async function init() {
  document.getElementById('self-banner').addEventListener('click', onSelfBannerClick);
  const projectsEl = document.getElementById('projects');
  projectsEl.addEventListener('click', onClick);
  projectsEl.addEventListener('change', onChange);
  projectsEl.addEventListener('focusin', onFocusIn);
  document.addEventListener('click', (e) => {
    if (state.menuOpen && !e.target.closest('.card-tools')) {
      state.menuOpen = null;
      render();
    }
  });

  try {
    const cfg = await fetchJSON('/api/config');
    state.pollIntervalMs = cfg.pollIntervalMs;
    state.selfCheckIntervalMs = cfg.selfCheckIntervalMs ?? state.selfCheckIntervalMs;
  } catch {
    /* fall back to default pollIntervalMs */
  }
  try {
    state.self = await fetchJSON('/api/self');
  } catch {
    /* treated as "not self-aware"; plain behavior */
  }

  await refresh();
  setInterval(refresh, state.pollIntervalMs);

  // Update checks only run while a session is actually open and visible.
  checkSelfUpdate({ force: true });
  setInterval(checkSelfUpdate, 30000);
  document.addEventListener('visibilitychange', () => checkSelfUpdate());
}

init();
