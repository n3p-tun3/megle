# megle

Core Omegle mechanic: random-match two strangers into a 1:1 video call.

- `server/index.js` — plain Node.js WebSocket server. Serves the static frontend
  and does matchmaking + WebRTC signaling relay. No database, no framework.
- `public/` — vanilla HTML/CSS/JS client. `getUserMedia` for camera/mic,
  `RTCPeerConnection` for the actual video call.

Video/audio never touches the server — it's peer-to-peer WebRTC. The server
only ever passes small JSON messages (who's paired with whom, SDP offers/answers,
ICE candidates).

## Run locally

```
npm install
npm start
```

Open `http://localhost:3000` in two different browser tabs/profiles (or two
devices) and hit Start on both to test matching.

## Deploying on free tiers (no credit card)

**App (this repo — one Node process, static site + WebSocket):**
- [Render](https://render.com) free Web Service — connect the repo, build
  command `npm install`, start command `npm start`. No card required for the
  free plan. Caveat: spins down after ~15 min idle, ~30–60s cold start on the
  next visit.
- [Glitch](https://glitch.com) — no card, good for quick demos, also sleeps
  when idle.

Either works fine as an MVP; just expect a cold-start delay after inactivity.

**TURN (needed when two peers can't connect directly, e.g. corporate networks/
strict NATs):**

The client currently points at the [Open Relay Project](https://www.metered.ca/tools/openrelay/)
public TURN server (`public/client.js`) — free, no signup, but shared with
everyone else using their demo credentials, so treat it as good for solo/small
testing only. When you're ready for more than a couple of concurrent testers,
sign up for your own free TURN allotment (e.g. Metered.ca's free plan, no card
required) and swap the credentials in `ICE_SERVERS`.

**STUN** is free and unlimited either way (Google's public STUN, already wired up).

## Known limitation

Free TURN/relay bandwidth is the one thing that runs out first if this gets
real traffic — video is bandwidth-heavy when it has to relay instead of going
peer-to-peer. Fine for testing with friends; revisit before a public launch.
