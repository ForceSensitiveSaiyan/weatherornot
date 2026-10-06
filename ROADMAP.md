# WeatherOrNot roadmap

The goal: a free daily weather game that UK friend groups play every morning and share in their group chats. We test with 20 to 30 people before pushing it anywhere bigger.

Status key: ✅ done · 🔨 in progress · ⏭ next · 💭 later

## Done so far

- ✅ Daily game: 3 yes/no calls on tomorrow's weather, locked at local midnight, settled from real observed weather
- ✅ Guest play (no signup), saved accounts, streaks, weekly city leaderboards, leagues with invite links
- ✅ Share grid, link-preview image, installable on a phone's home screen
- ✅ Design review quick wins (contrast, type, layout, feedback on picks)
- ✅ UK tailoring (°C, mph, UK cities first, British copy)
- ✅ Verified against live Open-Meteo data, with retries for outages and rate limits

## Phase 1: Fix the core game ✅

**Problem:** copying the forecast is the best strategy. The forecast is right most days, so copying it scores well. The +10 "beat the forecast" bonus doesn't pay enough to outweigh the extra misses. If everyone copies, everyone scores the same, and there's nothing to talk about. See "Why the game needs to change" below.

- [x] Set lines *at* the forecast, so the forecast itself is a coin flip on every question ("Will Manchester top 17.5°C?" when the forecast says 17.5°C), with rain paying odds from a calibrated table
- [x] ~~Nearest guess~~ dropped: on real data copying the forecast wins it. Replaced by a daily ★ banker (one call counts double), which spreads scores without rewarding copying
- [x] Rebalance scoring: odds for rain, 10 for lines, banker doubles, exact hits on a line are void (5 each). The "beat the forecast" and "bold call" bonuses are gone
- [x] Simulator (`npm run simulate`): leagues of copiers, random guessers, contrarians and players with a small local edge, over 2,000 simulated months
- [x] Rerun the simulator on real UK forecasts vs outcomes (`npm run simulate -- --real`): 14 UK cities, 6 Aug to 4 Oct 2026
- [x] Calibrate each city's lines from its last 30 settled games, leaning on a UK-wide prior until it has history
- [x] Simulator now runs the game's own question and scoring code

**Result on real UK data (what shipped):** with calibrated lines, the temperature line came out YES on 52% of days and the wind line on 50% (exactly on the forecast they were 62% and 35%). Copying the forecast scores 19.9 points a day against 19.3 for random guessing, so it's no longer a strategy. Players with even a small genuine edge still pull ahead over a month.

**Still to watch in the friends test:** rain is a long shot (YES pays up to 50) on the ~40% of days with a dry forecast, so that call is fairly dead on dry days. If it feels flat, try a different second rain question on those days.

**Simulator findings (synthetic UK autumn weather):**

| | Current design | Lines on the forecast (3 calls) | Lines on the forecast + nearest guess |
|---|---|---|---|
| Copier vs random guesser, points a day | 23.7 vs 19.0 | 14.9 vs 14.5 | 26.8 vs 21.1 |
| Days where the top score is shared | 71% | 63% | 13% |

- Confirmed: today, copying the forecast is worth about 25% more than guessing, and everyone who copies gets the same score, so most days end in a tie at the top.
- Putting the line on the forecast removes copying's advantage on the three calls: copying is no better than guessing.
- The nearest guess is what breaks the ties. It brings back a small edge for copying (the forecast is a sensible guess) but you only win the day by getting closer than everyone else.
- In every design, anyone who genuinely knows better than the forecast wins the month. With lines on the forecast, everyone else is on an equal footing day to day.

**Real UK data (14 cities, 60 days each):**

| | Current design | Lines on the forecast (3 calls) | Lines on the forecast + nearest guess |
|---|---|---|---|
| Copier vs random guesser, points a day | 23.9 vs 18.8 | 15.1 vs 14.9 | 31.1 vs 21.5 |
| Days where the top score is shared | 71% | 61% | 16% |

- The next-day rain forecast was right on 82% of days. Highs were off by 0.62°C on average and within 1°C on 84% of days. (This compares the model's day-before run with its own latest values, which is also how the game settles, so it slightly flatters the forecast compared with weather stations.)
- The synthetic results hold: the current design rewards copying, and putting the line on the forecast removes that on the three calls.
- **New problem:** real forecasts are so good at the daily high that copying wins the nearest guess easily (31.1 vs 30.4 for the "local knowledge" players). The nearest guess needs reworking before we build it.
- **Forecast bias:** in 11 of 14 cities the high beat the forecast more often than not (London 65% of days, Brighton 70%, Edinburgh 67%, Manchester the exception at 45%). Gusts came in about 1 mph under the forecast almost everywhere. With a line exactly on the forecast, "always say yes to warmer" would win about 65% of the time in London. We should shift each city's lines by its recent bias, so the calls stay genuine coin flips.

## Phase 2: Ready for the friends test

- [ ] Hosting, with `PUBLIC_URL` set and a domain
- [ ] Database backups
- [ ] Basic, privacy-friendly analytics: do people come back the next day? Do they share?
- [ ] Privacy notice (UK GDPR: we store a name, password hash and picks, nothing else)
- [ ] Decide the Open-Meteo plan (free is non-commercial only)

## Phase 3: Bring people back

- [ ] Morning notification: "You called it ☔ 3/3" (web push)
- [ ] Animated results reveal with points counting up, then the share sheet
- [ ] "Locked in" panel that stays at the bottom of the screen with Challenge and Share
- [ ] Password reset (or sign in with a link by email)

## Phase 4: Friends test (2 weeks)

- [ ] 20 to 30 players, ideally 3 or 4 friend groups in different UK cities
- [ ] Success means: most players come back the next day without a reminder, and results get shared without being asked
- [ ] If not, change the game, not the marketing

## Phase 5: Growth 💭

- [ ] Share images generated for each player's own result
- [ ] Bigger design moves: moving rain and snow on the sky, new app icon, two-column desktop
- [ ] Specials for big weather moments: named storms, first frost, heatwaves, "white Christmas?"
- [ ] Launch into a big UK weather moment (storm season, the first snow)
- [ ] Local subreddits, city Facebook groups, weather hobbyists, "beat the local weather presenter"

## Why the game needs to change

The next-day forecast is right most of the time. Say it's right 85% of the time on a question:

| Strategy | Expected points per question |
|---|---|
| Copy the forecast | 10 × 0.85 = **8.5** |
| Go against it | 20 × 0.15 = **3.0** (plus a 5 point bonus now and then) |

Copying wins easily, so sensible players copy, everyone ends up on similar scores, and the game has no tension. The fix is to make the forecast the *line*, not the *answer*. Then the forecast is a coin flip, and what separates players is local knowledge ("it always rains more than forecast here"), reading how sure the forecast is, and gut feel.
