const $ = (sel) => document.querySelector(sel);
const state = { user: null, stats: null, game: null, leagues: [], placeId: null, popular: [], resultsFirst: false };

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

// Launching in the UK: Celsius, mph for wind (set by the server) and UK dates.
const LOCALE = 'en-GB';
const fmtTemp = (c) => `${Math.round(c * 10) / 10}°C`;
function fmt(value, unit) {
  if (value == null) return '?';
  return unit === '°C' ? fmtTemp(value) : `${Math.round(value * 10) / 10} ${unit}`;
}
const fmtDay = (date, opts) => new Date(`${date}T12:00:00Z`).toLocaleDateString(LOCALE, { ...opts, timeZone: 'UTC' });

// Details with a bit of personality; the server's are the fallback.
const COPY = {
  rain: { detail: 'Brolly needed? 1 mm or more counts.' },
  temp: { detail: "Tomorrow's high" },
  wind: { detail: 'The strongest gust of the day' },
};
const titleOf = (q) => q.title;
const detailOf = (q) => COPY[q.key]?.detail ?? q.detail;

// Why the line sits where it does, in plain words.
function hintFor(q) {
  if (q.key === 'rain') {
    const inTen = Math.round(q.chance * 10);
    const mood = inTen >= 6 ? "Rain's likely" : inTen <= 3 ? "Rain's unlikely" : 'Could go either way';
    const odds = inTen < 1 ? 'fewer than 1 in 10 days like this get wet' : `about ${inTen} in 10 days like this get wet`;
    return `Forecast ${fmt(q.forecast, q.unit)}. ${mood}: ${odds}. Less likely = more points.`;
  }
  const shift = Math.round(Math.abs(q.bias) * 10) / 10;
  const base = `Forecast ${fmt(q.forecast, q.unit)}.`;
  if (shift < 0.1) return `${base} The question sits right on it.`;
  const tends = q.key === 'temp'
    ? (q.bias > 0 ? 'Highs tend to come in a little warmer than forecast' : 'Highs tend to come in a little cooler than forecast')
    : (q.bias > 0 ? 'Gusts tend to come in a little stronger than forecast' : 'Gusts tend to come in a little lighter than forecast');
  return `${base} ${tends}, so we've set the question ${fmt(shift, q.unit)} ${q.bias > 0 ? 'higher' : 'lower'}.`;
}

