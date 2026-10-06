const $ = (sel) => document.querySelector(sel);
const state = { user: null, stats: null, game: null, leagues: [], placeId: null, popular: [], resultsFirst: false };

async function request(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong. Refresh and try again.');
  return data;
}

// Writes go one at a time. A new player's first answer creates their guest
// account; sending the next one before that reply lands would make a second.
let writes = Promise.resolve();
function api(path, body) {
  if (!body) return request(path);
  const result = writes.then(() => request(path, body));
  writes = result.catch(() => {});
  return result;
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

const titleOf = (q) => q.title;
const detailOf = (q) => q.detail;

// Why the line sits where it does, in plain words.
function hintFor(q) {
  if (q.key === 'rain') {
    const inTen = Math.round(q.chance * 10);
    const mood = inTen >= 6 ? "Rain's likely" : inTen <= 3 ? "Rain's unlikely" : 'Could go either way';
    const odds = inTen < 1 ? 'fewer than 1 in 10 days like this get wet' : `about ${inTen} in 10 days like this get wet`;
    return `Forecast: ${fmt(q.forecast, q.unit)} of rain. ${mood} (${odds}), so a right ${inTen >= 5 ? 'Yes scores less than a right No' : 'No scores less than a right Yes'}.`;
  }
  const shift = Math.round(Math.abs(q.bias) * 10) / 10;
  const base = `Forecast ${fmt(q.forecast, q.unit)}.`;
  if (shift < 0.1) return `${base} The question uses the forecast number.`;
  const tends = q.key === 'temp'
    ? (q.bias > 0 ? 'Highs here usually beat the forecast a little' : 'Highs here usually fall a little short of the forecast')
    : (q.bias > 0 ? 'Gusts here usually come in a bit stronger than forecast' : 'Gusts here usually come in a bit lighter than forecast');
  return `${base} ${tends}, so we've asked about ${fmt(q.line, q.unit)} to make it a fair coin flip.`;
}

function untilText(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'locked';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h ? `${h}h ${m}m` : m ? `${m}m` : 'under a minute';
}

const picksMade = () => state.game.round.questions.filter((q) => q.myPick != null).length;

// ---- rendering -----------------------------------------------------------

function render() {
  const { game, stats } = state;
  $('#streak').hidden = !stats?.streak;
  if (stats?.streak) $('#streak').textContent = `🔥 ${stats.streak}`;
  $('#main').hidden = !game;
  $('#load-error').hidden = !state.loadError || !!game;
  if (state.loadError && !game) {
    $('#place-name').textContent = state.placeName ?? 'Pick your town';
    $('#load-error').innerHTML = `<p><strong>${esc(state.loadError)}</strong></p>
      <div class="btn-row"><button class="btn" data-action="retry">Try again</button>
      <button class="btn secondary" data-action="change-town">Pick another town</button></div>`;
  }
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
    ? `Results: ${game.station.name} · ${game.station.km}\u00a0km`
    : 'No weather station nearby, so results use the forecast model';
  renderLeagues();
  renderAccount();
}

function renderCountdown() {
  const { round } = state.game ?? {};
  if (!round) return;
  const left = untilText(round.closesAt);
  if (left === 'locked' && !state.lockedShown) {
    state.lockedShown = true;
    $('#questions').innerHTML = round.questions.map((q) => questionCard(q, round)).join('');
  }
  const day = fmtDay(round.date, { weekday: 'short', day: 'numeric', month: 'short' });
  const dots = round.questions.map((q) => `<i class="${q.myPick != null ? 'on' : ''}"></i>`).join('');
  $('#hero-sub').innerHTML = left === 'locked'
    ? `${day} · Game #${round.number} · answers closed 🔒`
    : `${day} · Game #${round.number} · <span class="nowrap">answers close in ${left} <span class="dots" role="img" aria-label="${picksMade()} of 3 answered">${dots}</span></span>`;
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
      <button class="choice yes" data-pick="1" aria-pressed="${q.myPick === 1}" ${locked}>Yes <small>· ${q.pays.yes * x} pts</small></button>
      <button class="choice no" data-pick="0" aria-pressed="${q.myPick === 0}" ${locked}>No <small>· ${q.pays.no * x} pts</small></button>
    </div>
    <div class="q-foot">
      <p class="hint">${esc(hintFor(q))}</p>
      <button class="banker" aria-pressed="${banked}" ${locked} aria-label="${banked ? 'Doubled' : 'Double points on'}: ${esc(q.title)}" title="Double points on this one. One a day.">★ ${banked ? 'Doubled' : 'Double points'}</button>
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
  el.innerHTML = `<div class="big">All done. Now we wait 🍿</div>
    <p class="muted">${banked ? `You doubled "${esc(banked.title)}". ` : 'Tip: tap ★ Double points on the one you\'re surest of. '}Change your mind? You've got until midnight in ${esc(place.name)}. Results land ${resultsDay(round.date)} morning.</p>
    <div class="btn-row"><button class="btn" data-action="challenge">Challenge a mate</button></div>`;
}

// Where the results came from, so nobody has to take our word for it.
function sourceLine(source) {
  if (source?.type === 'station') {
    return `📍 ${esc(source.name)}`;
  }
  return "📍 No full station reading that day, so we used the forecast model's estimate";
}

function resultHeadline(r) {
  if (r.forecast && r.score.correct > r.forecast.correct) return 'You beat the forecast! 🎯';
  const banker = r.questions.find((q) => q.score?.banker);
  if (banker?.score.correct) return 'You nailed the one you doubled! ★';
  return ['Rough one. The sky had other ideas.', 'One out of three. Tomorrow\'s another day.',
    'Nice forecasting!', '3 out of 3! ☀️'][r.score.correct] ?? 'Results are in';
}

// "It hit 18.1°C." in words that fit each question.
function outcomeText(q) {
  const v = fmt(q.result.observed, q.unit);
  if (q.result.voided) return `${esc(q.result.voided[0].toUpperCase() + q.result.voided.slice(1))}. 5 pts each (10 if doubled).`;
  if (q.result.answer == null) return `Exactly ${v}, a dead heat. Everyone who answered gets 5 pts (10 if doubled).`;
  const yes = q.result.answer === 1;
  if (q.key === 'rain') return yes ? `It rained ${v}.` : q.result.observed > 0 ? `Only ${v}, so no.` : 'It stayed dry.';
  if (q.key === 'wind') return `Top gust ${v}.`;
  return yes ? `It hit ${v}.` : `It only reached ${v}.`;
}

// The morning a game's results arrive: the day after the game's day.
function resultsDay(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toLocaleDateString(LOCALE, { weekday: 'long', timeZone: 'UTC' });
}

// "Something look wrong?": a short form under the results.
function reportBlock(r) {
  if (!state.user) return '';
  if (state.reported?.[r.id]) return '<p class="small-print muted">Thanks for flagging it. We\'ll check the station\'s readings.</p>';
  return `<details class="report"><summary class="linkish small-print">Something look wrong? Tell us</summary>
    <form id="report-form" class="stack" data-round="${r.id}">
      <select name="key" aria-label="Which question">
        ${r.questions.map((q) => `<option value="${q.key}">${esc(q.title)}</option>`).join('')}
        <option value="">Something else</option>
      </select>
      <textarea name="message" rows="3" maxlength="500" required aria-label="What looks wrong?" placeholder="What looks wrong? E.g. it poured all afternoon but it says 0 mm."></textarea>
      <button class="btn small" type="submit">Send</button>
      <p class="small-print muted" style="margin:0">If a station reading is clearly wrong, we scrap that question for everyone and give 5 pts each.</p>
    </form></details>`;
}

// Questions that counted: everything except scrapped ones and dead heats.
const scoredCount = (r) => r.questions.filter((q) => q.result?.answer != null).length;

const markFor = (score) => (!score ? '' : score.correct == null ? '' : score.correct ? '✅' : '❌');

function renderResults() {
  const last = state.game.lastRound;
  const el = $('#results') ?? Object.assign(document.createElement('section'), { id: 'results', className: 'card results' });
  (state.resultsFirst ? $('#results-top') : $('#results-bottom')).append(el);
  el.hidden = !last;
  if (!last) return;
  const played = !!last.score;
  el.innerHTML = `
    <div class="result-head">
      <h2>${fmtDay(last.date, { weekday: 'long' })}'s results · Game #${last.number}</h2>
      ${played ? `<div class="result-score">${last.score.correct}/${scoredCount(last)}</div>` : ''}
    </div>
    ${played ? `<p class="result-headline">${resultHeadline(last)}</p>` : ''}
    ${played && last.forecast ? `<p class="versus muted">You got ${last.score.correct} of ${scoredCount(last)}. Just going with the forecast got ${last.forecast.correct}.</p>` : ''}
    <p class="source">${sourceLine(last.source)}</p>
    <ul class="result-list">${last.questions.map((q) => {
      const tags = (q.result.voided ? '<span class="bonus scrapped">Scrapped</span>' : '')
        + (q.score?.banker ? '<span class="bonus">★ Doubled</span>' : '');
      const you = q.score ? ` You said ${q.score.pick ? 'Yes' : 'No'}.` : '';
      return `<li><span class="r-emoji" aria-hidden="true">${q.emoji}</span>
        <span><strong>${esc(titleOf(q))}</strong>${tags}<br>
        <span class="r-actual">${outcomeText(q)}${you}</span></span>
        <span class="r-points ${q.score?.points ? '' : 'zero'}">${q.score ? `${markFor(q.score)} ${q.score.points ? `+${q.score.points}` : 0} pts` : ''}</span></li>`;
    }).join('')}</ul>
    ${played
      ? `<div class="btn-row"><span class="result-score">${last.score.points} pts</span><button class="btn" data-action="share">Share result</button></div>`
      : `<p class="muted">${state.stats?.played
        ? 'You didn\'t play this one.'
        : `You weren't playing yet on ${fmtDay(last.date, { weekday: 'long' })}. Your first results land ${resultsDay(state.game.round.date)} morning.`}</p>`}
    ${reportBlock(last)}
    ${last.number < state.game.round.number - 1 ? `<p class="small-print muted">Results for Game #${state.game.round.number - 1} (today's weather) land tomorrow morning.</p>` : ''}`;
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
    ? `<p class="versus">🎯 Last 30 days: you got <strong>${Math.round((100 * vs.you) / vs.calls)}%</strong> right. Just going with the forecast got ${Math.round((100 * vs.forecast) / vs.calls)}%.</p>`
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

// Anonymous daily counts for the owner (visits and shares). No IDs are sent.
function hit(name) {
  const body = JSON.stringify({ name });
  try {
    if (navigator.sendBeacon?.('/api/hit', body)) return;
  } catch { /* fall through */ }
  fetch('/api/hit', { method: 'POST', body, keepalive: true }).catch(() => {});
}

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
  const grid = r.questions.map((q) => `${q.emoji}${q.result?.answer == null ? '➖' : markFor(q.score) || '⬜'}${q.score?.banker ? '⭐' : ''}`).join(' ');
  const streak = state.stats?.streak ? ` · 🔥${state.stats.streak}` : '';
  const vs = r.forecast ? ` (the forecast got ${r.forecast.correct}/${scoredCount(r)})` : '';
  return `WeatherOrNot #${r.number} · ${place.name}\n${grid}\n${r.score.correct}/${scoredCount(r)}${vs} · ${r.score.points} pts${streak}`;
}

// ---- actions -------------------------------------------------------------

async function loadGame() {
  if (!state.placeId) return render();
  state.loadError = null;
  if (state.game?.place.id !== state.placeId) {
    // A slow town can take a while (the weather service retries), so say so.
    $('#load-error').hidden = false;
    $('#load-error').innerHTML = `<p class="muted">Getting tomorrow's forecast for ${esc(state.placeName ?? 'your town')}…</p>`;
    $('#place-name').textContent = state.placeName ?? 'Your town';
  }
  try {
    state.game = await api(`/api/game?place=${encodeURIComponent(state.placeId)}`);
    if (state.game.stats) state.stats = state.game.stats;
    store.set('place', JSON.stringify({ id: state.game.place.id, name: state.game.place.name }));
    // A result you haven't seen yet goes to the top, once.
    const last = state.game.lastRound;
    state.resultsFirst = !!last?.score && store.get('seenResult') !== String(last.id);
    if (state.resultsFirst) store.set('seenResult', String(last.id));
  } catch (err) {
    state.game = null;
    state.loadError = err.message;
    if (/know that place|from a weather station/.test(err.message)) openPicker();
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
    $(`.q[data-key="${key}"] .banker`)?.focus();
    renderDone();
    if (!state.user) {
      await loadAll();
      $(`.q[data-key="${key}"] .banker`)?.focus();
    }
    toast(round.banker ? '★ Doubled. One a day: tap another to move it.' : 'Double points removed.');
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
  if (action === 'share') {
    hit('share-result');
    share(resultText(), shareLink());
  }
  if (action === 'close-coach') {
    $('#coach').hidden = true;
    store.set('coachSeen', '1');
  }
  if (action === 'challenge') {
    hit('share-challenge');
    share(`I've answered tomorrow's 3 weather questions for ${state.game.place.name}. Reckon you can beat me? ☔🌡️`, location.origin);
  }
  if (action === 'share-table') {
    const l = state.leagues.find((x) => String(x.id) === league.dataset.id);
    const medals = ['🥇', '🥈', '🥉'];
    hit('share-league');
    const rows = l.standings.map((r, i) => `${medals[i] ?? `${i + 1}.`} ${r.name} ${r.points}`).join('\n');
    share(`${l.name}, this week so far:\n${rows}`, `${location.origin}/join/${l.code}`);
  }
  if (action === 'invite') {
    hit('share-league');
    share(`Join my WeatherOrNot league "${league.dataset.name}" and guess tomorrow's weather with me ☔`,
      `${location.origin}/join/${league.dataset.code}`);
  }
  if (action === 'leave' && confirm(`Leave ${league.dataset.name}?`)) {
    try {
      await api('/api/leagues/leave', { leagueId: Number(league.dataset.id) });
    } catch (err) {
      toast(err.message);
    }
    loadAll();
  }
  if (action === 'logout') {
    try {
      await api('/api/logout', {});
    } catch (err) {
      toast(err.message);
    }
    loadAll();
  }
  if (action === 'retry') loadGame();
  if (action === 'change-town') openPicker();
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
      const result = await api(mode === 'login' ? '/api/login' : '/api/account', { name: form.get('name'), password: form.get('password') });
      $('#account').dataset.mode = 'closed';
      toast(mode === 'login'
        ? (result.moved ? "Welcome back! Your answers from this device came with you." : 'Welcome back!')
        : 'Saved. Your streak is safe 🔥');
      loadAll();
    } catch (err) {
      e.target.querySelector('.error').textContent = err.message;
    }
  }
  if (e.target.id === 'report-form') {
    e.preventDefault();
    const form = new FormData(e.target);
    const roundId = Number(e.target.dataset.round);
    try {
      await api('/api/reports', { roundId, key: form.get('key') || null, message: form.get('message') });
      state.reported = { ...state.reported, [roundId]: true };
      toast("Thanks. We'll check the station's readings.");
      renderResults();
    } catch (err) {
      toast(err.message);
    }
  }
  if (e.target.id === 'create-league') {
    e.preventDefault();
    const button = e.target.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const { league } = await api('/api/leagues', { name: new FormData(e.target).get('name') });
      e.target.reset();
      await loadAll();
      hit('share-league');
      share(`Join my WeatherOrNot league "${league.name}" and guess tomorrow's weather with me ☔`,
        `${location.origin}/join/${league.code}`);
    } catch (err) {
      toast(err.message);
    } finally {
      button.disabled = false;
    }
  }
});

