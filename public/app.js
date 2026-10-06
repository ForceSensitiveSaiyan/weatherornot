import { weatherLine, shortDay, vsLine } from './words.js';

const $ = (sel) => document.querySelector(sel);
const state = { user: null, stats: null, game: null, leagues: [], placeId: null, popular: [], resultsFirst: false, friend: null };

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
  json(k) { try { return JSON.parse(this.get(k)); } catch { return null; } },
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

const LOCALE = 'en-GB';
const round1 = (x) => Math.round(x * 10) / 10;
function fmt(value, unit) {
  if (value == null) return '?';
  return unit === '°C' ? `${round1(value)}°C` : `${round1(value)} ${unit}`;
}
// Short form for the dial: "13.8°", "24.5 mph".
const short = (value, unit) => (unit === '°C' ? `${round1(value)}°` : `${round1(value)} mph`);
const fmtDay = (date, opts) => new Date(`${date}T12:00:00Z`).toLocaleDateString(LOCALE, { ...opts, timeZone: 'UTC' });
const weekday = (date) => fmtDay(date, { weekday: 'long' });

// The morning a game's results arrive: the day after the game's day.
function resultsDay(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toLocaleDateString(LOCALE, { weekday: 'long', timeZone: 'UTC' });
}

// One short line under each question.
function captionFor(q) {
  if (q.key === 'rain') {
    const inTen = Math.round(q.chance * 10);
    return `Forecast ${fmt(q.forecast, 'mm')}. Rain on ${inTen < 1 ? 'fewer than 1' : `about ${inTen}`} in 10 days like this.`;
  }
  if (Math.abs(q.bias) < 0.1) return '';
  if (q.key === 'temp') return `Highs here usually run a bit ${q.bias > 0 ? 'warm' : 'cool'}, so it's set ${q.bias > 0 ? 'above' : 'below'} the forecast.`;
  return `Gusts here usually run a bit ${q.bias > 0 ? 'strong' : 'light'}, so it's set ${q.bias > 0 ? 'above' : 'below'} the forecast.`;
}

// The dial: the number asked in the middle and the forecast as a hollow dot.
// Once it's settled: the number asked and what was measured, sliding in from
// where the forecast was.
function track(q, observed = null, animate = false) {
  if (q.key === 'rain') return '';
  const unitScale = q.key === 'temp' ? 1 : 3;
  const values = [q.forecast, observed].filter((v) => v != null);
  const half = Math.max(1.5 * unitScale, ...values.map((v) => Math.abs(v - q.line) * 1.4));
  const pos = (v) => Math.min(95, Math.max(5, 50 + ((v - q.line) / half) * 42));
  const settled = observed != null;
  return `<div class="track ${q.key} ${settled ? 'settled' : ''}" aria-hidden="true">
    <span class="side l">No</span><span class="side r">Yes</span>
    <div class="rail"></div>
    <div class="mark ln" style="left:50%">${settled ? '' : short(q.line, q.unit)}<i></i></div>
    ${settled ? '' : `<div class="mark fc" style="left:${pos(q.forecast)}%"><i></i>Forecast ${short(q.forecast, q.unit)}</div>`}
    ${settled ? `<div class="mark ob ${animate ? 'go' : ''}" style="--from:${pos(q.forecast)}%;--to:${pos(observed)}%">${short(observed, q.unit)}<i></i></div>` : ''}
  </div>`;
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
  $('#results-top').hidden = !game;
  $('#footer-login').hidden = !!state.user && !state.user.guest;
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
  $('#hero-day').textContent = weekday(round.date);
  renderCountdown();
  $('#hero-station').textContent = game.station
    ? `Checked at ${game.station.name} weather station, ${game.station.km} km away`
    : 'No weather station nearby, so results use the forecast model';

  renderQuestions();
  renderNameCard();
  renderDone();
  renderResults();
  renderTownBoard();
  renderLeagues();
  renderAccount();
}

