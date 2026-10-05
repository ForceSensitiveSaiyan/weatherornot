const $ = (sel) => document.querySelector(sel);
let me = null;

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
const fmtDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

async function refresh() {
  ({ user: me } = await api('/api/me'));
  renderAccount();
  const [{ markets }, { leaderboard }] = await Promise.all([api('/api/markets'), api('/api/leaderboard')]);
  renderMarkets(markets);
  $('#leaderboard').innerHTML = leaderboard.map((u) =>
    `<li>${esc(u.name)} — <strong>${u.points.toLocaleString()}</strong></li>`).join('') || '<li class="muted">No players yet</li>';
  if (me) renderHistory((await api('/api/my-bets')).bets);
}

function renderAccount() {
  $('#auth').hidden = !!me;
  $('#history').hidden = !me;
  $('#account').innerHTML = me
    ? `<span>${esc(me.name)} · <strong>${me.points.toLocaleString()}</strong> pts</span><button class="secondary" id="logout">Log out</button>`
    : '';
  $('#logout')?.addEventListener('click', async () => { await api('/api/logout', {}); refresh(); });
}

function renderMarkets(markets) {
  if (!markets.length) {
    $('#markets').innerHTML = '<p class="muted">No open markets yet. They open once tomorrow\'s forecast is in.</p>';
    return;
  }
  $('#markets').innerHTML = markets.map((m) => {
    const { yes, no } = m.pool;
    const total = yes + no;
    const yesPct = total ? Math.round((yes / total) * 100) : 50;
    const forecast = m.kind === 'temp_over'
      ? `Forecast high: ${m.forecast}°C (${cToF(m.forecast)}°F)`
      : `Forecast rain: ${m.forecast} mm`;
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
      const actual = m.kind === 'temp_over' ? `${m.observed}°C` : `${m.observed} mm`;
      result = b.payout > 0
        ? `<span class="won">+${b.payout}</span> <span class="meta">(actual ${actual})</span>`
        : `<span class="lost">lost</span> <span class="meta">(actual ${actual})</span>`;
    }
    return `<li><strong>${b.side ? 'YES' : 'NO'}</strong> ${b.amount} · ${esc(m.question)} <span class="meta">${fmtDate(m.date)}</span><br>${result}</li>`;
  }).join('') || '<li class="muted">No bets yet</li>';
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
