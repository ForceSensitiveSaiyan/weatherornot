# ☁️ WeatherOrNot

A free daily game. Make 3 calls on **tomorrow's** weather where you live, keep your streak going and beat your mates. No money involved.

**For the UK, the Isle of Man and the Channel Islands only.** That's where games can be settled on official weather station reports. Temperatures are in °C, wind in mph, dates in UK format.

## How it plays

- **Your city.** Search any town or city. On a first visit, UK players pick from the popular UK cities (the whole UK shares one time zone, so there's no way to guess). Elsewhere, the app guesses from the device's time zone.
- **3 calls a day, and the forecast sets the line instead of giving the answer**, so copying it is no better than guessing:
  - ☔ *Will it rain?* (1 mm or more) pays odds. The chance comes from how often UK days with that forecast amount actually saw rain, and a right call pays about 5 ÷ that chance (between 1 and 50). Either side is worth the same on average if all you know is the forecast.
  - 🌡️ *Will it top 14°C?* and 💨 *Gusts over 22.2 mph?* put the line on the forecast, shifted by how that place's forecasts have been running over its last 30 games (highs in most UK cities beat the forecast more often than not). A right call pays 10.
- **No signup to play.** Your first tap makes a guest account (e.g. *BreezyOtter42*). Save it with a name and password to play on other devices.
- **Locks at local midnight.** You can change your calls until then. Results come in once the day is over.
- **Scoring.** Odds for rain, 10 for the lines. Pick one call a day as your ★ **banker** for double points. If the weather lands exactly on a line, the call is void and everyone who made it gets 5.
- **Why it's built this way:** `npm run simulate` plays thousands of simulated months with forecast copiers, guessers and players with a small local edge. See `ROADMAP.md` (Phase 1) for the results.
- **Streaks, results and sharing.** Each morning shows yesterday's results with a spoiler-free emoji grid to share:
  ```
  WeatherOrNot #4 · Cape Town
  ☔✅ 🌡️❌ ❄️✅
  2/3 · 20 pts · 🔥2
  ```
- **Leagues.** Create one and send the invite link (`/join/ABC123`). Friends who open it see the league and join with one tap.
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
| `ADMIN_TOKEN` | unset | Turns on the admin page (`/admin.html`) for reviewing player reports. Use a long random value. |
| `OBSERVATIONS` | stations | `model` to settle on the forecast model instead of weather stations |
| `PUBLIC_URL` | from the request | The site's public address, e.g. `https://weatherornot.app`. Set it in production so link previews (WhatsApp, Facebook, X) get absolute image URLs. |
| `TRUST_PROXY` | `0` | How many proxies sit in front of the app (usually `1` on a host). Without it, every player looks like the same visitor to the rate limits. Leave at `0` if the app faces the internet directly. |
| `BACKUP_DIR` | `backups` next to the database | Where the daily database copies go. `off` turns them off. |
| `BACKUP_KEEP` | `14` | How many daily copies to keep. |

## Hosting

Live at https://playweatherornot.co.uk on the ai.doo Hetzner VPS. It's deployed the same way as the game scoreboards: on every push to `main`, GitHub Actions (`.github/workflows/deploy.yml`) runs the tests, copies the code to `/opt/weatherornot` and runs it with Docker Compose on `127.0.0.1:9890`. The VPS's own Caddy handles HTTPS and forwards to it (`deploy/Caddyfile`). **First-time setup and day-to-day running: `deploy/DEPLOY.md`.**

What runs by itself:

- **Settlement** every 10 minutes, once each day's station reports are in.
- **Backups** once a day: a full copy of the database in `/opt/weatherornot/data/backups`, kept for 14 days. These sit on the same disk, so also use Hetzner's server backups or copy them elsewhere.
- **Clean restarts:** on a deploy the app finishes its requests and closes the database before stopping.

Anywhere else works too: it's one container (`Dockerfile`) that needs a persistent disk at `/data`, `PUBLIC_URL`, `TRUST_PROXY` set to the number of proxies in front, and a health check on `/healthz`. Run one copy only; each copy would have its own database.

## Stats

`/admin.html` (needs `ADMIN_TOKEN`) shows, for each of the last 14 days: how many played, how many were new, what share of the day before's players came back, visits, first visits, shares, and visits from shared links. Most of it comes from the game's own tables. Visits and shares are anonymous daily totals: no IDs, cookies or addresses are stored, so there's no cookie banner to add.

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
src/backup.js     daily database copies
Dockerfile        container for hosting
compose.yaml      how the VPS runs it
deploy/           Caddy config and the step-by-step deploy guide
.github/workflows/deploy.yml  tests, then deploys to the VPS
public/           the web app (plain HTML/CSS/JS), icons, share image (og.png)
public/fonts/     Fredoka, self-hosted (SIL Open Font License, see OFL.txt)
test/             node:test suites
```

## Before launching publicly

- **Weather data licence.** Open-Meteo's free API is for non-commercial use only. Anything with ads or revenue needs their paid plan. Their CC BY 4.0 attribution is in the footer.
- **No password reset yet.** Saved accounts are name + password only.
- **No push notifications yet.** Players have to come back to see results; a morning "You called it ☔ 3/3" notification is the next big retention feature.
- **A single SQLite file** comfortably handles thousands of players. It's backed up daily (see Hosting).
- **Open-Meteo rate limits.** The free API allows about 10,000 calls a day. The app only fetches a forecast the first time a place is opened each day and once more to settle it, and it retries short outages and rate limits. Results are cached in the database.