function renderCountdown() {
  const { round } = state.game ?? {};
  if (!round) return;
  const left = untilText(round.closesAt);
  if (left === 'locked' && !state.lockedShown) {
    state.lockedShown = true;
    renderQuestions();
  }
  const day = `Tomorrow, ${fmtDay(round.date, { day: 'numeric', month: 'short' })}`;
  const dots = round.questions.map((q) => `<i class="${q.myPick != null ? 'on' : ''}"></i>`).join('');
  $('#hero-sub').innerHTML = left === 'locked'
    ? `${day} · answers closed`
    : `${day} · <span class="nowrap">closes in ${left} <span class="dots" role="img" aria-label="${picksMade()} of 3 answered" title="${picksMade()} of 3 answered">${dots}</span></span>`;
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

function renderQuestions() {
  const { round } = state.game;
  $('#questions').innerHTML = round.questions.map((q) => questionCard(q, round)).join('');
}

function questionCard(q, round) {
  const locked = untilText(round.closesAt) === 'locked' ? 'disabled' : '';
  const banked = round.banker === q.key;
  const x = banked ? 2 : 1;
  const caption = captionFor(q);
  return `<article class="card q ${banked ? 'banked' : ''}" data-key="${q.key}">
    <div class="q-head"><div class="q-emoji" aria-hidden="true">${q.emoji}</div>
      <div><div class="q-title">${esc(q.title)}</div><div class="q-detail">${esc(q.detail)}</div></div></div>
    ${track(q)}
    <div class="choices">
      <button class="choice yes" data-pick="1" aria-pressed="${q.myPick === 1}" ${locked}>Yes <small>${q.pays.yes * x} pts</small></button>
      <button class="choice no" data-pick="0" aria-pressed="${q.myPick === 0}" ${locked}>No <small>${q.pays.no * x} pts</small></button>
    </div>
    <div class="q-foot">
      <p class="hint">${esc(caption)}</p>
      <button class="banker" aria-pressed="${banked}" ${locked} aria-label="${banked ? 'Doubled' : 'Double points on'}: ${esc(q.title)}" title="Double points on this one. One a day.">★ ${banked ? 'Doubled' : 'Double'}</button>
    </div>
    ${crowdLine(q)}
  </article>`;
}

// After the first answer: one optional box for the name friends will see.
function renderNameCard() {
  const el = $('#name-card');
  const allIn = state.game && picksMade() === state.game.round.questions.length;
  const show = state.user && ((!state.user.named && (state.askName || (allIn && store.get('nameSkipped') !== '1'))));
  el.hidden = !show;
  if (!show || el.querySelector('form')) return;
  el.innerHTML = `<form id="name-form">
      <label for="name-input" class="big">What do your mates call you?</label>
      <p class="muted small-print">So the group knows it's you on tables and shared links. You're ${esc(state.user.name)} until then.</p>
      <div class="inline">
        <input id="name-input" name="name" maxlength="20" autocomplete="given-name" placeholder="First name or nickname" required>
        <button class="btn" type="submit">Save</button>
      </div>
      <p class="error"></p>
    </form>
    <button class="linkish small-print" data-action="skip-name">Not now</button>`;
}

// Share, challenge and league buttons need a name first; this asks for one
// and carries on once it's saved.
function needName(then) {
  if (state.user?.named) return false;
  state.askName = true;
  state.afterName = then;
  renderNameCard();
  $('#name-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('#name-input')?.focus(), 300);
  toast('Add your name first, so they know who it is');
  return true;
}

function renderDone() {
  const { round, place } = state.game;
  const el = $('#done');
  el.hidden = picksMade() < round.questions.length;
  if (el.hidden) return;
  const friend = state.friend;
  const friendLine = !friend ? ''
    : friend.settled ? `${esc(friend.name)} got ${friend.got} of ${friend.of} in ${esc(friend.town)} on ${weekday(friend.date)}. Start a league and you'll see who's ahead every week.`
      : `You and ${esc(friend.name)} find out on ${resultsDay(friend.date)} morning. Start a league to keep score every week.`;
  const leagueDone = friend && store.get(`friendLeague:${friend.code}`);
  const pushLine = {
    off: '<button class="linkish" data-action="push-on">Tell me my results in the morning</button>',
    install: '<p class="small-print muted">On an iPhone, add WeatherOrNot to your Home Screen (Share, then Add to Home Screen) and we can tell you your results in the morning.</p>',
  }[state.push] ?? '';
  el.innerHTML = `<div class="big">That's your three.</div>
    <p class="muted">Results on ${resultsDay(round.date)} morning${state.push === 'on' ? ", and we'll send you a notification" : ''}. You can change your answers until midnight in ${esc(place.name)}.</p>
    ${friend && !leagueDone ? `<p>${friendLine}</p>` : ''}
    <div class="btn-row">
      ${friend && !leagueDone ? `<button class="btn" data-action="friend-league">Start a league with ${esc(friend.name)}</button>` : ''}
      <button class="btn ${friend && !leagueDone ? 'secondary' : ''}" data-action="challenge">Send to the group chat</button>
    </div>
    ${pushLine}`;
}

// "It hit 18.1°C." in words that fit each question.
function outcomeText(q) {
  const v = fmt(q.result.observed, q.unit);
  if (q.result.voided) return `Scrapped: ${esc(q.result.voided)}. 5 pts each, 10 if doubled.`;
  if (q.result.answer == null) return `Exactly ${v}, a dead heat. 5 pts each, 10 if doubled.`;
  const yes = q.result.answer === 1;
  if (q.key === 'rain') return yes ? `It rained ${v}.` : q.result.observed > 0 ? `Only ${v}, so no.` : 'It stayed dry.';
  if (q.key === 'wind') return `Top gust ${v}.`;
  return yes ? `It hit ${v}.` : `It only reached ${v}.`;
}

// "Something look wrong?": a short form under the results.
const reported = () => store.json('reported') ?? [];
function reportBlock(r) {
  if (!state.user || !r.score) return '';
  if (reported().includes(r.id)) return '<p class="small-print muted">Thanks for flagging it. We\'ll check the station\'s readings.</p>';
  return `<details class="report"><summary class="linkish small-print">Something look wrong?</summary>
    <form id="report-form" class="stack" data-round="${r.id}">
      <select name="key" aria-label="Which question">
        ${r.questions.map((q) => `<option value="${q.key}">${esc(q.title)}</option>`).join('')}
        <option value="">Something else</option>
      </select>
      <textarea name="message" rows="3" maxlength="500" required aria-label="What looks wrong?" placeholder="What looks wrong? For example, it poured all afternoon but it says 0 mm."></textarea>
      <button class="btn small" type="submit">Send</button>
      <p class="small-print muted" style="margin:0">If a station reading is clearly wrong, we scrap that question for everyone and give 5 pts each.</p>
    </form></details>`;
}

// Questions that counted: everything except scrapped ones and dead heats.
const scoredCount = (r) => r.questions.filter((q) => q.result?.answer != null).length;
const markFor = (score) => (!score || score.correct == null ? '' : score.correct ? '✅' : '❌');

// Where the reading came from, and what it was, in one line.
function readingLine(r) {
  const what = weatherLine(r.questions.map((q) => ({ key: q.key, observed: q.result?.observed })));
  return r.source?.type === 'station'
    ? `${esc(r.source.name)}${r.source.km != null ? `, ${r.source.km} km away` : ''}: ${what}.`
    : `Forecast model estimate: ${what}. The station's record was incomplete that day.`;
}

function renderResults() {
  const last = state.game.lastRound;
  const el = $('#results') ?? Object.assign(document.createElement('section'), { id: 'results', className: 'card results' });
  (state.resultsFirst ? $('#results-top') : $('#results-bottom')).append(el);
  // New players don't need yesterday's results for a game they never played.
  el.hidden = !last || (!last.score && !state.stats?.played);
  // Results above the header push it down onto the paler part of the sky.
  document.body.classList.toggle('results-first', state.resultsFirst && !el.hidden);
  if (el.hidden) return;
  const played = !!last.score;
  const animate = state.resultsFirst && !state.animated;
  state.animated = true;
  el.innerHTML = `
    <div class="result-head">
      <h2>${weekday(last.date)}'s results</h2>
      ${played ? `<div class="result-score">${last.score.correct}/${scoredCount(last)}</div>` : ''}
    </div>
    ${played && last.forecast ? `<p class="result-headline">${vsLine(last.score.correct, scoredCount(last), last.forecast.correct)}</p>` : ''}
    <p class="source">${readingLine(last)}</p>
    <ul class="result-list">${last.questions.map((q) => {
      const tags = q.score?.banker ? '<span class="bonus">★ Doubled</span> ' : '';
      const you = q.score && !q.result.voided && q.result.answer != null ? ` You said ${q.score.pick ? 'Yes' : 'No'}.` : '';
      return `<li><span class="r-emoji" aria-hidden="true">${q.emoji}</span>
        <span><strong>${esc(q.title)}</strong>
        <span class="r-actual">${tags}${outcomeText(q)}${you}</span></span>
        <span class="r-points ${q.score?.points ? '' : 'zero'}">${q.score ? `${markFor(q.score)} ${q.score.points ? `+${q.score.points}` : 0}` : ''}</span>
        ${q.result.voided ? '' : track(q, q.result.observed, animate)}</li>`;
    }).join('')}</ul>
    ${played
      ? `<div class="btn-row"><span class="result-score">${last.score.points} pts</span><button class="btn" data-action="share">Share result</button></div>`
      : '<p class="muted">You didn\'t play this one.</p>'}
    ${reportBlock(last)}`;
}

// Standard competition ranking: tied scores share a place, shown as "=1".
function ranked(rows) {
  return rows.map((r) => ({
    ...r,
    rank: rows.findIndex((x) => x.points === r.points) + 1,
    tied: rows.filter((x) => x.points === r.points).length > 1,
  }));
}

function renderBoard(el, rows, emptyText) {
  if (!rows.length) {
    el.outerHTML = `<p class="empty" id="${el.id}">${emptyText}</p>`;
    return;
  }
  const html = ranked(rows).map((r) => `<li class="${r.me ? 'me' : ''} ${r.forecast ? 'forecast' : ''}">
      <span class="rank">${r.tied ? '=' : ''}${r.rank}</span>
      <span class="name">${esc(r.name)}</span><span class="pts">${r.points} pts</span></li>`).join('');
  if (el.tagName === 'OL') el.innerHTML = html;
  else el.outerHTML = `<ol class="board" id="${el.id}">${html}</ol>`;
}

// This week in town, with the forecast playing along as "The Forecast".
function renderTownBoard() {
  const { game } = state;
  const rows = game.leaderboard.length
    ? [...game.leaderboard, { name: 'The Forecast', points: game.forecastPoints, forecast: true }]
        .sort((a, b) => b.points - a.points)
    : [];
  const answered = picksMade() > 0;
  renderBoard($('#leaderboard'), rows,
    `No scores yet this week.${answered ? ` Yours go up on ${resultsDay(game.round.date)} morning.` : ''}`);
  $('#board-title').textContent = `${game.place.name} this week`;
  $('#champion').innerHTML = game.champion
    ? `Last week's best forecaster: <strong>${game.champion.names.map(esc).join(' and ')}</strong> (${game.champion.points} pts)`
    : '';
}

function renderLeagues() {
  $('#leagues-card').hidden = !state.user;
  $('#leagues').innerHTML = state.leagues.map((l) => `
    <div class="league" data-id="${l.id}" data-code="${l.code}" data-name="${esc(l.name)}">
      <div class="league-head"><strong>${esc(l.name)}</strong>
        <span class="league-actions"><button class="btn small" data-action="invite">Invite</button>
          <details class="menu"><summary aria-label="More options">⋯</summary>
            <div class="menu-panel"><button data-action="leave">Leave league</button></div></details></span></div>
      ${l.champion ? `<p class="champion">${esc(l.champion.month)} champion: <strong>${l.champion.names.map(esc).join(' and ')}</strong> (${l.champion.points} pts)</p>` : ''}
      <p class="small-print muted" style="margin:4px 0">This week</p>
      <ol class="board" id="league-${l.id}"></ol>
      <button class="linkish small-print" data-action="share-table">Share this week's table</button>
    </div>`).join('');
  for (const l of state.leagues) renderBoard($(`#league-${l.id}`), l.standings, '');
}

function renderAccount() {
  const { user, stats } = state;
  const el = $('#account');
  el.hidden = !user;
  if (!user) return;
  const mode = el.dataset.mode ?? 'closed';
  const vs = stats?.vsForecast;
  const versus = vs?.calls >= 3
    ? `<p class="versus">Last 30 days: you got <strong>${Math.round((100 * vs.you) / vs.calls)}%</strong> right. The forecast got ${Math.round((100 * vs.forecast) / vs.calls)}%.</p>`
    : '';
  const nameRow = mode === 'rename'
    ? `<form id="rename-form" class="inline">
        <input name="name" maxlength="20" value="${esc(user.name)}" aria-label="Your name" required>
        <button class="btn" type="submit">Save</button>
        <button class="linkish small-print" type="button" data-action="cancel-rename">Cancel</button>
      </form><p class="error"></p>`
    : `<div class="account-row"><p>Playing as <strong>${esc(user.name)}</strong></p>
    <button class="linkish small-print" data-action="change-name">Change name</button></div>`;
  const pushRow = {
    on: '<div class="account-row"><p class="small-print">Morning notifications: on</p><button class="linkish small-print" data-action="push-off">Turn off</button></div>',
    off: '<div class="account-row"><p class="small-print">Morning notifications: off</p><button class="linkish small-print" data-action="push-on">Turn on</button></div>',
    denied: '<p class="small-print muted">Notifications are blocked for this site. You can allow them in your browser settings.</p>',
  }[state.push] ?? '';
  if (!user.guest) {
    el.innerHTML = `${versus}${nameRow}${pushRow}
      <div class="account-row"><p class="muted small-print">Logged in as ${esc(user.account)} · ${stats.points} pts · ${stats.played} ${stats.played === 1 ? 'game' : 'games'}</p>
      <button class="linkish small-print" data-action="logout">Log out</button></div>`;
    return;
  }
  el.innerHTML = `${versus}${nameRow}${pushRow}
    ${mode === 'save'
      ? `<form id="account-form" class="stack">
          <p class="muted small-print" style="margin:0">Pick a login name and password to play on another phone and keep your streak.</p>
          <input name="name" placeholder="Login name" autocomplete="username" required aria-label="Login name">
          <input name="password" type="password" placeholder="Password (6 or more characters)" aria-label="Password" autocomplete="new-password" required>
          <button class="btn" type="submit">Save</button>
          <p class="error"></p>
        </form>`
      : '<button class="linkish small-print" data-action="open-save">Play on another phone</button>'}`;
}

// ---- morning notifications -------------------------------------------------

// 'on', 'off', 'denied', 'install' (an iPhone that needs the home-screen app
// first) or null (not offered: no server key, or a browser without push).
async function pushState() {
  if (!state.pushKey) return null;
  if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) {
    const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
    return iphone && !navigator.standalone ? 'install' : null;
  }
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ? 'on' : 'off';
  } catch {
    return null;
  }
}

