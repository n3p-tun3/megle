# megle

Omegle-style random video chat, made for one campus. Two signed-in
students get matched into a 1:1 video call with text chat, and can skip to the
next person at any time.

- `server/index.js` — plain Node.js server. Serves the frontend, handles auth,
  and relays matchmaking + WebRTC signaling over WebSocket.
- `server/auth.js` — session cookies, test login, admin list.
- `server/google.js` — verifies "Sign in with Google" ID tokens.
- `server/db.js` — optional Postgres for the admin board's analytics.
- `public/` — vanilla HTML/CSS/JS client.

Video and audio never touch the server: those flow peer-to-peer over WebRTC.
The server only passes small JSON messages (who is paired with whom, SDP
offers/answers, ICE candidates, chat lines, and the online count).

## Run locally

```
npm install
npm start
```

Then open `http://localhost:3000`. Google sign-in needs `GOOGLE_CLIENT_ID`
(see below); without it, use the test login.

To match against yourself, sign in as two different identities in two browser
profiles (see the test login below).

## Configuration

All settings are environment variables. See `.env.example` for the full list.

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth client ID for "Sign in with Google". Without it, only the test login works. |
| `SESSION_SECRET` | Signs session cookies. Set a long random value in production; changing it signs everyone out. |
| `TEST_LOGIN_CODE` | Optional. Enables a demo login that skips Google. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD` | TURN relay credentials, served only to signed-in users. |
| `ADMIN_EMAILS` | Comma-separated Google emails that can open the admin board at `/admin`. |
| `DATABASE_URL` | Optional Postgres connection string. Enables the board's analytics. |

### Google sign-in

Anyone with a Google account can sign in. There is no campus check: the
school email turned out to be something students don't use, and location is
too easy to fake to be worth the friction. The app is made for ASTU by how
it's shared, and kept safe by accounts that can be moderated.

1. In [Google Cloud Console](https://console.cloud.google.com), create a
   project, then **APIs & Services → OAuth consent screen**: External, app
   name, support email. Only the basic `email` and `profile` scopes are used,
   so no verification review is needed.
2. **Credentials → Create credentials → OAuth client ID → Web application.**
3. Under **Authorized JavaScript origins** add the deployed origin (for
   example `https://megle.onrender.com`) and, for local work, both
   `http://localhost` and `http://localhost:3000`. No redirect URIs are needed.
4. Set `GOOGLE_CLIENT_ID` to the client ID. There is no client secret: the
   server checks Google's signature on the ID token instead.

Google blocks sign-in inside in-app browsers (Telegram, Instagram,
Facebook). The login page detects the common ones and tells people to open
it in Chrome or Safari.

### Test login (skip Google)

Set `TEST_LOGIN_CODE` to any secret string, then visit:

```
/auth/test-login?code=YOUR_CODE        signs in as test-a@meetastu.test
/auth/test-login?code=YOUR_CODE&as=b   signs in as test-b@meetastu.test
```

Different `as` values produce different identities, so you can open two browser
profiles and match against yourself. The endpoint returns 404 when
`TEST_LOGIN_CODE` is unset, so it is off by default.

### Admin board

`/admin` has two tabs:

- **Live**: who's online and in what state, people searching and the
  longest wait, calls in progress (counts only, never who's with whom), and
  server health.
- **Analytics**: daily active students, calls per day, new students, call
  length, quick skips, busiest hours, devices, and how calls connect
  (direct or through the TURN relay). Needs `DATABASE_URL`.

Analytics store sign-in presence and call metadata (start, wait, length,
how it ended, how it connected). They never store chat text, video, or
who was paired with whom. Any Postgres works; the schema is created on
start. For local development, `npm run db:local` runs a throwaway Postgres
on port 5433.

## Deploying (free tiers, no credit card)

**App:** [Render](https://render.com) free Web Service. `render.yaml` is already
set up, so pick "Blueprint" and select the repo. Add the environment variables
above in the dashboard. Free instances sleep after 15 minutes idle and take
30-60s to wake.

Free tier gives 750 instance-hours per month, which is just under a full month
(744h), so a single always-on service fits if it is the only free service in the
workspace. `/healthz` exists for an uptime pinger to keep it warm.

**TURN:** [ExpressTURN](https://www.expressturn.com) free tier is 1000GB/month,
no card. Credentials are read from env vars server-side and served only to
signed-in users via `/turn-config.json`. If unset, the client falls back to the
public Open Relay demo servers, which are shared and unreliable.

**STUN** is Google's public server, free and unlimited.

## Known limitations

- **Single instance only.** The matchmaking queue and presence count live in
  memory. Running two instances would split the
  pool. Sessions themselves are signed cookies, so they survive restarts.
- **TURN credentials are long-lived.** Signed-in users can read them from
  `/turn-config.json`. Short-lived HMAC credentials would fix this but need
  either a paid ExpressTURN plan or self-hosted coturn.
- **No moderation or rate limiting on chat.** Accounts are Google accounts,
  which cost something to replace, but there is no reporting or banning yet.
