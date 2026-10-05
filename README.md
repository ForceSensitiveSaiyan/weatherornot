# ☁️ WeatherOrNot

A free daily game: make 3 calls on **tomorrow's** weather where you live, keep your streak going, and beat your friends. No money involved.

## How it plays

- **Your city.** Search any town or city. On a first visit the app guesses your city from your device's time zone.
- **3 calls a day.** Every place gets the same three yes/no questions about tomorrow:
  - ☔ *Will it rain?* (at least 1 mm)
  - 🌡️ *Warmer than today?* (judged against today's *actual* high)
  - A wildcard picked from the forecast: ❄️ *Will it snow?* when it's cold, 🥵 *Will it hit 30°C?* when it's hot, otherwise 💨 *Gusts over 40 km/h?* (lines are set from the forecast)
- **No signup to play.** Your first tap makes a guest account (e.g. *BreezyOtter42*). Save it with a name and password to play on other devices.
- **Locks at local midnight.** You can change your calls until then. Results come in once the day is over.
- **Scoring.** 10 points per right call, **+10** if you called it against the forecast, **+5** if a third or fewer of the players agreed with you.
- **Streaks, results and sharing.** Each morning shows yesterday's results with a spoiler-free emoji grid to share:
  ```
  WeatherOrNot #4 · Cape Town
  ☔✅ 🌡️❌ ❄️✅
  2/3 · 20 pts · 🔥2
  ```
- **Leagues.** Create one and send the invite link (`/join/ABC123`). Friends who open it see the league and join with one tap.
- **The page looks like tomorrow's sky** (sunny, cloudy, rain, snow, storm, fog), and it can be installed to a phone's home screen.

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
| `PUBLIC_URL` | from the request | The site's public address, e.g. `https://weatherornot.app`. Set it in production so link previews (WhatsApp, Facebook, X) get absolute image URLs. |

## Layout

```
src/server.js     HTTP server, JSON API, rate limiting, static files, settlement timer
src/game.js       game rules: guests and accounts, daily rounds, picks, scoring, streaks, leagues
src/questions.js  the daily questions: wildcard choice, lines, how each one resolves
src/places.js     city search (Open-Meteo geocoding) and the popular-cities list
src/weather.js    Open-Meteo and mock weather providers
src/time.js       local dates, local midnight, game numbers
public/           the web app (plain HTML/CSS/JS), icons, share image (og.png)
public/fonts/     Fredoka, self-hosted (SIL Open Font License, see OFL.txt)
test/             node:test suites
```

## Before launching publicly

- **Weather data licence.** Open-Meteo's free API is for non-commercial use only. Anything with ads or revenue needs their paid plan. Their CC BY 4.0 attribution is in the footer.
- **Results use model data for a grid square,** not a specific official weather station. Fine for a game, but say so, because "it rained at my house!" disputes will happen.
- **No password reset yet.** Saved accounts are name + password only.
- **No push notifications yet.** Players have to come back to see results; a morning "You called it ☔ 3/3" notification is the next big retention feature.
- **A single SQLite file** comfortably handles thousands of players. Back it up.