const keyBytes = (b64u) => Uint8Array.from(atob(b64u.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function turnOnPush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    state.push = permission === 'denied' ? 'denied' : 'off';
    return toast(permission === 'denied' ? 'Notifications are blocked. You can allow them in your browser settings.' : 'No problem.');
  }
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const key = keyBytes(state.pushKey);
  let sub;
  try {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch {
    // Subscribed before with a different key: start again.
    await (await reg.pushManager.getSubscription())?.unsubscribe();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  await api('/api/push/subscribe', { subscription: sub.toJSON() });
  state.push = 'on';
  toast("Done. We'll tell you how you did in the morning.");
}

async function turnOffPush() {
  const reg = await navigator.serviceWorker?.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
  state.push = await pushState();
}

// The device's notifications go to whoever plays on it now (after logging
// in, say), so tell the server once per visit.
async function syncPush() {
  state.push = await pushState();
  if (state.push !== 'on' || !state.user || syncPush.done) return;
  syncPush.done = true;
  const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
  if (sub) api('/api/push/subscribe', { subscription: sub.toJSON() }).catch(() => {});
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
    toast('Copied. Paste it in the group chat.');
  } catch {
    prompt('Copy this:', payload);
  }
}

// A short link to one of your games: your result once it's in, or a challenge before.
async function shareLink(roundId) {
  const { code } = await api('/api/shares', { roundId });
  return `${location.origin}/r/${code}`;
}

function resultText() {
  const { lastRound: r, place } = state.game;
  const of = scoredCount(r);
  const grid = r.questions.map((q) => `${q.emoji}${q.result?.answer == null ? '➖' : markFor(q.score) || '⬜'}${q.score?.banker ? '⭐' : ''}`).join(' ');
  const where = r.source?.type === 'station' ? r.source.name : 'Forecast model';
  const what = weatherLine(r.questions.map((q) => ({ key: q.key, observed: q.result?.observed })));
  const streak = state.stats?.streak ? ` · 🔥${state.stats.streak}` : '';
  // Only mention the forecast when you beat it.
  const vs = r.forecast && r.score.correct > r.forecast.correct ? ` · forecast ${r.forecast.correct}/${of}` : '';
  return `WeatherOrNot · ${place.name} · ${shortDay(r.date)}\n${where}: ${what}\n${grid}\n${r.score.correct}/${of} · ${r.score.points} pts${streak}${vs}`;
}

function tableText(l) {
  const rows = ranked(l.standings).map((r) => `${r.tied ? '=' : ''}${r.rank}. ${r.name} ${r.points}`).join('\n');
  return `${l.name}, this week so far:\n${rows}`;
}

const inviteText = (name) => `Join ${name} on WeatherOrNot. Three questions a day on tomorrow's weather.`;

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
  const [{ user, stats, pushKey }, { leagues }] = await Promise.all([api('/api/me'), api('/api/leagues')]);
  Object.assign(state, { user, stats, leagues, pushKey });
  await syncPush();
  await loadGame();
}

