# ☁️ WeatherOrNot

Bet points on tomorrow's weather. Free-to-play: everyone starts with 1,000 points, and there's no real money involved.

## How it works

- **Markets open automatically** every day for each city's *tomorrow*:
  - *Will the high be above X°C?* The line is the forecast high rounded, +0.5, so it's close to a coin flip and there are no ties.
  - *Will it rain at least 1 mm?*
  - *Will wind gusts top X km/h?* The line is set just off the forecast.
  - *Will it snow at least 0.5 cm?* Only offered when snow is plausible (snow in the forecast, or a low of 2°C or below).
- **Pari-mutuel pools.** Every stake goes into one pot and the winning side splits it in proportion to what they bet. The house never takes a side, so there are no odds to beat just by reading the public forecast. If nobody backed the winning side, everyone gets their stake back.
- **Betting closes** at local midnight when the target day starts in that city.
- **Settlement** runs every 10 minutes and pays out once the day is over, using [Open-Meteo](https://open-meteo.com/) daily data (max/min temperature, precipitation, snowfall, max wind gusts) for the city's coordinates.
- **Daily top-up.** Players under 100 points can top back up to 100 once per (UTC) day, so going broke isn't game over.
- **Leagues.** Anyone can create a private league and share its 6-character code; members see their own standings alongside the global leaderboard.

## Running it

Needs Node.js 22.5 or newer. There are no dependencies to install: it uses Node's built-in SQLite.

```sh
npm start          # real weather from Open-Meteo, http://localhost:3000
npm run dev        # offline fake weather, restarts on file changes
npm test
```

Environment variables:

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DB_PATH` | `weatherornot.db` | SQLite file |
| `WEATHER_PROVIDER` | `open-meteo` | `mock` for deterministic fake weather |

## Layout

```
src/server.js   HTTP server, JSON API, static files, settlement timer
src/game.js     game rules: accounts, markets, betting, settlement, top-ups, leagues
src/markets.js  bet types: how each sets its line and resolves
src/pool.js     pari-mutuel payout math
src/weather.js  Open-Meteo and mock weather providers
src/cities.js   cities, coordinates and time zones
public/         the web UI (plain HTML/CSS/JS)
test/           node:test suites
```

## Known limitations / next steps

- Settlement uses Open-Meteo's gridded model data for the city's coordinates, not a specific official weather station. Fine for a game; a real-money product would need a named station (e.g. NOAA/NWS) as its source of truth.
- New bet types apply from the next day's markets onward; days that already have markets aren't backfilled.
- Adding a bet type is one entry in `src/markets.js`.
- League standings rank members by their overall points, not points earned since joining.
- User-chosen cities (via Open-Meteo's geocoding API) are a natural next feature.