// ---- place picker --------------------------------------------------------

async function choosePlace(place) {
  state.placeId = place.id;
  state.placeName = place.name;
  if ($('#place-dialog').open) $('#place-dialog').close();
  const fromIntro = !$('#intro').hidden;
  hideIntro();
  // Picking a town from an invite link joins the league too: one tap.
  if (state.pendingJoin) {
    const { code, name } = state.pendingJoin;
    state.pendingJoin = null;
    try {
      await api('/api/leagues/join', { code });
      $('#invite').hidden = true;
      toast(`You're in ${name}! Now answer your 3 questions`);
    } catch (err) {
      toast(err.message);
    }
    await loadAll();
  } else {
    await loadGame();
  }
  if (fromIntro && store.get('coachSeen') !== '1') $('#coach').hidden = false;
}

// ---- first-visit intro -------------------------------------------------------

const INTRO_CITIES = ['Manchester', 'Glasgow', 'Douglas', 'Belfast'];

function showIntro({ guess, from }) {
  hit('intro');
  document.body.classList.add('intro-mode');
  $('#intro').hidden = false;
  const cities = INTRO_CITIES.map((name) => state.popular.find((p) => p.name === name)).filter(Boolean);
  $('#intro-cities').innerHTML = cities.map((p) => `<button class="city" data-intro-place="${esc(p.id)}">${esc(p.name)}</button>`).join('');
  $('#intro-cities').onclick = (e) => {
    const id = e.target.closest('[data-intro-place]')?.dataset.introPlace;
    if (id) choosePlace(cities.find((p) => p.id === id));
  };
  // A friend's shared result, or a town we can guess, becomes a one-tap start.
  const start = from ? { id: from.place, name: from.town } : guess.match;
  // Don't repeat the one-tap town as a chip underneath it.
  if (start) $(`.city[data-intro-place="${start.id}"]`)?.remove();
  if (start) {
    $('#intro-guess').hidden = false;
    $('#intro-guess').textContent = `📍 Play ${start.name}`;
    $('#intro-guess').onclick = () => choosePlace(start);
    $('#intro-pick').textContent = 'Pick a different town';
  }
  if (from) {
    $('#intro-from').hidden = false;
    $('#intro-from').innerHTML = `<div class="big">🎯 ${esc(from.name)} got ${from.got} of ${from.of} in ${esc(from.town)}. Your go?</div>`;
  }
  $('#intro-pick').onclick = () => openPicker(guess.hint ?? '');
}

