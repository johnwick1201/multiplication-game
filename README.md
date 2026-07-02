# Multiplication Game

An online multiplication game for 2–6 players. Everyone joins a room, agrees on
settings, plays the **same** questions (a shared seed makes the sequence
identical), and then all see combined stats.

- Static front-end (HTML/CSS/JS) — hostable free on **GitHub Pages**.
- **Firebase Realtime Database** coordinates the room. No server to run.
- Modular: change look in `style.css`, tweak game logic in `app.js`.

---

## 1. Create a free Firebase project (~5 min)

1. Go to <https://console.firebase.google.com> → **Add project** (any name).
2. In the project, open **Build → Realtime Database → Create Database**.
   - Pick a location, then choose **Start in test mode** for now.
     (We lock it down in step 3.)
3. Click the gear icon → **Project settings** → scroll to **Your apps** →
   click the **`</>` (Web)** icon → register an app (no hosting needed) →
   copy the `firebaseConfig` values it shows you.
4. Paste those values into **`firebase-config.js`**, replacing the
   `PASTE_...` placeholders.

> These keys are **not secret** — they're designed to live in front-end code.
> Real security comes from the database *rules* below, not from hiding them.

## 2. Run it locally

ES modules won't load from `file://`, so serve the folder over HTTP:

```bash
cd multiplication-game
python3 -m http.server 8000
```

Open <http://localhost:8000>. To test two players, open a second tab
(or an incognito window) and join with the room code.

## 3. Lock down the database (recommended)

In the Firebase console → **Realtime Database → Rules**, paste this and
**Publish**. It only allows access under `/rooms`, caps room size, and
requires the expected fields — so nobody can dump or spam your whole DB:

```json
{
  "rules": {
    "rooms": {
      "$code": {
        ".read": true,
        ".write": true,
        ".validate": "newData.hasChildren(['host','status']) || !newData.exists()",
        "players": {
          ".validate": "newData.numChildren() <= 6"
        }
      }
    },
    ".read": false,
    ".write": false
  }
}
```

This is a friendly-game level of security (no login, anyone with a room code
can play). If you later want only signed-in friends, add Firebase Anonymous or
Google Auth and tighten `.read`/`.write` to `auth != null`.

## 4. Host on GitHub Pages

1. Put this folder in a GitHub repo.
2. Repo **Settings → Pages** → Source = your branch, root folder → **Save**.
3. Visit the URL it gives you (e.g. `https://you.github.io/repo/`).

> Note: a GitHub Pages site is publicly viewable by anyone with the link, but
> since play requires a room code and the DB rules above, that's fine for a
> game. (True "private only" hosting is a separate problem from the DB.)

---

## How it works

- **Same questions:** on start, the host writes a random `seed`. Both clients
  feed it to a deterministic RNG (`mulberry32`) → identical question order.
- **Synced timers:** clients read Firebase's `serverTimeOffset` to correct for
  clock differences, so both countdowns agree.
- **Two modes:** *Timed* (race the clock) or *Question limit* (first to N).
- **Winner:** most correct; ties broken by faster time.

## Tweak points

| Want to change… | Edit |
|---|---|
| Colors / fonts | `style.css` (`:root` variables) |
| Max A/B caps, default settings | `app.js` (`makeCode` defaults, lobby inputs in `index.html`) |
| Countdown length | `COUNTDOWN_MS` in `app.js` |
| Timed-mode question pool size | `TIME_POOL` in `app.js` |

## Known limitations (v1)

- Refreshing the tab mid-game drops you from the room (by design — closing the
  tab removes you so rooms clean themselves up).
- Up to 6 players per room (host sets the count in the lobby). To allow more,
  raise the `<= 6` in the database rules and the `max="6"` / `clamp(..., 2, 6)`
  in `app.js` and `index.html`.