// Double: tap to double an answer, tap again to clear it.
$('#questions').addEventListener('click', async (e) => {
  const btn = e.target.closest('.banker');
  if (!btn || btn.disabled) return;
  const key = btn.closest('.q').dataset.key;
  try {
    const { round } = await api('/api/banker', {
      roundId: state.game.round.id, key: state.game.round.banker === key ? null : key,
    });
    state.game.round = round;
    renderQuestions();
    $(`.q[data-key="${key}"] .banker`)?.focus();
    renderDone();
    if (!state.user) {
      await loadAll();
      $(`.q[data-key="${key}"] .banker`)?.focus();
    }
    toast(round.banker ? 'Doubled. One a day: tap another to move it.' : 'No longer doubled.');
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
    renderNameCard();
    $('#streak').hidden = !stats.streak;
    $('#streak').textContent = `🔥 ${stats.streak}`;
    if (firstPlay) {
      renderLeagues();
      renderAccount();
    }
    if (before < round.questions.length && picksMade() === round.questions.length) {
      setTimeout(() => $('#done').scrollIntoView({ behavior: 'smooth', block: 'center' }), 250);
    }
  } catch (err) {
    toast(err.message);
    render();
  }
});

const actions = {
  async share() {
    if (needName(actions.share)) return;
    hit('share-result');
    share(resultText(), await shareLink(state.game.lastRound.id));
  },
  async challenge() {
    if (needName(actions.challenge)) return;
    hit('share-challenge');
    share(`I've answered tomorrow's weather questions for ${state.game.place.name}. Your go:`, await shareLink(state.game.round.id));
  },
  async 'friend-league'() {
    if (needName(actions['friend-league'])) return;
    const { friend } = state;
    const name = `${friend.name} and ${state.user.name}`.slice(0, 40);
    const { league } = await api('/api/leagues', { name });
    store.set(`friendLeague:${friend.code}`, '1');
    await loadAll();
    hit('share-league');
    share(`I've started a WeatherOrNot league for us, so we can keep score. Three questions a day:`, `${location.origin}/join/${league.code}`);
  },
  'share-table'(league) {
    if (needName(() => actions['share-table'](league))) return;
    const l = state.leagues.find((x) => String(x.id) === league.dataset.id);
    hit('share-league');
    share(tableText(l), `${location.origin}/join/${l.code}`);
  },
  invite(league) {
    if (needName(() => actions.invite(league))) return;
    hit('share-league');
    share(inviteText(league.dataset.name), `${location.origin}/join/${league.dataset.code}`);
  },
  async leave(league) {
    if (!confirm(`Leave ${league.dataset.name}?`)) return;
    await api('/api/leagues/leave', { leagueId: Number(league.dataset.id) });
    loadAll();
  },
  async 'push-on'() {
    await turnOnPush();
    renderDone();
    renderAccount();
  },
  async 'push-off'() {
    await turnOffPush();
    toast('Notifications off.');
    renderDone();
    renderAccount();
  },
  async logout() {
    // The next person on this phone shouldn't get your results.
    await turnOffPush().catch(() => {});
    await api('/api/logout', {});
    loadAll();
  },
  retry: () => loadGame(),
  'change-town': () => openPicker(),
  'skip-name'() {
    store.set('nameSkipped', '1');
    state.askName = false;
    state.afterName = null;
    $('#name-card').hidden = true;
  },
  'change-name'() {
    $('#account').dataset.mode = 'rename';
    renderAccount();
    $('#account input').select();
  },
  'cancel-rename'() {
    $('#account').dataset.mode = 'closed';
    renderAccount();
  },
  'open-save'() {
    $('#account').dataset.mode = 'save';
    renderAccount();
    $('#account input').focus();
  },
  'open-login'() {
    $('#login-dialog').showModal();
    $('#login-dialog input').focus();
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  const action = actions[el?.dataset.action];
  if (!action) return;
  try {
    await action(e.target.closest('.league'), e);
  } catch (err) {
    toast(err.message);
  }
});