function hideIntro() {
  document.body.classList.remove('intro-mode');
  $('#intro').hidden = true;
}

// Shared results link back with who played, their score and their town.
function shareLink() {
  const { lastRound: r, place } = state.game;
  const q = new URLSearchParams({
    from: state.user?.name ?? '', got: r.score.correct, of: scoredCount(r), town: place.name, place: place.id,
  });
  return `${location.origin}/?${q}`;
}

function readShareParams() {
  const q = new URLSearchParams(location.search);
  if (!q.has('from')) return null;
  history.replaceState(null, '', location.pathname);
  const got = Number(q.get('got'));
  const of = Number(q.get('of'));
  const place = q.get('place') ?? '';
  const name = (q.get('from') ?? '').slice(0, 20);
  const town = (q.get('town') ?? '').slice(0, 60);
  if (!name || !town || !/^gn:\d+$/.test(place) || !Number.isInteger(of) || !Number.isInteger(got)
    || of < 1 || of > 3 || got < 0 || got > of) return null;
  return { name, got, of, town, place };
}

function listPlaces(places, label) {
  $('#place-results').innerHTML = (label ? `<li class="label">${label}</li>` : '') + (places.map((p, i) =>
    p.playable === false
      ? `<li><button disabled><strong>${esc(p.name)}</strong> <small>${esc(p.country)}</small><br><small>Too far from a weather station${p.stationKm ? ` (${p.stationKm} km)` : ''}. Try the nearest bigger town.</small></button></li>`
      : `<li><button data-index="${i}"><strong>${esc(p.name)}</strong> <small>${esc(p.country)}</small></button></li>`).join('')
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
  if (!location.pathname.startsWith('/join/')) return;
  const code = location.pathname.match(/^\/join\/([A-Za-z0-9]{6})\/?$/)?.[1];
  if (!code) {
    history.replaceState(null, '', '/');
    return toast("That invite link doesn't work. Ask for a fresh one?");
  }
  history.replaceState(null, '', '/');
  try {
    const { league } = await api(`/api/leagues/preview?code=${code}`);
    if (state.leagues.some((l) => l.code === league.code)) return toast(`You're already in ${league.name}`);
    const el = $('#invite');
    el.hidden = false;
    // New visitors: picking a town on the intro joins the league in the same tap.
    if (!$('#intro').hidden) {
      state.pendingJoin = { code, name: league.name };
      el.innerHTML = `<div class="big">${league.owner ? `${esc(league.owner)} invited you to` : 'You\'re invited to'} ${esc(league.name)} 🏆</div>
        <p class="muted" style="margin:0">${league.members} ${league.members === 1 ? 'player' : 'players'} guessing tomorrow's weather. Pick your town below and you're in.</p>`;
      $('#intro-kicker').hidden = true;
      $('#intro-extra').hidden = true;
      $('#intro-pick').textContent = $('#intro-guess').hidden ? '📍 Pick your town and join' : 'Pick a different town and join';
      if (!$('#intro-guess').hidden) $('#intro-guess').textContent += ' and join';
      return;
    }
    el.innerHTML = `<div class="big">${league.owner ? `${esc(league.owner)} invited you to` : 'You\'re invited to'} ${esc(league.name)} 🏆</div>
      <p class="muted" style="margin:0">${league.members} ${league.members === 1 ? 'player' : 'players'} guessing tomorrow's weather. Think you can beat them?</p>
      <button class="btn">Join the league</button>`;
    el.querySelector('button').onclick = async () => {
      await api('/api/leagues/join', { code });
      el.hidden = true;
      toast(`You're in! Now answer your 3 questions`);
      await loadAll();
      $('#questions').scrollIntoView({ behavior: 'smooth' });
    };
  } catch {
    toast("That invite link doesn't work. Ask for a fresh one?");
  }
}

// ---- start -----------------------------------------------------------------

$('#year').textContent = new Date().getFullYear();

document.querySelector('.footer-links a[href="#how"]').addEventListener('click', (e) => {
  if (!document.body.classList.contains('intro-mode')) return;
  e.preventDefault();
  $('.demos').scrollIntoView({ behavior: 'smooth' });
});

// Escape closes the ⋯ menu, and closes the town picker in one press.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('details.menu[open]').forEach((d) => { d.open = false; d.querySelector('summary').focus(); });
  if (e.target.id === 'place-search') {
    e.preventDefault();
    $('#place-dialog').close();
  }
});

(async function start() {
  ({ places: state.popular } = await api('/api/places/popular'));
  const saved = store.get('place');
  const guess = guessPlace();
  hit('visit');
  if (location.pathname.startsWith('/join/')) hit('open-invite');
  let from = readShareParams();
  if (from) {
    hit('open-shared');
    // Use the real name for the place id, so a tampered link can't say one town and load another.
    try {
      from.town = (await api(`/api/places/info?id=${encodeURIComponent(from.place)}`)).place.name;
    } catch {
      from = null;
    }
  }
  const me = await api('/api/me');
  // A returning player on a new browser carries on where they last played.
  const place = saved ? JSON.parse(saved) : me.stats?.lastPlace ?? null;
  if (place) {
    state.placeId = place.id;
    state.placeName = place.name;
  }
  await loadAll();
  if (!place) showIntro({ guess, from });
  await handleInvite();
  setInterval(renderCountdown, 30_000);
})();
