// Postgres for the admin board's history. Optional: without DATABASE_URL the
// app runs exactly as before and the board shows live data only.
//
// What is stored is deliberately thin: who was online when, and that calls
// happened (when, how long, how they ended). Never chat text, never video,
// and never who was paired with whom.
const { Pool } = require('pg');

// Campus time, so "busiest hours" and day boundaries match students' days.
const TZ = 'Africa/Addis_Ababa';

let pool = null;
let ready = false;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    email       text PRIMARY KEY,
    first_seen  timestamptz NOT NULL DEFAULT now(),
    last_seen   timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS events (
    id     bigserial PRIMARY KEY,
    at     timestamptz NOT NULL DEFAULT now(),
    type   text NOT NULL,
    email  text,
    data   jsonb NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS events_type_at ON events (type, at);
`;

function enabled() {
  return ready;
}

async function init() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[db] DATABASE_URL is unset. The admin board will show live data only.');
    return;
  }

  // Hosted providers require TLS; a local database usually has none.
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  pool = new Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 5,
  });
  // An idle client dropping (a provider restart, say) must not crash the app.
  pool.on('error', (err) => console.error('[db] Idle client error:', err.message));

  try {
    await pool.query(SCHEMA);
    ready = true;
    console.log('[db] Connected; analytics enabled.');
  } catch (err) {
    console.error('[db] Could not initialise, analytics disabled:', err.message);
  }
}

// Fire and forget: analytics must never slow down or break a call.
function logEvent(type, email = null, data = {}) {
  if (!ready) return;
  pool
    .query('INSERT INTO events (type, email, data) VALUES ($1, $2, $3)', [type, email, data])
    .catch((err) => console.error(`[db] Failed to log ${type}:`, err.message));
}

function touchUser(email) {
  if (!ready) return;
  pool
    .query(
      `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET last_seen = now()`,
      [email]
    )
    .catch((err) => console.error('[db] Failed to record user:', err.message));
}

// Everything the analytics tab draws, for the last `days` days.
async function stats(days) {
  if (!ready) return null;
  const since = `now() - make_interval(days => ${Number(days)})`;
  const q = (sql, params = []) => pool.query(sql, params).then((r) => r.rows);

  const [daily, totals, heatmap, devices, connections] = await Promise.all([
    // One row per campus day, including days with nothing, so charts have
    // no gaps.
    q(`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', now() AT TIME ZONE '${TZ}') - make_interval(days => $1 - 1),
          date_trunc('day', now() AT TIME ZONE '${TZ}'),
          interval '1 day'
        )::date AS day
      ),
      ev AS (
        SELECT (at AT TIME ZONE '${TZ}')::date AS day, type, email, data
        FROM events WHERE at >= ${since}
      )
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS day,
        (SELECT count(DISTINCT email) FROM ev WHERE ev.day = d.day AND type = 'connect')::int AS active,
        (SELECT count(*) FROM users u WHERE (u.first_seen AT TIME ZONE '${TZ}')::date = d.day)::int AS new_users,
        (SELECT count(*) FROM ev WHERE ev.day = d.day AND type = 'match')::int AS calls,
        (SELECT round(avg((data->>'duration_ms')::numeric) / 1000)
           FROM ev WHERE ev.day = d.day AND type = 'call_end')::int AS avg_call_s
      FROM days d
      ORDER BY d.day
    `, [Number(days)]),

    q(`
      SELECT
        (SELECT count(*) FROM users)::int AS users,
        (SELECT count(DISTINCT email) FROM events
          WHERE type = 'connect' AND at >= now() - interval '7 days')::int AS weekly_active,
        (SELECT count(*) FROM events WHERE type = 'match' AND at >= ${since})::int AS calls,
        (SELECT coalesce(round(sum((data->>'duration_ms')::numeric) / 60000), 0)
          FROM events WHERE type = 'call_end' AND at >= ${since})::int AS minutes,
        (SELECT round(avg((data->>'duration_ms')::numeric) / 1000)
          FROM events WHERE type = 'call_end' AND at >= ${since})::int AS avg_call_s,
        (SELECT round(100.0 * count(*) FILTER (
             WHERE data->>'ended' = 'next' AND (data->>'duration_ms')::int < 10000
           ) / nullif(count(*), 0))
          FROM events WHERE type = 'call_end' AND at >= ${since})::int AS quick_skip_pct,
        (SELECT round(avg((data->>'wait_ms')::numeric) / 1000)
          FROM events WHERE type = 'match' AND at >= ${since})::int AS avg_wait_s
    `),

    // Calls by weekday (0 = Sunday) and hour, campus time.
    q(`
      SELECT extract(dow FROM at AT TIME ZONE '${TZ}')::int AS dow,
             extract(hour FROM at AT TIME ZONE '${TZ}')::int AS hour,
             count(*)::int AS calls
      FROM events WHERE type = 'match' AND at >= ${since}
      GROUP BY 1, 2
    `),

    // Visits per device kind. Visits rather than people, so someone on both
    // phone and laptop doesn't make the shares add up past 100%.
    q(`
      SELECT coalesce(data->>'device', 'unknown') AS device, count(*)::int AS visits
      FROM events WHERE type = 'connect' AND at >= ${since}
      GROUP BY 1 ORDER BY 2 DESC
    `),

    // How calls connected: directly, through the TURN relay, or not at all.
    q(`
      SELECT
        count(*) FILTER (WHERE data->>'result' = 'direct')::int AS direct,
        count(*) FILTER (WHERE data->>'result' = 'relay')::int AS relay,
        count(*) FILTER (WHERE data->>'result' = 'failed')::int AS failed
      FROM events WHERE type = 'conn' AND at >= ${since}
    `),
  ]);

  return { days, daily, totals: totals[0], heatmap, devices, connections: connections[0] };
}

module.exports = { init, enabled, logEvent, touchUser, stats };
