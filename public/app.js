const $ = (sel) => document.querySelector(sel);
let me = null;
let allMarkets = [];

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cToF = (c) => Math.round(c * 9 / 5 + 32);
const fmtValue = (v, unit) => (unit === '°C' ? `${v}°C (${cToF(v)}°F)` : `${v} ${unit}`);
const fmtDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

async function refresh() {
  ({ user: me } = await api('/api/me'));
  renderAccount();
  const [{ markets }, { leaderboard }] = await Promise.all([api('/api/markets'), api('/api/leaderboard')]);
  allMarkets = markets;
  renderCityFilter();
  renderMarkets();
  $('#leaderboard').innerHTML = leaderboard.map((u) =>
    `<li>${esc(u.name)} — <strong>${u.points.toLocaleString()}</strong></li>`).join('') || '<li class="muted">No players yet</li>';
  if (me) {
    const [{ bets }, { leagues }] = await Promise.all([api('/api/my-bets'), api('/api/leagues')]);
    renderHistory(bets);
    renderLeagues(leagues);
  }
}

function renderAccount() {
  $('#auth').hidden = !!me;
  $('#history').hidden = !me;
  $('#leagues-section').hidden = !me;
  $('#account').innerHTML = me
    ? `<span>${esc(me.name)} · <strong>${me.points.toLocaleString()}</strong> pts</span>
       ${me.canTopUp ? '<button id="topup" title="Available once a day when you\'re low">Top up</button>' : ''}
       <button class="secondary" id="logout">Log out</button>`
    : '';
  $('#logout')?.addEventListener('click', async () => { await api('/api/logout', {}); refresh(); });
  $('#topup')?.addEventListener('click', async () => { await api('/api/topup', {}); refresh(); });
}

function renderCityFilter() {
  const select = $('#city-filter');
  const current = select.value;
  const cities = [...new Map(allMarkets.map((m) => [m.cityId, m.city]))].sort((a, b) => a[1].localeCompare(b[1]));
  select.innerHTML = '<option value="">All cities</option>' +
    cities.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
  select.value = cities.some(([id]) => id === current) ? current : '';
}

$('#city-filter').addEventListener('change', () => renderMarkets());

function renderMarkets() {
  const city = $('#city-filter').value;
  const markets = allMarkets.filter((m) => !city || m.cityId === city);
  if (!markets.length) {
    $('#markets').innerHTML = '<p class="muted">No open markets yet. They open once tomorrow\'s forecast is in.</p>';
    return;
  }
  $('#markets').innerHTML = markets.map((m) => {
    const { yes, no } = m.pool;
    const total = yes + no;
    const yesPct = total ? Math.round((yes / total) * 100) : 50;
    const forecast = `${m.label} forecast: ${fmtValue(m.forecast, m.unit)}`;
    const mine = m.myBets.map((b) => `${b.amount} on ${b.side ? 'YES' : 'NO'}`).join(', ');
    return `<div class="card" data-id="${m.id}" data-yes="${yes}" data-no="${no}">
      <div class="meta">${esc(m.city)} · ${fmtDate(m.date)}</div>
      <div class="q">${esc(m.question)}</div>
      <div class="meta">${forecast}</div>
      <div class="bar"><div class="y" style="width:${total ? yesPct : 0}%"></div><div class="n" style="width:${total ? 100 - yesPct : 0}%"></div></div>
      <div class="pools"><span class="won">YES ${yes}</span><span class="multi meta"></span><span class="lost">NO ${no}</span></div>
      ${mine ? `<div class="meta">Your bets: ${mine}</div>` : ''}
      <div class="row">
        <input type="number" min="1" step="1" value="50" aria-label="Points to bet" ${me ? '' : 'disabled'}>
        <button class="yes" data-side="1" ${me ? '' : 'disabled'}>YES</button>
        <button class="no" data-side="0" ${me ? '' : 'disabled'}>NO</button>
      </div>
      <p class="error"></p>
    </div>`;
  }).join('');
  document.querySelectorAll('#markets .card').forEach(updatePreview);
}

// What a winning bet would pay back if the pot stayed as it is now.
function updatePreview(card) {
  const amt = Math.max(0, Math.floor(Number(card.querySelector('input').value)) || 0);
  const yes = Number(card.dataset.yes), no = Number(card.dataset.no);
  const total = yes + no + amt;
  const pays = (side) => (amt ? (total / (side + amt)).toFixed(2) + '×' : '–');
  card.querySelector('.multi').textContent = `pays YES ${pays(yes)} · NO ${pays(no)}`;
}

$('#markets').addEventListener('input', (e) => {
  const card = e.target.closest('.card');
  if (card) updatePreview(card);
});

$('#markets').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-side]');
  if (!btn) return;
  const card = btn.closest('.card');
  try {
    await api('/api/bets', {
      marketId: Number(card.dataset.id), side: Number(btn.dataset.side), amount: Number(card.querySelector('input').value),
    });
    refresh();
  } catch (err) {
    card.querySelector('.error').textContent = err.message;
  }
});

function renderHistory(bets) {
  $('#my-bets').innerHTML = bets.map((b) => {
    const m = b.market;
    let result = '<span class="meta">pending</span>';
    if (m.status === 'settled') {
      const actual = fmtValue(m.observed, m.unit);
      result = b.payout > 0
        ? `<span class="won">+${b.payout}</span> <span class="meta">(actual ${actual})</span>`
        : `<span class="lost">lost</span> <span class="meta">(actual ${actual})</span>`;
    }
    return `<li><strong>${b.side ? 'YES' : 'NO'}</strong> ${b.amount} · ${esc(m.question)} <span class="meta">${fmtDate(m.date)}</span><br>${result}</li>`;
  }).join('') || '<li class="muted">No bets yet</li>';
}

function renderLeagues(leagues) {
  $('#leagues').innerHTML = leagues.map((l) => `<div class="card league" data-id="${l.id}">
      <div class="row"><strong>${esc(l.name)}</strong><button class="secondary leave">Leave</button></div>
      <div class="meta">Code: <span class="code">${esc(l.code)}</span>${l.isOwner ? ' · you made this league' : ''}</div>
      <ol>${l.standings.map((s) => `<li>${esc(s.name)}${s.name === me.name ? ' (you)' : ''} — <strong>${s.points.toLocaleString()}</strong></li>`).join('')}</ol>
    </div>`).join('') || '<p class="muted">You are not in any leagues yet.</p>';
}

async function leagueAction(path, body) {
  try {
    await api(path, body);
    $('#league-error').textContent = '';
    refresh();
  } catch (err) {
    $('#league-error').textContent = err.message;
  }
}

$('#leagues').addEventListener('click', (e) => {
  if (!e.target.matches('.leave')) return;
  const card = e.target.closest('.league');
  if (confirm('Leave this league?')) leagueAction('/api/leagues/leave', { leagueId: Number(card.dataset.id) });
});

for (const [form, path, field] of [['#create-league', '/api/leagues', 'name'], ['#join-league', '/api/leagues/join', 'code']]) {
  $(form).addEventListener('submit', (e) => {
    e.preventDefault();
    leagueAction(path, { [field]: new FormData(e.target).get(field) });
    e.target.reset();
  });
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const action = e.submitter?.dataset.action ?? 'login';
  const form = new FormData(e.target);
  try {
    await api(`/api/${action}`, { name: form.get('name'), password: form.get('password') });
    $('#auth-error').textContent = '';
    e.target.reset();
    refresh();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

refresh();
