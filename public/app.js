const $ = (id) => document.getElementById(id);
const labels = { '🏮': 'red lantern', '🦑': 'squid', '🐟': 'fish', '⬛': 'black square' };
let results = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render() {
  const query = $('search').value.trim().toLowerCase();
  const round = $('round').value;
  const ranked = [...results].sort((a, b) => b.score - a.score);
  const visible = ranked.filter(r => r.model.toLowerCase().includes(query) && (round === 'all' || String(r.round) === round));
  if ($('sort').value === 'asc') visible.sort((a, b) => a.score - b.score);
  if ($('sort').value === 'name') visible.sort((a, b) => a.model.localeCompare(b.model));

  $('results').replaceChildren(...visible.map(result => {
    const rank = 1 + ranked.filter(r => r.score > result.score).length;
    const row = el('li', 'row' + (rank === 1 ? ' first' : ''));
    row.append(el('span', 'rank', `#${rank}`));

    const who = el('div', 'who');
    who.append(el('span', 'model', result.model), el('span', 'label round', `Krillion #${result.round}`));
    row.append(who);

    const slots = el('div', 'slots');
    slots.setAttribute('role', 'img');
    slots.setAttribute('aria-label', result.emojis.map(e => labels[e] || 'empty slot').join(', '));
    for (const emoji of result.emojis) {
      const slot = el('span', 'slot' + (emoji === null ? ' empty' : ''), emoji || '');
      slot.setAttribute('aria-hidden', 'true');
      slots.append(slot);
    }
    row.append(slots, el('span', 'score', String(result.score)));
    return row;
  }));

  $('empty').hidden = visible.length !== 0;
  $('result-count').textContent = `${visible.length} result${visible.length === 1 ? '' : 's'}`;
}

for (const id of ['search', 'sort', 'round']) $(id).addEventListener(id === 'search' ? 'input' : 'change', render);

async function init() {
  try {
    const response = await fetch('scores.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`scores.json returned ${response.status}`);
    const data = await response.json();
    results = data.results;
    const valid = r => typeof r.model === 'string' && Number.isFinite(r.score) && r.score >= 0 && Number.isInteger(r.round)
      && Array.isArray(r.emojis) && r.emojis.length === 7;
    if (!results.every(valid)) throw new Error('Invalid score data');

    const rounds = [...new Set(results.map(r => r.round))].sort((a, b) => b - a);
    for (const round of rounds) $('round').append(Object.assign(el('option', '', `#${round}`), { value: round }));
    // One round needs no filter.
    $('round').closest('.field').hidden = rounds.length < 2;
    const models = new Set(results.map(r => r.model)).size;
    $('round-summary').textContent = `${rounds.length === 1 ? `Krillion #${rounds[0]}` : `${rounds.length} rounds`} · ${models} models · Ties share a place`;
    render();
  } catch (error) {
    console.error(error);
    $('error').hidden = false;
  }
}
init();
