const $ = (id) => document.getElementById(id);
// Krillion's own share emojis, one per tier; ⬛ is a miss (timed out or never reached).
const labels = { '🌟': 'one in a krillion', '🏮': 'deep cut', '🦑': 'rare', '🐟': 'schooler', '🤡': 'too clever', '🫧': 'plankton', '⬛': 'miss' };
let results = [];
let showAll = false;
// Rows shown before the Show All button.
const LIMIT = 15;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function slot(emoji) {
  const miss = emoji === '⬛';
  const node = el('span', 'slot' + (miss ? ' empty' : ''), miss ? '' : emoji);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

const missText = { timed_out: 'timed out', not_reached: 'not reached' };

// The model's answer to each prompt, shown when the row is expanded.
function answers(result) {
  const list = el('ol', 'answers');
  (result.answers || []).forEach((a, i) => {
    const item = el('li', 'answer');
    const emoji = result.emojis[i] || '⬛';
    const text = el('div', 'answer-text');
    text.append(el('span', 'prompt', a.prompt));
    const given = a.answer ?? missText[a.outcome] ?? a.outcome;
    text.append(el('span', 'given' + (a.outcome === 'accepted' ? '' : ' missed'), given));
    const tries = a.attempts > 1 ? ` · ${a.attempts} tries` : '';
    text.append(el('span', 'tier', `${labels[emoji] || 'unknown'}${tries}`));
    item.append(slot(emoji), text, el('span', 'points', `+${a.score}`));
    list.append(item);
  });
  if (!list.children.length) list.append(el('li', 'answer none', 'No answers recorded.'));
  return list;
}

const roundResults = () => results.filter(r => String(r.round) === $('round').value);

// Histogram of the round's scores in 50-point bins (700 is the max).
function renderChart(day) {
  $('chart').hidden = day.length === 0;
  if (!day.length) return;
  const width = 50;
  const bins = Array.from({ length: 14 }, () => []);
  for (const r of day) bins[Math.min(13, Math.floor(r.score / width))].push(r);
  const peak = Math.max(...bins.map(b => b.length));
  const scores = day.map(r => r.score).sort((a, b) => a - b);
  const mid = scores.length >> 1;
  const median = scores.length % 2 ? scores[mid] : Math.round((scores[mid - 1] + scores[mid]) / 2);
  $('chart-stat').textContent = `median ${median} · best ${scores[scores.length - 1]}`;

  const tip = $('chart-tip');
  const reset = () => { tip.innerHTML = '&nbsp;'; };
  $('bars').replaceChildren(...bins.map((bin, i) => {
    const lo = i * width, hi = i === 13 ? 700 : lo + width - 1;
    const text = `${lo}–${hi}: ${bin.length} model${bin.length === 1 ? '' : 's'}`;
    const col = el('div', 'bar' + (bin.length ? '' : ' zero'));
    col.setAttribute('role', 'img');
    col.setAttribute('aria-label', text);
    col.tabIndex = bin.length ? 0 : -1;
    const fill = el('span', 'fill');
    fill.style.height = bin.length ? `${Math.max(4, (bin.length / peak) * 100)}%` : '0';
    col.append(fill);
    const show = () => {
      const names = bin.slice(0, 3).map(r => r.model).join(', ') + (bin.length > 3 ? ` +${bin.length - 3}` : '');
      tip.textContent = bin.length ? `${text} · ${names}` : text;
    };
    col.addEventListener('mouseenter', show);
    col.addEventListener('focus', show);
    col.addEventListener('mouseleave', reset);
    col.addEventListener('blur', reset);
    return col;
  }));
  reset();
}

function showQuestion(item) {
  if (item.classList.contains('shown')) return;
  item.classList.add('shown');
  const prompt = item.querySelector('.pick-prompt');
  prompt.classList.remove('redacted');
  prompt.removeAttribute('aria-label');
  prompt.style.width = '';
  prompt.textContent = item.dataset.prompt;
}

// Per prompt, the accepted answer the most models gave (case-insensitive). Misses are skipped.
function renderCommon(day) {
  const prompts = [];
  for (const r of day) {
    (r.answers || []).forEach((a, i) => {
      const p = prompts[i] ??= { prompt: a.prompt, counts: new Map() };
      if (a.outcome !== 'accepted' || !a.answer || !a.answer.trim()) return;
      const key = a.answer.trim().toLowerCase();
      const entry = p.counts.get(key) ?? { answer: a.answer.trim(), n: 0, emoji: r.emojis[i] };
      entry.n++;
      p.counts.set(key, entry);
    });
  }
  $('common').hidden = prompts.length === 0;
  $('common-note').textContent = `Spoilers for Krillion #${$('round').value}. Click a row to see the question and the answer the most models gave.`;
  $('show-questions').hidden = false;
  $('picks').replaceChildren(...prompts.map((p, i) => {
    const item = el('li', 'pick');
    const details = el('details');
    const summary = el('summary', 'pick-line');
    // The question stays redacted until the row is opened.
    const prompt = el('span', 'pick-prompt redacted');
    prompt.style.width = `${Math.min(100, 20 + p.prompt.length * 0.6)}%`;
    prompt.setAttribute('aria-label', 'Hidden question');
    summary.append(el('span', 'pick-num', `Q${i + 1}`), prompt, el('span', 'pick-toggle', ''));
    details.addEventListener('toggle', () => { if (details.open) showQuestion(item); });
    item.dataset.prompt = p.prompt;
    details.append(summary);
    const entries = [...p.counts.values()];
    const top = Math.max(0, ...entries.map(e => e.n));
    const body = el('div', 'pick-body');
    if (!top) body.append(el('span', 'given missed', 'No accepted answers.'));
    else {
      const winners = entries.filter(e => e.n === top);
      const total = entries.reduce((sum, e) => sum + e.n, 0);
      for (const w of winners) {
        const row = el('div', 'pick-answer');
        row.append(slot(w.emoji || '⬛'), el('span', 'given', w.answer));
        body.append(row);
      }
      body.append(el('span', 'tier', `${top} of ${total} accepted answers${winners.length > 1 ? ' · tied' : ''}`));
    }
    details.append(body);
    item.append(details);
    return item;
  }));
}

function render() {
  const query = $('search').value.trim().toLowerCase();
  const day = roundResults();
  const visible = [...day].sort((a, b) => b.score - a.score).filter(r => r.model.toLowerCase().includes(query));
  if ($('sort').value === 'asc') visible.sort((a, b) => a.score - b.score);
  if ($('sort').value === 'name') visible.sort((a, b) => a.model.localeCompare(b.model));
  // A search shows every match; otherwise cap the list until Show All.
  const capped = !query && !showAll && visible.length > LIMIT + 3;
  const shown = capped ? visible.slice(0, LIMIT) : visible;
  const more = $('more');
  more.hidden = query !== '' || visible.length <= LIMIT + 3;
  more.textContent = capped ? `Show all ${visible.length}` : `Show top ${LIMIT}`;
  more.setAttribute('aria-expanded', String(!capped));

  $('results').replaceChildren(...shown.map(result => {
    // Rank within the result's own day, as the server ranked it.
    const rank = result.rank;
    // The top five get the big rows; everyone below is compact.
    const row = el('li', 'row' + (rank === 1 ? ' first' : '') + (rank > 5 ? ' compact' : ''));
    const details = el('details');
    const summary = el('summary', 'line');
    summary.append(el('span', 'rank', `#${rank}`));

    const who = el('div', 'who');
    who.append(el('span', 'model', result.model), el('span', 'model-id', result.modelId));
    summary.append(who);

    const slots = el('div', 'slots');
    slots.setAttribute('role', 'img');
    slots.setAttribute('aria-label', result.emojis.map(e => labels[e] || 'unknown').join(', '));
    for (const emoji of result.emojis) slots.append(slot(emoji));
    summary.append(slots, el('span', 'score', String(result.score)));
    details.append(summary, answers(result));
    row.append(details);
    return row;
  }));

  $('empty').hidden = visible.length !== 0 || results.length === 0;
  $('result-count').textContent = `${visible.length} result${visible.length === 1 ? '' : 's'}`;
}

function renderRound() {
  showAll = false;
  const day = roundResults();
  renderChart(day);
  renderCommon(day);
  render();
}

$('search').addEventListener('input', render);
$('sort').addEventListener('change', render);
$('round').addEventListener('change', renderRound);
$('show-questions').addEventListener('click', () => {
  for (const item of $('picks').children) showQuestion(item);
  $('show-questions').hidden = true;
});
$('more').addEventListener('click', () => {
  const collapsing = showAll;
  showAll = !showAll;
  render();
  if (collapsing) $('results').lastElementChild?.scrollIntoView({ block: 'nearest' });
});

async function init() {
  try {
    const response = await fetch('/api/scores', { cache: 'no-store' });
    if (!response.ok) throw new Error(`/api/scores returned ${response.status}`);
    const data = await response.json();
    results = data.results;
    const valid = r => typeof r.model === 'string' && Number.isFinite(r.score) && r.score >= 0 && Number.isInteger(r.round)
      && Number.isInteger(r.rank) && Array.isArray(r.emojis) && r.emojis.length === 7;
    if (!results.every(valid)) throw new Error('Invalid score data');

    const rounds = [...new Set(results.map(r => r.round))].sort((a, b) => b - a);
    for (const round of rounds) $('round').append(Object.assign(el('option', '', `#${round}`), { value: round }));
    // Default to the latest day; one round needs no filter.
    if (rounds.length) $('round').value = String(rounds[0]);
    $('round').closest('.field').hidden = rounds.length < 2;
    const models = new Set(results.map(r => r.model)).size;
    $('round-summary').textContent = rounds.length === 0
      ? 'No ranked days yet · the first dive runs at midnight ET'
      : `${rounds.length === 1 ? `Krillion #${rounds[0]}` : `${rounds.length} rounds`} · ${models} models · Ties share a place`;
    renderRound();
  } catch (error) {
    console.error(error);
    $('error').hidden = false;
  }
}
init();