// Close any open ⋯ menu when tapping elsewhere.
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.menu[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  const data = new FormData(form);
  if (form.id === 'name-form') {
    e.preventDefault();
    try {
      const { name } = await api('/api/name', { name: data.get('name') });
      state.user = { ...state.user, name, named: true };
      state.askName = false;
      $('#name-card').hidden = true;
      $('#name-card').innerHTML = '';
      toast(`Thanks, ${name}.`);
      const next = state.afterName;
      state.afterName = null;
      await loadAll();
      next?.();
    } catch (err) {
      form.querySelector('.error').textContent = err.message;
    }
  }
  if (form.id === 'rename-form') {
    e.preventDefault();
    try {
      const { name } = await api('/api/name', { name: data.get('name') });
      state.user = { ...state.user, name, named: true };
      $('#account').dataset.mode = 'closed';
      toast(`Thanks, ${name}.`);
      loadAll();
    } catch (err) {
      $('#account .error').textContent = err.message;
    }
  }
  if (form.id === 'account-form') {
    e.preventDefault();
    try {
      await api('/api/account', { name: data.get('name'), password: data.get('password') });
      $('#account').dataset.mode = 'closed';
      toast('Saved. Log in with it on your other phone.');
      loadAll();
    } catch (err) {
      form.querySelector('.error').textContent = err.message;
    }
  }
  if (form.id === 'login-form') {
    e.preventDefault();
    try {
      const result = await api('/api/login', { name: data.get('name'), password: data.get('password') });
      $('#login-dialog').close();
      toast(result.moved ? 'Logged in. Your answers from this phone came with you.' : 'Logged in.');
      syncPush.done = false; // this phone's notifications move to the account
      const me = await api('/api/me');
      // A new phone: carry on where they last played.
      if (!state.placeId && me.stats?.lastPlace) {
        hideIntro();
        state.placeId = me.stats.lastPlace.id;
        state.placeName = me.stats.lastPlace.name;
      }
      loadAll();
    } catch (err) {
      form.querySelector('.error').textContent = err.message;
    }
  }
  if (form.id === 'report-form') {
    e.preventDefault();
    const roundId = Number(form.dataset.round);
    try {
      await api('/api/reports', { roundId, key: data.get('key') || null, message: data.get('message') });
      store.set('reported', JSON.stringify([...reported(), roundId].slice(-30)));
      toast("Thanks. We'll check the station's readings.");
      renderResults();
    } catch (err) {
      toast(err.message);
    }
  }
  if (form.id === 'create-league') {
    e.preventDefault();
    const button = form.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const { league } = await api('/api/leagues', { name: data.get('name') });
      form.reset();
      await loadAll();
      if (needName(() => actions.invite($(`.league[data-id="${league.id}"]`)))) return;
      hit('share-league');
      share(inviteText(league.name), `${location.origin}/join/${league.code}`);
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
  hideIntro();
  $('#invite').hidden = true;
  // Picking a town from an invite link joins the league too: one tap.
  if (state.pendingJoin) {
    const { code, name } = state.pendingJoin;
    state.pendingJoin = null;
    try {
      await api('/api/leagues/join', { code });
      toast(`You're in ${name}. Now your three answers.`);
    } catch (err) {
      toast(err.message);
    }
    await loadAll();
  } else {
    await loadGame();
  }
}

// ---- first-visit intro -------------------------------------------------------

const INTRO_CITIES = ['Manchester', 'Glasgow', 'Douglas', 'Belfast'];

// What a friend's link says: "Sam got 2 of 3 in Douglas on Monday."
function friendText(f) {
  return f.settled
    ? `${esc(f.name)} got ${f.got} of ${f.of} in ${esc(f.town)} on ${weekday(f.date)}.`
    : `${esc(f.name)} has answered tomorrow's questions for ${esc(f.town)}. Your go.`;
}

function showIntro({ guess, friend }) {
  hit('intro');
  document.body.classList.add('intro-mode');
  $('#intro').hidden = false;
  const cities = INTRO_CITIES.map((name) => state.popular.find((p) => p.name === name)).filter(Boolean);
  // A friend's link, or a town we can guess, becomes the one big button.
  const start = friend ? { id: friend.place, name: friend.town } : guess.match;
  $('#intro-cities').innerHTML = start ? ''
    : cities.map((p) => `<button class="city" data-intro-place="${esc(p.id)}">${esc(p.name)}</button>`).join('');
  $('#intro-cities').onclick = (e) => {
    const id = e.target.closest('[data-intro-place]')?.dataset.introPlace;
    if (id) choosePlace(cities.find((p) => p.id === id));
  };
  if (start) {
    $('#intro-guess').hidden = false;
    $('#intro-guess').textContent = `Play ${start.name}`;
    $('#intro-guess').onclick = () => choosePlace(start);
    $('#intro-pick').textContent = 'Pick a different town';
    $('#intro-pick').classList.add('linkish');
    $('#intro-pick').classList.remove('btn', 'btn-big');
  }
  if (friend) {
    $('.intro-text h1').hidden = true;
    $('#intro-from').hidden = false;
    $('#intro-from').innerHTML = `<div class="big">${friendText(friend)}</div>
      ${friend.settled ? `<p class="muted" style="margin:0">${esc(friend.reading)}</p>` : ''}`;
  }
  $('#intro-pick').onclick = () => openPicker(guess.hint ?? '');
}

function hideIntro() {
  document.body.classList.remove('intro-mode');
  $('#intro').hidden = true;
}

// A friend's link for someone who already plays: a card above the game.
function showFriendCard(friend) {
  const el = $('#invite');
  el.hidden = false;
  const elsewhere = friend.place !== state.placeId;
  el.innerHTML = `<div class="big">${friendText(friend)}</div>
    ${friend.settled && elsewhere ? `<p class="muted" style="margin:0">${esc(friend.reading)}</p>` : ''}
    ${elsewhere ? `<button class="btn">Play ${esc(friend.town)}</button>` : ''}`;
  el.querySelector('button')?.addEventListener('click', () => choosePlace({ id: friend.place, name: friend.town }));
}

// /r/<code>: a friend's shared result or challenge.
async function readFriendLink() {
  const code = location.pathname.match(/^\/r\/([A-Za-z0-9]{6})\/?$/)?.[1];
  if (!location.pathname.startsWith('/r/')) return null;
  history.replaceState(null, '', '/');
  if (!code) return null;
  hit('open-shared');
  try {
    const { share: s } = await api(`/api/shares/view?code=${code}`);
    const friend = {
      code, name: s.name, place: s.place.id, town: s.place.name, date: s.date, settled: s.settled, got: s.got, of: s.of,
      reading: s.settled ? `${s.source?.type === 'station' ? s.source.name : 'Forecast model estimate'}: ${weatherLine(s.questions)}.` : '',
    };
    store.set('friend', JSON.stringify({ ...friend, seen: Date.now() }));
    return friend;
  } catch {
    toast("That link doesn't work. Ask for a fresh one?");
    return null;
  }
}

// A friend's link from the last few days, for the "start a league" button.
function recentFriend() {
  const f = store.json('friend');
  return f && Date.now() - f.seen < 4 * 86_400_000 ? f : null;
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
  if (query) search(query); else listPlaces(state.popular, 'Popular towns');
  $('#place-dialog').showModal();
  $('#place-search').focus();
}

async function search(query) {
  const token = (search.token = Symbol());
  if (query.trim().length < 2) return listPlaces(state.popular, 'Popular towns');
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

// First visit: guess the town from the device's time zone where that's
// unambiguous (Europe/Isle_of_Man means Douglas). The whole UK shares
// Europe/London, so UK visitors get the town list instead.
function guessPlace() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  const matches = state.popular.filter((p) => p.tz === tz);
  return matches.length === 1 ? { match: matches[0] } : { hint: '' };
}

// ---- invite links --------------------------------------------------------

async function handleInvite() {
  if (!location.pathname.startsWith('/join/')) return;
  const code = location.pathname.match(/^\/join\/([A-Za-z0-9]{6})\/?$/)?.[1];
  history.replaceState(null, '', '/');
  if (!code) return toast("That invite link doesn't work. Ask for a fresh one?");
  try {
    const { league } = await api(`/api/leagues/preview?code=${code}`);
    if (state.leagues.some((l) => l.code === league.code)) return toast(`You're already in ${league.name}`);
    const el = $('#invite');
    el.hidden = false;
    const who = `${league.owner ? `${esc(league.owner)} invited you to` : "You're invited to"} ${esc(league.name)}`;
    const players = `${league.members} ${league.members === 1 ? 'player' : 'players'} guessing tomorrow's weather.`;
    // New visitors: picking a town on the intro joins the league in the same tap.
    if (!$('#intro').hidden) {
      state.pendingJoin = { code, name: league.name };
      el.innerHTML = `<div class="big">${who}</div><p class="muted" style="margin:0">${players} Pick your town and you're in.</p>`;
      $('.intro-text h1').hidden = true;
      $('#intro-extra').hidden = true;
      const join = (b) => { if (!b.hidden && !b.textContent.endsWith('and join')) b.textContent += ' and join'; };
      join($('#intro-guess'));
      join($('#intro-pick'));
      return;
    }
    el.innerHTML = `<div class="big">${who}</div><p class="muted" style="margin:0">${players}</p>
      <button class="btn">Join the league</button>`;
    el.querySelector('button').onclick = async () => {
      try {
        await api('/api/leagues/join', { code });
        el.hidden = true;
        toast(`You're in ${league.name}.`);
        await loadAll();
        $('#questions').scrollIntoView({ behavior: 'smooth' });
      } catch (err) {
        toast(err.message);
      }
    };
  } catch {
    toast("That invite link doesn't work. Ask for a fresh one?");
  }
}

// ---- start -----------------------------------------------------------------

$('#year').textContent = new Date().getFullYear();

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
  if (new URLSearchParams(location.search).get('from') === 'push') {
    hit('open-push');
    history.replaceState(null, '', '/');
  }
  const friend = await readFriendLink();
  state.friend = friend ?? recentFriend();
  const me = await api('/api/me');
  // A returning player on a new browser carries on where they last played.
  const place = saved ? JSON.parse(saved) : me.stats?.lastPlace ?? null;
  if (place) {
    state.placeId = place.id;
    state.placeName = place.name;
  }
  await loadAll();
  if (!place) showIntro({ guess, friend });
  else if (friend) showFriendCard(friend);
  await handleInvite();
  setInterval(renderCountdown, 30_000);
})();
