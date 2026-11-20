const $ = (id) => document.getElementById(id);
const THINKING = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
let roster = { version: 1, models: [] };
let catalog = [];
// 'unloaded' → 'clean' ⇄ 'dirty' ⇄ 'saving'. Saving replaces the whole KV document: never save over a roster we couldn't load.
let rosterState = 'unloaded';
// Bumped on every edit, so a save that finishes after more edits leaves the roster dirty.
let revision = 0;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function api(path, init) {
  const res = await fetch(`/admin/api${path}`, { ...init, headers: { 'content-type': 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

function flash(message, isError = false) {
  const node = $('flash');
  node.textContent = message;
  node.className = 'flash' + (isError ? ' error' : '');
  node.hidden = false;
}

function setRosterState(state) {
  rosterState = state;
  $('add').disabled = state === 'unloaded';
  $('save').disabled = state !== 'dirty';
}

function edited() {
  revision++;
  if (rosterState !== 'saving') setRosterState('dirty');
  renderRoster();
}

const unsaved = () => rosterState === 'dirty' || rosterState === 'saving';

// ── Roster ───────────────────────────────────────────────────────────────────

function renderRoster() {
  $('models').replaceChildren(...roster.models.map((m, i) => {
    const update = (patch) => { roster.models[i] = { ...roster.models[i], ...patch }; edited(); };
    const thinking = el('select', { onchange: (e) => update({ thinkingLevel: e.target.value || undefined }) },
      ...THINKING.map(t => el('option', { value: t, textContent: t || 'default', selected: (m.thinkingLevel ?? '') === t })));
    return el('tr', { className: m.enabled ? '' : 'off' },
      el('td', {}, el('input', { type: 'checkbox', className: 'trial-pick', value: m.id, ariaLabel: `include ${m.label} in trial` })),
      el('td', { className: 'id', textContent: m.id }),
      el('td', {}, el('input', { type: 'text', value: m.label, onchange: (e) => update({ label: e.target.value.trim() || m.id }) })),
      el('td', {}, el('input', { type: 'checkbox', checked: m.enabled, onchange: (e) => update({ enabled: e.target.checked }) })),
      el('td', {}, el('input', { type: 'checkbox', checked: !!m.vision, onchange: (e) => update({ vision: e.target.checked }) })),
      el('td', {}, thinking),
      el('td', {}, el('button', { type: 'button', className: 'link', textContent: 'remove', onclick: () => {
        roster.models.splice(i, 1); edited(); renderCatalog();
      } })),
    );
  }));
}

function renderCatalog() {
  const have = new Set(roster.models.map(m => m.id));
  const options = catalog
    .filter(c => !have.has(c.id))
    .sort((a, b) => Number(b.functionCalling) - Number(a.functionCalling) || a.id.localeCompare(b.id))
    .map(c => {
      const notes = [c.source === 'ai-gateway' && 'AI Gateway, BYOK', c.source === 'chatgpt' && 'ChatGPT plan', c.functionCalling ? 'tools' : 'no tools',
        c.vision && 'vision', c.reasoning && 'reasoning', c.deprecates && `deprecates ${c.deprecates}`].filter(Boolean).join(', ');
      return el('option', { value: c.id, textContent: `${c.id} (${notes})` });
    });
  $('catalog').replaceChildren(el('option', { value: '', textContent: 'Choose a model…' }), ...options);
}

$('catalog').addEventListener('change', () => {
  const id = $('catalog').value;
  $('add-label').value = id ? id.split('/').pop() : '';
});


$('add').addEventListener('click', () => {
  const id = $('catalog').value;
  if (!id) return flash('Pick a model to add.', true);
  const info = catalog.find(c => c.id === id);
  roster.models.push({ id, label: $('add-label').value.trim() || id, enabled: true, vision: !!info?.vision });
  $('add-label').value = '';
  edited(); renderCatalog();
});

$('save').addEventListener('click', async () => {
  const saving = revision;
  setRosterState('saving');
  try {
    const clean = { version: 1, models: roster.models.map(({ thinkingLevel, ...m }) => thinkingLevel ? { ...m, thinkingLevel } : m) };
    const saved = await api('/models', { method: 'PUT', body: JSON.stringify(clean) });
    // Edits made while saving stay local and unsaved; otherwise take the server's copy.
    if (revision === saving) { roster = saved; setRosterState('clean'); renderRoster(); } else setRosterState('dirty');
    flash(`Saved ${saved.models.length} models (${saved.models.filter(m => m.enabled).length} enabled).`);
  } catch (e) {
    setRosterState('dirty');
    flash(`Save failed: ${e.message}`, true);
  }
});

window.addEventListener('beforeunload', (e) => { if (unsaved()) e.preventDefault(); });

// ── Runs ─────────────────────────────────────────────────────────────────────

// POST a run with its button disabled while in flight. Runs read the saved roster.
async function startRun(button, body, describe) {
  if (unsaved()) return flash('Save the roster first: runs read the saved roster.', true);
  button.disabled = true;
  try {
    flash(describe(await api('/runs', { method: 'POST', body: JSON.stringify(body) })));
    loadBatches();
  } catch (e) {
    flash(`Run failed: ${e.message}`, true);
  } finally {
    button.disabled = false;
  }
}

$('run-trial').addEventListener('click', (e) => {
  const models = [...document.querySelectorAll('.trial-pick:checked')].map(c => c.value);
  startRun(e.currentTarget, { kind: 'trial', models },
    (r) => `Started trial ${r.batch} (${models.length || 'all enabled'} model${models.length === 1 ? '' : 's'}).`);
});

$('run-day-btn').addEventListener('click', (e) => {
  const day = $('run-day').value;
  if (!unsaved() && !confirm(`Start the ranked batch for ${day}? It counts on the leaderboard.`)) return;
  startRun(e.currentTarget, { kind: 'day', day },
    (r) => r.accepted ? `Started ${r.batch}.` : `${r.batch} already exists; nothing started.`);
});

// ── Batches ──────────────────────────────────────────────────────────────────

async function showBatch(li, name) {
  const existing = li.querySelector('table');
  if (existing) return existing.remove();
  // A second click while loading would append a second table.
  if (li.dataset.loading) return;
  li.dataset.loading = 'true';
  try {
    const b = await api(`/batch?name=${encodeURIComponent(name)}`);
    const rows = b.runs.map(r => el('tr', {},
      el('td', { className: 'id', textContent: r.modelId }),
      el('td', { textContent: `#${r.attempt}` }),
      el('td', { textContent: r.status }),
      el('td', { textContent: r.totalScore ?? '–' })));
    li.append(el('table', { className: 'admin-table' },
      el('thead', {}, el('tr', {}, ...['Model', 'Try', 'Status', 'Score'].map(h => el('th', { textContent: h })))),
      el('tbody', {}, ...rows)));
    li.querySelector('.tag.phase').textContent = b.phase ?? 'starting';
  } catch (e) {
    flash(`Couldn't load ${name}: ${e.message}`, true);
  } finally {
    delete li.dataset.loading;
  }
}

// Refresh and post-run reloads can overlap; only the latest one renders.
let batchesRequest = 0;
async function loadBatches() {
  const request = ++batchesRequest;
  try {
    const batches = await api('/batches');
    if (request !== batchesRequest) return;
    $('batches').replaceChildren(...(batches.length ? batches.map(b => {
      const li = el('li');
      li.append(el('div', { className: 'batch-head' },
        el('button', { type: 'button', className: 'link name', textContent: b.batch, onclick: () => showBatch(li, b.batch) }),
        el('span', { className: 'tag', textContent: b.trial ? 'trial' : 'ranked' }),
        el('span', { className: 'tag', textContent: `by ${b.createdBy ?? '?'}` }),
        el('span', { className: 'tag', textContent: new Date(b.createdAt).toLocaleString() }),
        el('span', { className: 'tag phase', textContent: '' })));
      return li;
    }) : [el('li', { className: 'hint', textContent: 'No batches yet.' })]));
  } catch (e) {
    if (request === batchesRequest) flash(`Couldn't load batches: ${e.message}`, true);
  }
}
$('refresh').addEventListener('click', loadBatches);

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Today in New York, Krillion's day boundary.
  $('run-day').value = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  try {
    const me = await api('/me');
    $('who').textContent = `Signed in as ${me.email}`;
  } catch (e) { $('who').textContent = `Not authorized: ${e.message}`; return; }
  // Independent loads, started together.
  api('/models').then((loaded) => {
    roster = loaded;
    setRosterState('clean');
    renderRoster();
    renderCatalog();
  }, (e) => flash(`Couldn't load roster: ${e.message}`, true));
  api('/catalog').then((loaded) => {
    catalog = loaded;
    renderCatalog();
  }, (e) => flash(`Couldn't load catalog: ${e.message}`, true));
  loadBatches();
}
init();
