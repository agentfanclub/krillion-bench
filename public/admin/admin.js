const $ = (id) => document.getElementById(id);
const THINKING = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
let roster = { version: 1, models: [] };
let catalog = [];
let dirty = false;
// Saving replaces the whole KV document: never save over a roster we couldn't load.
let rosterLoaded = false;

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

function markDirty() {
  dirty = true;
  $('save').disabled = false;
}

// ── Roster ───────────────────────────────────────────────────────────────────

function renderRoster() {
  $('models').replaceChildren(...roster.models.map((m, i) => {
    const update = (patch) => { roster.models[i] = { ...roster.models[i], ...patch }; markDirty(); renderRoster(); };
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
        roster.models.splice(i, 1); markDirty(); renderRoster(); renderCatalog();
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
      const notes = [c.source === 'ai-gateway' && 'AI Gateway, BYOK', c.functionCalling ? 'tools' : 'no tools',
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
  if (!rosterLoaded) return flash('The roster did not load; fix it before editing.', true);
  if (!id) return flash('Pick a model to add.', true);
  const info = catalog.find(c => c.id === id);
  roster.models.push({ id, label: $('add-label').value.trim() || id, enabled: true, vision: !!info?.vision });
  $('add-label').value = '';
  markDirty(); renderRoster(); renderCatalog();
});

$('save').addEventListener('click', async () => {
  if (!rosterLoaded) return flash('The roster did not load; fix it before saving.', true);
  try {
    const clean = { version: 1, models: roster.models.map(({ thinkingLevel, ...m }) => thinkingLevel ? { ...m, thinkingLevel } : m) };
    roster = await api('/models', { method: 'PUT', body: JSON.stringify(clean) });
    dirty = false; $('save').disabled = true;
    renderRoster();
    flash(`Saved ${roster.models.length} models (${roster.models.filter(m => m.enabled).length} enabled).`);
  } catch (e) { flash(`Save failed: ${e.message}`, true); }
});

window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

// ── Runs ─────────────────────────────────────────────────────────────────────

$('run-trial').addEventListener('click', async () => {
  if (dirty) return flash('Save the roster first: runs read the saved roster.', true);
  const models = [...document.querySelectorAll('.trial-pick:checked')].map(c => c.value);
  try {
    const r = await api('/runs', { method: 'POST', body: JSON.stringify({ kind: 'trial', models }) });
    flash(`Started trial ${r.batch} (${models.length || 'all enabled'} model${models.length === 1 ? '' : 's'}).`);
    loadBatches();
  } catch (e) { flash(`Trial failed: ${e.message}`, true); }
});

$('run-day-btn').addEventListener('click', async () => {
  if (dirty) return flash('Save the roster first: runs read the saved roster.', true);
  const day = $('run-day').value;
  if (!confirm(`Start the ranked batch for ${day}? It counts on the leaderboard.`)) return;
  try {
    const r = await api('/runs', { method: 'POST', body: JSON.stringify({ kind: 'day', day }) });
    flash(r.accepted ? `Started ${r.batch}.` : `${r.batch} already exists; nothing started.`);
    loadBatches();
  } catch (e) { flash(`Run failed: ${e.message}`, true); }
});

// ── Batches ──────────────────────────────────────────────────────────────────

async function showBatch(li, name) {
  const existing = li.querySelector('table');
  if (existing) return existing.remove();
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
  } catch (e) { flash(`Couldn't load ${name}: ${e.message}`, true); }
}

async function loadBatches() {
  try {
    const batches = await api('/batches');
    $('batches').replaceChildren(...batches.map(b => {
      const li = el('li');
      li.append(el('div', { className: 'batch-head' },
        el('button', { type: 'button', className: 'link name', textContent: b.batch, onclick: () => showBatch(li, b.batch) }),
        el('span', { className: 'tag', textContent: b.trial ? 'trial' : 'ranked' }),
        el('span', { className: 'tag', textContent: `by ${b.createdBy ?? '?'}` }),
        el('span', { className: 'tag', textContent: new Date(b.createdAt).toLocaleString() }),
        el('span', { className: 'tag phase', textContent: '' })));
      return li;
    }));
    if (!batches.length) $('batches').append(el('li', { className: 'hint', textContent: 'No batches yet.' }));
  } catch (e) { flash(`Couldn't load batches: ${e.message}`, true); }
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
  try {
    roster = await api('/models');
    rosterLoaded = true;
    renderRoster();
  } catch (e) { flash(`Couldn't load roster: ${e.message}`, true); }
  try {
    catalog = await api('/catalog');
    renderCatalog();
  } catch (e) { flash(`Couldn't load catalog: ${e.message}`, true); }
  loadBatches();
}
init();
