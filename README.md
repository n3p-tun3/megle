# megle

Omegle-style random video chat, restricted to one campus. Two signed-in
students get matched into a 1:1 video call with text chat, and can skip to the
next person at any time.

- `server/index.js` — plain Node.js server. Serves the frontend, handles auth,
  and relays matchmaking + WebRTC signaling over WebSocket. No database.
- `server/auth.js` — magic-link sign-in, session cookies, email delivery.
- `public/` — vanilla HTML/CSS/JS client.

Video and audio never touch the server: those flow peer-to-peer over WebRTC.
The server only passes small JSON messages (who is paired with whom, SDP
offers/answers, ICE candidates, chat lines, and the online count).

## Run locally

```
npm install
npm start
```

Then open `http://localhost:3000`. With no mail provider configured, sign-in
links are printed to the server log instead of emailed. Copy the link from the
terminal and open it.

To match against yourself, sign in as two different identities in two browser
profiles (see the test login below).

## Configuration

All settings are environment variables. See `.env.example` for the full list.

| Variable | Purpose |
| --- | --- |
| `ALLOWED_EMAIL_DOMAINS` | Comma-separated sign-in allowlist. Defaults to `astust.edu.et`. Subdomains are accepted. Set `*` to allow anything (local dev only). |
| `SESSION_SECRET` | Signs session cookies. Set a long random value in production; changing it signs everyone out. |
| `RESEND_API_KEY`, `MAIL_FROM` | Real email delivery. Without both, links go to the server log. |
| `TEST_LOGIN_CODE` | Optional. Enables a demo login that skips email. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD` | TURN relay credentials, served only to signed-in users. |
| `ADMIN_EMAILS` | Comma-separated emails that can open the admin board at `/admin`. |
| `DATABASE_URL` | Optional Postgres connection string. Enables the board's analytics. |

### Email delivery

1. Create a free [Resend](https://resend.com) account (no card required).
2. Verify a domain you control, or use their sandbox sender for testing.
3. Set `RESEND_API_KEY` and `MAIL_FROM`. `MAIL_FROM` must be on a verified
   domain, otherwise the API rejects the send and sign-in fails with a 502.

### Test login (skip the email step)

Set `TEST_LOGIN_CODE` to any secret string, then visit:

```
/auth/test-login?code=YOUR_CODE        signs in as test-a@<domain>
/auth/test-login?code=YOUR_CODE&as=b   signs in as test-b@<domain>
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

- **Single instance only.** The matchmaking queue, presence count, and pending
  magic-link tokens all live in memory. Running two instances would split the
  pool. Sessions themselves are signed cookies, so they survive restarts.
- **TURN credentials are long-lived.** Signed-in users can read them from
  `/turn-config.json`. Short-lived HMAC credentials would fix this but need
  either a paid ExpressTURN plan or self-hosted coturn.
- **No moderation or rate limiting on chat.** Accounts trace back to school
  emails, which helps, but there is no reporting or blocking yet.
