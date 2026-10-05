const $ = (sel) => document.querySelector(sel);
const state = { user: null, stats: null, game: null, leagues: [], placeId: null, popular: [] };

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
  return data;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---- weather presentation ------------------------------------------------

// WMO weather codes -> page theme and icon.
function skyFor(code) {
  if (code == null) return ['cloudy', '⛅'];
  if (code <= 1) return ['sunny', '☀️'];
  if (code <= 3) return ['cloudy', '⛅'];
  if (code <= 48) return ['fog', '🌫️'];
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ['snow', '🌨️'];
  if (code >= 95) return ['storm', '⛈️'];
  return ['rain', '🌧️'];
}

const toF = (c) => Math.round(c * 9 / 5 + 32);
function fmt(value, unit) {
  if (value == null) return '–';
  const v = Math.round(value * 10) / 10;
  return unit === '°C' ? `${v}°C / ${toF(v)}°F` : `${v} ${unit}`;
}
const fmtDay = (date, opts = { weekday: 'long', day: 'numeric', month: 'short' }) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });

function untilText(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'locked';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// ---- rendering -----------------------------------------------------------

function render() {
  const { game, user, stats } = state;
  $('#streak').hidden = !stats?.streak;
  if (stats?.streak) $('#streak').textContent = `🔥 ${stats.streak}`;
  if (!game) return;

  const { round, place } = game;
  const [sky, icon] = skyFor(round.sky);
  document.documentElement.dataset.sky = sky;
  $('#sky-icon').textContent = icon;
  $('#place-name').textContent = place.name;
  $('#hero-title').textContent = `${fmtDay(round.date, { weekday: 'long' })} in ${place.name}`;
  renderCountdown();

  $('#questions').innerHTML = round.questions.map((q) => questionCard(q, round)).join('');
  renderDone();
  renderResults();

  $('#board-title').textContent = `${place.name} · this week`;
  $('#leaderboard').innerHTML = game.leaderboard.map((r) =>
    `<li class="${r.name === user?.name ? 'me' : ''}"><span class="name">${esc(r.name)}</span><span>${r.points} pts</span></li>`,
  ).join('') || '<li class="empty">No scores yet this week. Be the first!</li>';

  renderLeagues();
  renderAccount();
}

function renderCountdown() {
  const { round } = state.game ?? {};
  if (!round) return;
  const left = untilText(round.closesAt);
  $('#hero-sub').textContent = left === 'locked'
    ? `Game #${round.number} is locked. Results tomorrow.`
    : `Game #${round.number} · locks in ${left}`;
}

function questionCard(q, round) {
  const locked = untilText(round.closesAt) === 'locked';
  const picked = q.myPick != null;
  const total = q.crowd.yes + q.crowd.no;
  const yesPct = total ? Math.round((q.crowd.yes / total) * 100) : 0;
  const crowd = picked && total
    ? `<div class="crowd">
        <div class="bar"><div class="y" style="width:${yesPct}%"></div><div class="n" style="width:${100 - yesPct}%"></div></div>
        <div class="crowd-row"><span>${yesPct}% say yes · ${total} ${total === 1 ? 'player' : 'players'}</span>
        <span>Forecast: ${fmt(q.forecast, q.unit)}</span></div>
      </div>`
    : `<div class="crowd"><div class="crowd-row"><span>Forecast: ${fmt(q.forecast, q.unit)}</span>
        <span>Forecast says <strong>${q.forecastSays ? 'yes' : 'no'}</strong></span></div></div>`;
  return `<article class="card q" data-key="${q.key}">
    <div class="q-head"><div class="q-emoji" aria-hidden="true">${q.emoji}</div>
      <div><div class="q-title">${esc(q.title)}</div><div class="q-detail">${esc(q.detail)}</div></div></div>
    <div class="choices">
      <button class="choice yes" data-pick="1" aria-pressed="${q.myPick === 1}" ${locked ? 'disabled' : ''}>Yes</button>
      <button class="choice no" data-pick="0" aria-pressed="${q.myPick === 0}" ${locked ? 'disabled' : ''}>No</button>
    </div>
    ${crowd}
  </article>`;
}

function renderDone() {
  const { round, place } = state.game;
  const n = round.questions.filter((q) => q.myPick != null).length;
  const el = $('#done');
  el.hidden = n === 0;
  if (n === 0) return;
  el.innerHTML = n < round.questions.length
    ? `<div class="big">${n} of ${round.questions.length} called</div><p class="muted">Make all three to get the most out of tomorrow.</p>`
    : `<div class="big">You're locked in ✅</div>
       <p class="muted">You can change your calls until midnight in ${esc(place.name)}. Results land in the morning.</p>
       <div class="btn-row"><button class="btn" data-action="challenge">Challenge a friend</button></div>`;
}

function renderResults() {
  const last = state.game.lastRound;
  const el = $('#results');
  el.hidden = !last;
  if (!last) return;
  const played = !!last.score;
  el.innerHTML = `
    <div class="result-head">
      <h2>${fmtDay(last.date, { weekday: 'long' })}'s results · #${last.number}</h2>
      ${played ? `<div class="result-score">${last.score.correct}/${last.questions.length}</div>` : ''}
    </div>
    <ul class="result-list">${last.questions.map((q) => {
      const mark = q.score ? (q.score.correct ? '✅' : '❌') : '';
      const bonuses = (q.score?.bonuses ?? []).map((b) =>
        `<span class="bonus">${b === 'beatForecast' ? 'beat the forecast' : 'bold call'}</span>`).join('');
      return `<li><span class="r-emoji">${q.emoji}</span>
        <span><strong>${esc(q.title)}</strong> ${q.result.answer ? 'Yes' : 'No'}${bonuses}<br>
        <span class="r-actual">Actual: ${fmt(q.result.observed, q.unit)}${q.key === 'warmer' ? ` vs ${fmt(q.result.line, q.unit)}` : ''}</span></span>
        <span class="r-points ${q.score?.points ? '' : 'zero'}">${q.score ? `${mark} ${q.score.points}` : ''}</span></li>`;
    }).join('')}</ul>
    ${played
      ? `<div class="btn-row"><span class="result-score">${last.score.points} pts</span><button class="btn" data-action="share">Share result</button></div>`
      : '<p class="muted">You didn\'t play this one. Make your calls above for tomorrow!</p>'}`;
}

function renderLeagues() {
  $('#leagues').innerHTML = state.leagues.map((l) => `
    <div class="league" data-id="${l.id}" data-code="${l.code}" data-name="${esc(l.name)}">
      <div class="league-head"><strong>${esc(l.name)}</strong>
        <span><button class="btn small" data-action="invite">Invite</button>
        <button class="linkish" data-action="leave">Leave</button></span></div>
      <ol class="board">${l.standings.map((s) =>
        `<li class="${s.name === state.user?.name ? 'me' : ''}"><span class="name">${esc(s.name)}</span><span>${s.points} pts</span></li>`).join('')}</ol>
    </div>`).join('');
}

function renderAccount() {
  const { user } = state;
  const el = $('#account');
  if (!user || user.guest) {
    const mode = el.dataset.mode ?? 'save';
    el.innerHTML = `
      <h2>${user ? `You're playing as ${esc(user.name)}` : 'Your account'}</h2>
      <p class="muted">${mode === 'login'
        ? 'Log in to pick up where you left off.'
        : user ? 'Save your account to keep your streak and play on other devices.' : 'Just start playing. We\'ll make you an account. You can save it later.'}</p>
      ${user || mode === 'login' ? `<form id="account-form" class="stack" data-mode="${mode}">
        <input name="name" placeholder="Name" autocomplete="username" required>
        <input name="password" type="password" placeholder="Password (6+ characters)"
          autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required>
        <button class="btn" type="submit">${mode === 'login' ? 'Log in' : 'Save account'}</button>
        <p class="error"></p>
      </form>` : ''}
      <button class="linkish" data-action="toggle-login">${mode === 'login' ? 'Back' : 'Already have an account? Log in'}</button>`;
  } else {
    el.innerHTML = `<h2>${esc(user.name)}</h2>
      <p class="muted">${state.stats.points} pts from ${state.stats.played} ${state.stats.played === 1 ? 'game' : 'games'}${state.stats.streak ? ` · 🔥 ${state.stats.streak}-day streak` : ''}</p>
      <button class="linkish" data-action="logout">Log out</button>`;
  }
}

// ---- sharing -------------------------------------------------------------

async function share(text, url) {
  const payload = url ? `${text}\n${url}` : text;
  try {
    if (navigator.share) return await navigator.share(url ? { text, url } : { text });
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(payload);
    toast('Copied! Paste it in your group chat');
  } catch {
    prompt('Copy this:', payload);
  }
}

function resultText() {
  const { lastRound: r, place } = state.game;
  const grid = r.questions.map((q) => `${q.emoji}${q.score ? (q.score.correct ? '✅' : '❌') : '⬜'}`).join(' ');
  const streak = state.stats?.streak ? ` · 🔥${state.stats.streak}` : '';
  return `WeatherOrNot #${r.number} · ${place.name}\n${grid}\n${r.score.correct}/${r.questions.length} · ${r.score.points} pts${streak}`;
}

// ---- actions -------------------------------------------------------------

async function loadGame() {
  if (!state.placeId) return;
  try {
    state.game = await api(`/api/game?place=${encodeURIComponent(state.placeId)}`);
    if (state.game.stats) state.stats = state.game.stats;
  } catch (err) {
    toast(err.message);
    if (/Unknown place/.test(err.message)) openPicker();
  }
  render();
}

async function loadAll() {
  const [{ user, stats }, { leagues }] = await Promise.all([api('/api/me'), api('/api/leagues')]);
  Object.assign(state, { user, stats, leagues });
  await loadGame();
}

$('#questions').addEventListener('click', async (e) => {
  const btn = e.target.closest('.choice');
  if (!btn || btn.disabled) return;
  const key = btn.closest('.q').dataset.key;
  try {
    const { round, user, stats } = await api('/api/picks', {
      roundId: state.game.round.id, key, pick: Number(btn.dataset.pick),
    });
    Object.assign(state, { user, stats });
    state.game.round = round;
    render();
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  const league = e.target.closest('.league');
  if (action === 'share') share(resultText(), location.origin);
  if (action === 'challenge') {
    share(`I've made my 3 weather calls for tomorrow in ${state.game.place.name}. Think you can do better? ☔🌡️`, location.origin);
  }
  if (action === 'invite') {
    share(`Join my WeatherOrNot league "${league.dataset.name}" and call tomorrow's weather with me ☔`,
      `${location.origin}/join/${league.dataset.code}`);
  }
  if (action === 'leave' && confirm(`Leave ${league.dataset.name}?`)) {
    await api('/api/leagues/leave', { leagueId: Number(league.dataset.id) });
    loadAll();
  }
  if (action === 'logout') {
    await api('/api/logout', {});
    loadAll();
  }
  if (action === 'toggle-login') {
    const el = $('#account');
    el.dataset.mode = el.dataset.mode === 'login' ? 'save' : 'login';
    renderAccount();
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'account-form') {
    e.preventDefault();
    const form = new FormData(e.target);
    const mode = e.target.dataset.mode;
    try {
      await api(mode === 'login' ? '/api/login' : '/api/account', { name: form.get('name'), password: form.get('password') });
      $('#account').dataset.mode = 'save';
      toast(mode === 'login' ? 'Welcome back!' : 'Account saved');
      loadAll();
    } catch (err) {
      e.target.querySelector('.error').textContent = err.message;
    }
  }
  if (e.target.id === 'create-league') {
    e.preventDefault();
    try {
      const { league } = await api('/api/leagues', { name: new FormData(e.target).get('name') });
      e.target.reset();
      await loadAll();
      share(`Join my WeatherOrNot league "${league.name}" and call tomorrow's weather with me ☔`,
        `${location.origin}/join/${league.code}`);
    } catch (err) {
      toast(err.message);
    }
  }
});

// ---- place picker --------------------------------------------------------

function choosePlace(place) {
  state.placeId = place.id;
  store.set('place', JSON.stringify(place));
  $('#place-dialog').close();
  loadGame();
}

function listPlaces(places, label) {
  $('#place-results').innerHTML = (label ? `<li class="label">${label}</li>` : '') + (places.map((p, i) =>
    `<li><button data-index="${i}"><strong>${esc(p.name)}</strong> <small>${esc(p.country)}</small></button></li>`).join('')
    || '<li class="empty">No places found</li>');
  $('#place-results').onclick = (e) => {
    const btn = e.target.closest('button[data-index]');
    if (btn) choosePlace(places[Number(btn.dataset.index)]);
  };
}

function openPicker(query = '') {
  $('#place-search').value = query;
  if (query) search(query); else listPlaces(state.popular, 'Popular');
  $('#place-dialog').showModal();
  $('#place-search').focus();
}

async function search(query) {
  const token = (search.token = Symbol());
  if (query.trim().length < 2) return listPlaces(state.popular, 'Popular');
  try {
    const { places } = await api(`/api/places/search?q=${encodeURIComponent(query)}`);
    if (token === search.token) listPlaces(places);
  } catch (err) {
    toast(err.message);
  }
}

$('#place-button').addEventListener('click', () => openPicker());
$('#place-search').addEventListener('input', (e) => {
  clearTimeout(search.timer);
  search.timer = setTimeout(() => search(e.target.value), 250);
});

// First visit: guess the city from the device's time zone.
function guessPlace() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  return { match: state.popular.find((p) => p.tz === tz), hint: tz.split('/').pop()?.replace(/_/g, ' ') };
}

// ---- invite links --------------------------------------------------------

async function handleInvite() {
  const code = location.pathname.match(/^\/join\/([A-Za-z0-9]{6})$/)?.[1];
  if (!code) return;
  history.replaceState(null, '', '/');
  try {
    const { league } = await api(`/api/leagues/preview?code=${code}`);
    if (state.leagues.some((l) => l.code === league.code)) return toast(`You're already in ${league.name}`);
    const el = $('#invite');
    el.hidden = false;
    el.innerHTML = `<span>You've been invited to <strong>${esc(league.name)}</strong> (${league.members} ${league.members === 1 ? 'player' : 'players'})</span>
      <button class="btn small">Join</button>`;
    el.querySelector('button').onclick = async () => {
      await api('/api/leagues/join', { code });
      el.hidden = true;
      toast(`You joined ${league.name}!`);
      loadAll();
    };
  } catch {
    toast('That invite link has expired');
  }
}

// ---- start -----------------------------------------------------------------

(async function start() {
  ({ places: state.popular } = await api('/api/places/popular'));
  const saved = store.get('place');
  const guess = guessPlace();
  const place = saved ? JSON.parse(saved) : guess.match;
  if (place) state.placeId = place.id;
  await loadAll();
  if (!place) openPicker(guess.hint ?? '');
  handleInvite();
  setInterval(renderCountdown, 30_000);
})();