function untilText(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'locked';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

const picksMade = () => state.game.round.questions.filter((q) => q.myPick != null).length;

// ---- rendering -----------------------------------------------------------

function render() {
  const { game, stats } = state;
  $('#streak').hidden = !stats?.streak;
  if (stats?.streak) $('#streak').textContent = `🔥 ${stats.streak}`;
  $('#main').hidden = !game;
  if (!game) return;

  const { round, place } = game;
  const [sky, icon] = skyFor(round.sky);
  document.documentElement.dataset.sky = sky;
  document.querySelector('meta[name=theme-color]').content =
    getComputedStyle(document.documentElement).getPropertyValue('--sky-top').trim();
  $('#sky-icon').textContent = icon;
  $('#place-name').textContent = place.name;
  $('#hero-day').textContent = 'Tomorrow';
  renderCountdown();

  $('#questions').innerHTML = round.questions.map((q) => questionCard(q, round)).join('');
  renderDone();
  renderResults();
  renderBoard($('#leaderboard'), game.leaderboard, 'No scores yet this week. Be the first!');
  $('#board-title').textContent = `${place.name} this week`;
  $('#champion').innerHTML = game.champion
    ? `🏆 Last week's best forecaster: <strong>${game.champion.names.map(esc).join(' and ')}</strong> (${game.champion.points} pts)`
    : '';
  $('#hero-station').textContent = game.station
    ? `Results measured at ${game.station.name} weather station, ${game.station.km} km away`
    : 'No weather station nearby, so results use the forecast model';
  renderLeagues();
  renderAccount();
}

function renderCountdown() {
  const { round } = state.game ?? {};
  if (!round) return;
  const left = untilText(round.closesAt);
  const day = fmtDay(round.date, { weekday: 'short', day: 'numeric', month: 'short' });
  const dots = round.questions.map((q) => `<i class="${q.myPick != null ? 'on' : ''}"></i>`).join('');
  $('#hero-sub').innerHTML = left === 'locked'
    ? `${day} · Game #${round.number} · locked 🔒`
    : `${day} · Game #${round.number} · locks in ${left} <span class="dots" aria-label="${picksMade()} of 3 called">${dots}</span>`;
}

// The crowd split, once you've picked and at least three people have.
function crowdLine(q) {
  const total = q.crowd.yes + q.crowd.no;
  if (q.myPick == null || total < 3) return '<div class="crowd"></div>';
  const yesPct = Math.round((q.crowd.yes / total) * 100);
  return `<div class="crowd">
      <div class="bar"><div class="y" style="width:${yesPct}%"></div><div class="n" style="width:${100 - yesPct}%"></div></div>
      <div class="crowd-row"><span>${yesPct}% say yes</span><span>${total} players</span></div>
    </div>`;
}

function questionCard(q, round) {
  const locked = untilText(round.closesAt) === 'locked' ? 'disabled' : '';
  const banked = round.banker === q.key;
  const x = banked ? 2 : 1;
  return `<article class="card q ${banked ? 'banked' : ''}" data-key="${q.key}">
    <div class="q-head"><div class="q-emoji" aria-hidden="true">${q.emoji}</div>
      <div><div class="q-title">${esc(titleOf(q))}</div><div class="q-detail">${esc(detailOf(q))}</div></div></div>
    <div class="choices">
      <button class="choice yes" data-pick="1" aria-pressed="${q.myPick === 1}" ${locked}>Yes <small>+${q.pays.yes * x} pts</small></button>
      <button class="choice no" data-pick="0" aria-pressed="${q.myPick === 0}" ${locked}>No <small>+${q.pays.no * x} pts</small></button>
    </div>
    <div class="q-foot">
      <p class="hint">${esc(hintFor(q))}</p>
      <button class="banker" aria-pressed="${banked}" ${locked} title="Double points on this one. One a day.">★ ${banked ? 'Doubled' : 'Double it'}</button>
    </div>
    ${crowdLine(q)}
  </article>`;
}

function renderDone() {
  const { round, place } = state.game;
  const n = picksMade();
  const el = $('#done');
  el.hidden = n < round.questions.length;
  if (el.hidden) return;
  const banked = round.questions.find((q) => q.key === round.banker);
  el.innerHTML = `<div class="big">Locked in. Now we wait 🍿</div>
    <p class="muted">${banked ? `You doubled "${esc(banked.title)}". ` : 'Tip: tap ★ Double it on the one you\'re surest of. '}You can change your answers until midnight in ${esc(place.name)}.</p>
    <div class="btn-row"><button class="btn" data-action="challenge">Challenge a mate</button></div>`;
}

// Where the results came from, so nobody has to take our word for it.
function sourceLine(source) {
  if (source?.type === 'station') {
    return `📍 Measured at ${esc(source.name)} weather station${source.km ? `, ${source.km} km away` : ''}`;
  }
  return '📍 No nearby weather station had a full day of readings, so this used the forecast model\'s estimate';
}

function resultHeadline(r) {
  if (r.forecast && r.score.correct > r.forecast.correct) return 'You beat the forecast! 🎯';
  const banker = r.questions.find((q) => q.score?.banker);
  if (banker?.score.correct) return 'Your double came in! ★';
  return ['Rough one. The sky had other ideas.', 'One out of three. Tomorrow\'s another day.',
    'Nice forecasting!', 'Perfect call! ☀️'][r.score.correct] ?? 'Results are in';
}

// "It did: 18.1°C." in words that fit each question.
function outcomeText(q) {
  const v = fmt(q.result.observed, q.unit);
  if (q.result.answer == null) return `Exactly ${v}, right on the number. Everyone who answered gets 5.`;
  const yes = q.result.answer === 1;
  if (q.key === 'rain') return yes ? `It rained: ${v}.` : q.result.observed > 0 ? `Only ${v}, so no.` : 'It stayed dry.';
  if (q.key === 'wind') return yes ? `They did: ${v}.` : `They didn't: ${v}.`;
  return yes ? `It did: ${v}.` : `It didn't: ${v}.`;
}

const markFor = (score) => (!score ? '' : score.correct == null ? '➖' : score.correct ? '✅' : '❌');

function renderResults() {
  const last = state.game.lastRound;
  const el = $('#results') ?? Object.assign(document.createElement('section'), { id: 'results', className: 'card results' });
  (state.resultsFirst ? $('#results-top') : $('#results-bottom')).append(el);
  el.hidden = !last;
  if (!last) return;
  const played = !!last.score;
  el.innerHTML = `
    <div class="result-head">
      <h2>${fmtDay(last.date, { weekday: 'long' })}'s results · #${last.number}</h2>
      ${played ? `<div class="result-score">${last.score.correct}/${last.questions.length}</div>` : ''}
    </div>
    ${played ? `<p class="muted" style="margin:4px 0 0">${resultHeadline(last)}</p>` : ''}
    ${played && last.forecast ? `<p class="versus">You ${last.score.correct}/${last.forecast.total} · Forecast ${last.forecast.correct}/${last.forecast.total}</p>` : ''}
    <p class="source">${sourceLine(last.source)}</p>
    <ul class="result-list">${last.questions.map((q) => {
      const tags = q.score?.banker ? '<span class="bonus">★ doubled</span>' : '';
      const you = q.score ? ` You said ${q.score.pick ? 'Yes' : 'No'}.` : '';
      return `<li><span class="r-emoji" aria-hidden="true">${q.emoji}</span>
        <span><strong>${esc(titleOf(q))}</strong>${tags}<br>
        <span class="r-actual">${outcomeText(q)}${you}</span></span>
        <span class="r-points ${q.score?.points ? '' : 'zero'}">${q.score ? `${markFor(q.score)} ${q.score.points}` : ''}</span></li>`;
    }).join('')}</ul>
    ${played
      ? `<div class="btn-row"><span class="result-score">${last.score.points} pts</span><button class="btn" data-action="share">Share result</button></div>`
      : '<p class="muted">You didn\'t play this one. Answer tomorrow\'s questions above!</p>'}`;
}

// Standard competition ranking: tied scores share a place, shown as "=1".
function renderBoard(el, rows, emptyText) {
  if (!rows.length) {
    el.outerHTML = `<p class="empty" id="${el.id}">${emptyText}</p>`;
    return;
  }
  const html = rows.map((r, i) => {
    const rank = rows.findIndex((x) => x.points === r.points) + 1;
    const tied = rows.filter((x) => x.points === r.points).length > 1;
    return `<li class="${r.name === state.user?.name ? 'me' : ''}"><span class="rank">${tied ? '=' : ''}${rank}</span>
      <span class="name">${esc(r.name)}</span><span class="pts">${r.points} pts</span></li>`;
  }).join('');
  if (el.tagName === 'OL') el.innerHTML = html;
  else el.outerHTML = `<ol class="board" id="${el.id}">${html}</ol>`;
}

function renderLeagues() {
  $('#leagues').innerHTML = state.leagues.map((l) => `
    <div class="league" data-id="${l.id}" data-code="${l.code}" data-name="${esc(l.name)}">
      <div class="league-head"><strong>${esc(l.name)}</strong>
        <span class="league-actions"><button class="btn small" data-action="invite">Invite</button>
          <details class="menu"><summary aria-label="More options">⋯</summary>
            <div class="menu-panel"><button data-action="leave">Leave league</button></div></details></span></div>
      ${l.champion ? `<p class="champion">🏆 ${esc(l.champion.month)} champion: <strong>${l.champion.names.map(esc).join(' and ')}</strong> (${l.champion.points} pts)</p>` : ''}
      <p class="small-print muted" style="margin:4px 0">This week</p>
      <ol class="board" id="league-${l.id}"></ol>
      <button class="linkish small-print" data-action="share-table">Share this week's table</button>
    </div>`).join('');
  for (const l of state.leagues) renderBoard($(`#league-${l.id}`), l.standings, '');
}

function renderAccount() {
  const { user, stats } = state;
  const el = $('#account');
  const mode = el.dataset.mode ?? 'closed';
  const vs = stats?.vsForecast;
  const versus = vs?.calls >= 3
    ? `<p class="versus">🎯 You vs the forecast, last 30 days: <strong>${Math.round((100 * vs.you) / vs.calls)}%</strong> right vs ${Math.round((100 * vs.forecast) / vs.calls)}%</p>`
    : '';
  if (user && !user.guest) {
    el.innerHTML = `<div class="account-row"><div><strong>${esc(user.name)}</strong>
      <p class="muted small-print">${stats.points} pts · ${stats.played} ${stats.played === 1 ? 'game' : 'games'}${stats.streak ? ` · 🔥 ${stats.streak}` : ''}</p></div>
      <button class="linkish" data-action="logout">Log out</button></div>${versus}`;
    return;
  }
  const form = (kind) => `<form id="account-form" class="stack" data-mode="${kind}">
      <input name="name" placeholder="Name" autocomplete="username" required aria-label="Name">
      <input name="password" type="password" placeholder="Password (6+ characters)" aria-label="Password"
        autocomplete="${kind === 'login' ? 'current-password' : 'new-password'}" required>
      <button class="btn" type="submit">${kind === 'login' ? 'Log in' : 'Save my account'}</button>
      <p class="error"></p>
    </form>`;
  el.innerHTML = `<div class="account-row">
      <p>${user ? `Playing as <strong>${esc(user.name)}</strong>` : 'No account needed. Just play.'}</p>
      ${user && mode === 'closed' ? '<button class="btn small secondary" data-action="open-save">Save your streak</button>' : ''}
    </div>
    ${mode === 'save' && user ? `<p class="muted small-print" style="margin:8px 0 0">Pick a name and password to keep your streak and play on other devices.</p>${form('save')}` : ''}
    ${mode === 'login' ? form('login') : ''}
    ${versus}
    <button class="linkish small-print" data-action="toggle-login">${mode === 'login' ? 'Cancel' : 'Already have an account? Log in'}</button>`;
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
  const grid = r.questions.map((q) => `${q.emoji}${markFor(q.score) || '⬜'}${q.score?.banker ? '★' : ''}`).join(' ');
  const streak = state.stats?.streak ? ` · 🔥${state.stats.streak}` : '';
  const vs = r.forecast ? ` (forecast ${r.forecast.correct}/${r.forecast.total})` : '';
  return `WeatherOrNot #${r.number} · ${place.name}\n${grid}\n${r.score.correct}/${r.questions.length}${vs} · ${r.score.points} pts${streak}`;
}

// ---- actions -------------------------------------------------------------

async function loadGame() {
  if (!state.placeId) return render();
  try {
    state.game = await api(`/api/game?place=${encodeURIComponent(state.placeId)}`);
    if (state.game.stats) state.stats = state.game.stats;
    // A result you haven't seen yet goes to the top, once.
    const last = state.game.lastRound;
    state.resultsFirst = !!last?.score && store.get('seenResult') !== String(last.id);
    if (state.resultsFirst) store.set('seenResult', String(last.id));
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

// Banker: tap to make a call your double, tap again to clear it.
$('#questions').addEventListener('click', async (e) => {
  const btn = e.target.closest('.banker');
  if (!btn || btn.disabled) return;
  const key = btn.closest('.q').dataset.key;
  try {
    const { round } = await api('/api/banker', {
      roundId: state.game.round.id, key: state.game.round.banker === key ? null : key,
    });
    state.game.round = round;
    $('#questions').innerHTML = round.questions.map((q) => questionCard(q, round)).join('');
    renderDone();
    if (!state.user) loadAll();
  } catch (err) {
    toast(err.message);
  }
});

// Picks update the card in place, so the button can animate.
$('#questions').addEventListener('click', async (e) => {
  const btn = e.target.closest('.choice');
  if (!btn || btn.disabled) return;
  const card = btn.closest('.q');
  const key = card.dataset.key;
  const before = picksMade();
  card.querySelectorAll('.choice').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  btn.classList.remove('pop');
  void btn.offsetWidth; // restart the animation
  btn.classList.add('pop');
  navigator.vibrate?.(10);
  try {
    const { round, user, stats } = await api('/api/picks', { roundId: state.game.round.id, key, pick: Number(btn.dataset.pick) });
    const firstPlay = !state.user;
    Object.assign(state, { user, stats });
    state.game.round = round;
    card.querySelector('.crowd').outerHTML = crowdLine(round.questions.find((q) => q.key === key));
    renderCountdown();
    renderDone();
    $('#streak').hidden = !stats.streak;
    $('#streak').textContent = `🔥 ${stats.streak}`;
    if (firstPlay) renderAccount();
    if (before < round.questions.length && picksMade() === round.questions.length) {
      setTimeout(() => $('#done').scrollIntoView({ behavior: 'smooth', block: 'center' }), 250);
    }
  } catch (err) {
    toast(err.message);
    render();
  }
});

document.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  const league = e.target.closest('.league');
  if (action === 'share') share(resultText(), location.origin);
  if (action === 'challenge') {
    share(`I've answered tomorrow's 3 weather questions for ${state.game.place.name}. Reckon you can beat me? ☔🌡️`, location.origin);
  }
  if (action === 'share-table') {
    const l = state.leagues.find((x) => String(x.id) === league.dataset.id);
    const medals = ['🥇', '🥈', '🥉'];
    const rows = l.standings.map((r, i) => `${medals[i] ?? `${i + 1}.`} ${r.name} ${r.points}`).join('\n');
    share(`${l.name}, this week so far:\n${rows}`, `${location.origin}/join/${l.code}`);
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
  if (action === 'open-save' || action === 'toggle-login') {
    const el = $('#account');
    el.dataset.mode = action === 'open-save' ? 'save' : el.dataset.mode === 'login' ? 'closed' : 'login';
    renderAccount();
    el.querySelector('input')?.focus();
  }
});

// Close any open ⋯ menu when tapping elsewhere.
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.menu[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'account-form') {
    e.preventDefault();
    const form = new FormData(e.target);
    const mode = e.target.dataset.mode;
    try {
      await api(mode === 'login' ? '/api/login' : '/api/account', { name: form.get('name'), password: form.get('password') });
      $('#account').dataset.mode = 'closed';
      toast(mode === 'login' ? 'Welcome back!' : 'Saved. Your streak is safe 🔥');
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
    || '<li class="empty">No luck. WeatherOrNot covers the UK, the Isle of Man and the Channel Islands. Try a nearby town?</li>');
  $('#place-results').onclick = (e) => {
    const btn = e.target.closest('button[data-index]');
    if (btn) choosePlace(places[Number(btn.dataset.index)]);
  };
}

function openPicker(query = '') {
  $('#place-search').value = query;
  if (query) search(query); else listPlaces(state.popular, 'Popular in the UK and Isle of Man');
  $('#place-dialog').showModal();
  $('#place-search').focus();
}

async function search(query) {
  const token = (search.token = Symbol());
  if (query.trim().length < 2) return listPlaces(state.popular, 'Popular in the UK and Isle of Man');
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

// First visit: guess the city from the device's time zone where that's
// unambiguous (Europe/Isle_of_Man means Douglas). The whole UK shares
// Europe/London, so UK visitors get the city list to pick from instead of
// being dropped into London.
function guessPlace() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  const matches = state.popular.filter((p) => p.tz === tz);
  // Jersey and Guernsey have their own time zone names but no city on our list yet.
  if (['Europe/Jersey', 'Europe/Guernsey'].includes(tz)) return { hint: '' };
  if (matches.length === 1) return { match: matches[0] };
  if (matches.length > 1) return { hint: '' };
  return { hint: '' }; // outside the British Isles: show the popular list
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
    el.innerHTML = `<div class="big">${league.owner ? `${esc(league.owner)} invited you to` : 'You\'re invited to'} ${esc(league.name)} 🏆</div>
      <p class="muted" style="margin:0">${league.members} ${league.members === 1 ? 'player' : 'players'} calling tomorrow's weather. Think you can beat them?</p>
      <button class="btn">Join the league</button>`;
    el.querySelector('button').onclick = async () => {
      await api('/api/leagues/join', { code });
      el.hidden = true;
      toast(`You're in! Now answer your 3 questions`);
      await loadAll();
      $('#questions').scrollIntoView({ behavior: 'smooth' });
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
