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

## Phase 1: Fix the core game 🔨

**Problem:** copying the forecast is the best strategy. The forecast is right most days, so copying it scores well. The +10 "beat the forecast" bonus doesn't pay enough to outweigh the extra misses. If everyone copies, everyone scores the same, and there's nothing to talk about. See "Why the game needs to change" below.

- [ ] Set lines *at* the forecast, so the forecast itself is a coin flip on every question ("Will Manchester top 17.5°C?" when the forecast says 17.5°C)
- [ ] Add one "nearest guess" question per day (e.g. tomorrow's high), scored by how close you get
- [ ] Rebalance scoring so the leaderboard actually spreads out
- [x] Simulator (`npm run simulate`): leagues of copiers, random guessers, contrarians and players with a small local edge, over 2,000 simulated months
- [ ] Rerun the simulator on real UK forecasts vs outcomes (`npm run simulate -- --real`), blocked today by the sandbox's shared Open-Meteo quota

**Simulator findings (synthetic UK autumn weather):**

| | Current design | Lines on the forecast (3 calls) | Lines on the forecast + nearest guess |
|---|---|---|---|
| Copier vs random guesser, points a day | 23.7 vs 19.0 | 14.9 vs 14.5 | 26.8 vs 21.1 |
| Days where the top score is shared | 71% | 63% | 13% |

- Confirmed: today, copying the forecast is worth about 25% more than guessing, and everyone who copies gets the same score, so most days end in a tie at the top.
- Putting the line on the forecast removes copying's advantage on the three calls: copying is no better than guessing.
- The nearest guess is what breaks the ties. It brings back a small edge for copying (the forecast is a sensible guess) but you only win the day by getting closer than everyone else.
- In every design, anyone who genuinely knows better than the forecast wins the month. With lines on the forecast, everyone else is on an equal footing day to day.

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
