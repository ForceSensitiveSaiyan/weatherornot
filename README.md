# ☁️ WeatherOrNot

A free daily game run by [ai.doo](https://aidoo.biz). Answer 3 quick questions on **tomorrow's** weather where you live, try to beat the forecast, keep your streak going and beat your mates. No money involved.

What changed and when: `CHANGELOG.md`. Plans and the reasons behind them: `ROADMAP.md`. Putting it live: `deploy/DEPLOY.md`.

**For the UK, the Isle of Man and the Channel Islands only.** That's where games can be settled on official weather station reports. Temperatures are in °C, wind in mph, dates in UK format.

## How it plays

- **First visit.** An intro ("Reckon you can beat the forecast?") explains the game with two example questions, then you pick your town with one tap (Manchester, Glasgow, Douglas, Belfast) or search for it. A friend's link puts their result at the top and makes their town the one big button. An Isle of Man phone gets a one-tap "Play Douglas". Search only offers towns within 45 km of a weather station; anything further shows greyed out with the distance.
- **3 questions a day, built around the forecast** so that just copying it is no better than guessing:
  - ☔ *Will it rain?* (1 mm or more) pays odds. The chance comes from how often UK days with that forecast amount actually saw rain, and a right call pays about 5 ÷ that chance (between 1 and 50). Either side is worth the same on average if all you know is the forecast.
  - 🌡️ *Will it top 14°C?* and 💨 *Gusts over 22.2 mph?* put the line on the forecast, shifted by how that place's forecasts have been running over its last 30 games (highs in most UK cities beat the forecast more often than not). A right answer pays 10. Each one shows a dial: the number asked in the middle and the forecast as a dot, so you can see how close it is. On the results, the measured reading slides onto the same dial.
- **No signup to play.** Your first tap makes a guest account (e.g. *BreezyOtter42*), then the game asks "What do your mates call you?" so tables and shared links show a real name. Add a login name and password only to play on another phone.
- **Answers close at local midnight.** You can change them until then. Results come in the morning after.
- **Scoring.** Odds for rain, 10 for temperature and wind. Pick one question a day for ★ **Double points**. If the weather lands exactly on the number asked, the question is void and everyone who answered gets 5 (10 if doubled).
- **You vs the forecast.** Each result says how just copying the forecast would have done ("Two from three. The forecast got all three."), and "The Forecast" plays along on every town's weekly table.
- **Why it's built this way:** `npm run simulate` plays thousands of simulated leagues with forecast copiers, guessers, a long-shot punter and players with a small local edge (`--days=7` for weekly tables, `--cap=50` to try capping doubled points). See `ROADMAP.md` for the results.
- **Streaks, results and sharing.** Each morning shows the results, led by what the station measured, with a spoiler-free grid for the group chat (⭐ marks the doubled question). The forecast is only mentioned when you beat it:
  ```
  WeatherOrNot · Douglas · Mon 5 Oct
  Ronaldsway Airport: dry, 13.7°C, gusts 40 mph
  ☔️✅⭐ 🌡️❌ 💨✅
  2/3 · 34 pts · 🔥4 · forecast 1/3
  https://playweatherornot.co.uk/r/AB12CD
  ```
  The short link (`/r/CODE`) opens with "Sam got 2 of 3 in Douglas on Monday" and a one-tap "Play Douglas", and its WhatsApp preview says the same. Before the results are in, "Send to the group chat" shares a challenge link the same way. Someone who arrives from a friend's link gets "Start a league with Sam" once they've answered.
- **Leagues and titles.** Create a league and send the invite link (`/join/ABC123`); picking your town from it joins in the same tap, and the link preview says who invited you. League tables run weekly, with a monthly champion. Each town crowns last week's best forecaster.
- **Problem reports.** "Something look wrong? Tell us" on results. On the admin page we can scrap a question for everyone if a station reading is clearly wrong.
- **The page looks like tomorrow's sky** (sunny, cloudy, rain, snow, storm, fog), and it can be installed to a phone's home screen.

## Where the results come from

Each game settles on the nearest official weather station within 50 km (hourly SYNOP reports: the day's high, rainfall and strongest gust), via [OGIMET](https://www.ogimet.com/)'s archive of WMO reports. Station locations come from NOAA's ISD station list (`src/data/uk-stations.json`). If no nearby station has a complete day 36 hours after midnight, the game falls back to the forecast model's own estimate, and the result says so.

Forecasts (the lines and rain odds) come from Open-Meteo. Set `OBSERVATIONS=model` to settle on the model instead of stations.

## Running it

Needs Node.js 22.5 or newer. There are no dependencies to install: it uses Node's built-in SQLite.

```sh
npm start          # real weather and city search from Open-Meteo, http://localhost:3000
npm run dev        # offline fake weather and a fixed list of cities, restarts on changes
npm test
```

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DB_PATH` | `weatherornot.db` | SQLite file. Databases from the old points-betting version are refused; delete them first. |
| `WEATHER_PROVIDER` | `open-meteo` | `mock` for fake weather and city search |
| `ADMIN_TOKEN` | unset | Turns on the admin page (`/admin.html`): stats, player reports and login links for forgotten passwords. Use a long random value. |
| `OBSERVATIONS` | stations | `model` to settle on the forecast model instead of weather stations |
| `PUBLIC_URL` | from the request | The site's public address, e.g. `https://playweatherornot.co.uk`. Set it in production so link previews (WhatsApp, Facebook, X) get absolute image URLs. |
| `TRUST_PROXY` | `0` | How many proxies sit in front of the app (usually `1` on a host). Without it, every player looks like the same visitor to the rate limits. Leave at `0` if the app faces the internet directly. |
| `BACKUP_DIR` | `backups` next to the database | Where the daily database copies go. `off` turns them off. |
| `BACKUP_KEEP` | `14` | How many daily copies to keep. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | unset | Turn on morning notifications. Make a pair with `npm run vapid-keys`. Changing them turns everyone's notifications off. |
| `VAPID_SUBJECT` | `mailto:hello@aidoo.biz` | Who push services contact if something goes wrong. |

## Hosting

Runs at https://playweatherornot.co.uk on the ai.doo Hetzner VPS (once the one-off setup in `deploy/DEPLOY.md` is done). It's deployed the same way as the game scoreboards: on every push to `main`, GitHub Actions (`.github/workflows/deploy.yml`) runs the tests, copies the code to `/opt/weatherornot` and runs it with Docker Compose on `127.0.0.1:9890`. The VPS's own Caddy handles HTTPS and forwards to it (`deploy/Caddyfile`). **First-time setup and day-to-day running: `deploy/DEPLOY.md`.**

What runs by itself:

- **Settlement** every 10 minutes, once each day's station reports are in.
- **Morning notifications** (with the VAPID keys set): each player's result goes to the phones where they turned notifications on, once it's settled and not before 7.30am.
- **Backups** once a day: a full copy of the database in `/opt/weatherornot/data/backups`, kept for 14 days. These sit on the same disk, so also use Hetzner's server backups or copy them elsewhere.
- **Clean restarts:** on a deploy the app finishes its requests and closes the database before stopping.

Anywhere else works too: it's one container (`Dockerfile`) that needs a persistent disk at `/data`, `PUBLIC_URL`, `TRUST_PROXY` set to the number of proxies in front, and a health check on `/healthz`. Run one copy only; each copy would have its own database.

## Stats

`/admin.html` (needs `ADMIN_TOKEN`) shows, for each of the last 14 days: how many played, how many were new, what share of the day before's players came back, visits, first visits, shares, and visits from shared links. Most of it comes from the game's own tables. Visits and shares are anonymous daily totals: no IDs, cookies or addresses are stored, so there's no cookie banner to add.

**Forgotten passwords:** there are no email addresses on accounts. A player who's still logged in on one phone can get a one-time login link there ("Play on another phone") and set a new password. Anyone locked out everywhere emails hello@aidoo.biz; the admin page makes a login link for their login name that works once within 24 hours.

## Layout

```
src/server.js     HTTP server, JSON API, rate limiting, static files, settlement timer
src/game.js       game rules: guests and accounts, daily rounds, picks, scoring, streaks, leagues
src/questions.js  the daily questions: rain odds, lines, how each one resolves
src/scoring.js    scoring a player's day (shared with the simulator)
src/bias.js       how far a place's weather has been running from the forecast
scripts/simulate.mjs  game-design simulator (synthetic or real UK data)
src/places.js     city search (Open-Meteo geocoding) and the popular-cities list
src/weather.js    Open-Meteo and mock weather providers
src/time.js       local dates, local midnight, game numbers
src/stats.js      the admin page's numbers (players, comebacks, shares)
public/words.js   wording shared by the page and the link previews (weather line, score line)
src/backup.js     daily database copies
Dockerfile        container for hosting
compose.yaml      how the VPS runs it
deploy/           Caddy config and the step-by-step deploy guide
.github/workflows/deploy.yml  tests, then deploys to the VPS
public/           the web app (plain HTML/CSS/JS), icons, share image (og.png),
                  privacy.html, terms.html, admin.html (stats, reports, login links)
public/fonts/     Fredoka, self-hosted (SIL Open Font License, see OFL.txt)
test/             node:test suites
```

## Before launching publicly

- **Legal check of Privacy and Terms,** then remove their "Draft" banners.
- **One-off VPS setup** (`deploy/DEPLOY.md`): DNS, Caddy, GitHub secrets, first deploy. Turn on Hetzner's server backups too.
- **Met Office DataHub** as the main source of station readings (OGIMET stays as the backup). Waiting on the account.

- **Weather data licence.** Open-Meteo's free API is for non-commercial use only. Anything with ads or revenue needs their paid plan. Their CC BY 4.0 attribution is in the footer.
- **No password reset yet.** Saved accounts are name + password only.
- **No push notifications yet.** Players have to come back to see results; a morning "You called it ☔ 3/3" notification is planned (`ROADMAP.md`, Phase 3).
- **A single SQLite file** comfortably handles thousands of players. It's backed up daily (see Hosting).
- **Open-Meteo rate limits.** The free API allows about 10,000 calls a day. The app only fetches a forecast the first time a place is opened each day and once more to settle it, and it retries short outages and rate limits. Results are cached in the database.
