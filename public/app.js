const state = {
  pollIntervalMs: 15000,
  projects: new Map(), // name -> latest status
  aheadBehind: new Map(), // name -> { ahead, behind, checkedAt }
  history: new Map(), // name -> commit list
  logs: new Map(), // name -> { lines, status, exitCode, es }
  selectedCommit: new Map(), // name -> hash chosen in the rollback dropdown
  pullFirst: new Set(), // names with "pull first" checked
  rebuildAfter: new Set(), // names with "rebuild after" checked
  expanded: new Set(), // names showing full detail instead of the one-line summary
  rollbackOpen: new Set(), // names showing the rollback controls within an expanded card
};

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
    if (p.git.dirty) parts.push('dirty');
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
  return `<table class="services">
      <thead><tr><th>Service</th><th>Image</th><th>State</th><th>Built</th></tr></thead>
      <tbody>
        ${p.services
          .map(
            (s) => `<tr>
              <td>${escapeHtml(s.service)}</td>
              <td>${escapeHtml(s.image)}</td>
              <td>${escapeHtml(s.state)}</td>
              <td>${timeAgo(s.builtAt)}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
}

function renderRollbackSection(p) {
  const open = state.rollbackOpen.has(p.name);
  const busy = p.running;
  const canCheckout = p.git && !p.git.dirty && !busy;
  const history = state.history.get(p.name);

  if (!open) {
    return `<div class="actions">
      <button data-action="toggle-rollback" type="button">Roll back…</button>
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

function renderCardBody(p) {
  const git = p.git;
  const log = state.logs.get(p.name);
  const busy = p.running;

  const canFetch = git && !busy;
  const canPull = git && !git.detached && !git.dirty && !busy;
  const canReattach = git?.detached && !busy;
  const hint = reasons(p);

  return `
      ${renderGitBlock(p)}
      ${renderServicesBlock(p)}
      <div class="actions">
        <button data-action="fetch" ${canFetch ? '' : 'disabled'}>Check for Updates</button>
        <button data-action="pull" ${canPull ? '' : 'disabled'}>Pull</button>
        <button class="primary" data-action="rebuild" ${busy || !p.composeFilePresent ? 'disabled' : ''}>Rebuild</button>
        <label class="toggle"><input type="checkbox" data-role="pull-first" ${busy ? 'disabled' : ''} ${
          state.pullFirst.has(p.name) ? 'checked' : ''
        }/> pull first</label>
        ${canReattach ? '<button data-action="reattach">Return to latest</button>' : ''}
      </div>
      ${
        p.isSelf
          ? '<p class="git-line tag warn" style="display:block">This is the manager\'s own project — rebuilding it here tears down the container handling this request, which can leave a stale container behind if interrupted. Prefer running <code>docker compose up -d --build</code> from the terminal for this one.</p>'
          : ''
      }
      ${renderRollbackSection(p)}
      ${hint.length ? `<p class="git-line">${hint.join(' · ')}</p>` : ''}
      ${log ? renderLog(log) : ''}
  `;
}

function renderCard(p) {
  const expanded = state.expanded.has(p.name);

  return `
    <section class="card" data-project="${escapeHtml(p.name)}">
      <button class="card-header" data-action="toggle" type="button">
        <span class="card-title">
          <span class="chevron">${expanded ? '▾' : '▸'}</span>
          <h2>${escapeHtml(p.name)}</h2>
        </span>
        <span class="card-summary">
          ${!expanded ? `<span class="summary-text">${escapeHtml(summaryText(p))}</span>` : ''}
          <span class="badge ${p.rollup}">${p.rollup}</span>
        </span>
      </button>
      ${expanded ? renderCardBody(p) : ''}
    </section>
  `;
}

function renderDashboardSummary() {
  const projects = [...state.projects.values()];
  if (!projects.length) return '';
  const counts = { up: 0, partial: 0, down: 0 };
  for (const p of projects) counts[p.rollup]++;
  return `<p class="dashboard-summary">${projects.length} projects · ${counts.up} up${
    counts.partial ? ` · ${counts.partial} partial` : ''
  }${counts.down ? ` · ${counts.down} down` : ''}</p>`;
}

function render() {
  const main = document.getElementById('projects');
  const projects = [...state.projects.values()];
  main.innerHTML = projects.length
    ? renderDashboardSummary() + projects.map(renderCard).join('')
    : '<p class="empty">No projects found under the configured root.</p>';
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

function attachStream(name, { onDone } = {}) {
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
    if (status !== 'idle' && onDone) onDone(status);
  });

  es.onerror = () => {
    /* EventSource retries automatically; nothing to do here */
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
    render();
    return;
  }
  if (action === 'toggle-rollback') {
    state.rollbackOpen.has(name) ? state.rollbackOpen.delete(name) : state.rollbackOpen.add(name);
    render();
    return;
  }

  try {
    if (action === 'fetch') {
      await fetchJSON(`/api/projects/${name}/fetch`, { method: 'POST' });
      attachStream(name, {
        onDone: async (status) => {
          if (status !== 'success') return;
          const ab = await fetchJSON(`/api/projects/${name}/ahead-behind`);
          state.aheadBehind.set(name, ab);
          render();
        },
      });
    } else if (action === 'pull') {
      await fetchJSON(`/api/projects/${name}/pull`, { method: 'POST' });
      attachStream(name);
    } else if (action === 'rebuild') {
      const pull = state.pullFirst.has(name);
      await fetchJSON(`/api/projects/${name}/rebuild`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pull }),
      });
      state.pullFirst.delete(name);
      attachStream(name);
    } else if (action === 'checkout') {
      const hash = state.selectedCommit.get(name);
      if (!hash) {
        alert('Pick a commit from the dropdown first.');
        return;
      }
      const rebuild = state.rebuildAfter.has(name);
      await fetchJSON(`/api/projects/${name}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash, rebuild }),
      });
      state.selectedCommit.delete(name);
      state.rebuildAfter.delete(name);
      attachStream(name);
    } else if (action === 'reattach') {
      await fetchJSON(`/api/projects/${name}/reattach`, { method: 'POST' });
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
    const history = await fetchJSON(`/api/projects/${name}/history`);
    state.history.set(name, history);
    render();
  } catch (err) {
    console.error('history load failed', err);
  }
}

async function init() {
  const projectsEl = document.getElementById('projects');
  projectsEl.addEventListener('click', onClick);
  projectsEl.addEventListener('change', onChange);
  projectsEl.addEventListener('focusin', onFocusIn);

  try {
    const cfg = await fetchJSON('/api/config');
    state.pollIntervalMs = cfg.pollIntervalMs;
  } catch {
    /* fall back to default pollIntervalMs */
  }

  await refresh();
  setInterval(refresh, state.pollIntervalMs);
}

init();
