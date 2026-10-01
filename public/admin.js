const LIVE_INTERVAL_MS = 5000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const $ = (id) => document.getElementById(id);

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function duration(seconds) {
  if (seconds == null) return '–';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

// ---------- tabs ----------

const tabs = [$('tab-live'), $('tab-analytics')];

function selectTab(tab) {
  for (const t of tabs) {
    const selected = t === tab;
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !selected;
  }
  const analytics = tab.id === 'tab-analytics';
  $('range-wrap').hidden = !analytics;
  $('live-updated').hidden = analytics;
  if (analytics) loadStats();
}

tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const next = tabs[(i + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    selectTab(next);
  });
});

// ---------- live ----------

async function loadLive() {
  let data;
  try {
    const res = await fetch('/api/admin/live');
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch {
    $('live-updated').textContent = 'Couldn’t reach the server. Retrying…';
    return;
  }

  $('live-people').textContent = data.people;
  $('live-sockets').textContent = data.sockets !== data.people ? plural(data.sockets, 'open tab') : 'students';
  $('live-waiting').textContent = data.waiting;
  $('live-wait').textContent = data.waiting ? `longest wait ${duration(data.longestWaitS)}` : 'nobody waiting';
  $('live-calls').textContent = data.calls.total;
  $('live-calls-sub').textContent = data.calls.total
    ? `${data.calls.direct} direct · ${data.calls.relay} relay · ${data.calls.connecting} connecting`
    : 'no calls right now';
  $('live-uptime').textContent = duration(data.health.uptimeS);
  $('live-health').textContent = [
    `${data.health.rssMb} MB`,
    data.health.commit,
    data.health.database ? 'database on' : 'no database',
  ].filter(Boolean).join(' · ');

  const body = $('live-users');
  body.replaceChildren(
    ...data.users.map((u) => {
      const row = el('tr');
      row.append(
        el('td', {}, u.email),
        (() => {
          const td = el('td');
          td.append(el('span', { class: 'state', 'data-state': u.state }, u.state));
          return td;
        })(),
        el('td', {}, u.tabs > 1 ? `${u.device} · ${u.tabs} tabs` : u.device),
        el('td', { class: 'num' }, duration(Math.round((data.at - u.since) / 1000)))
      );
      return row;
    })
  );
  $('live-empty').hidden = data.users.length > 0;
  $('live-updated').textContent = `Updated ${new Date(data.at).toLocaleTimeString()} · refreshes every 5s`;
}

let liveTimer = null;
function startLive() {
  clearInterval(liveTimer);
  loadLive();
  liveTimer = setInterval(loadLive, LIVE_INTERVAL_MS);
}

// No polling while the tab is in the background.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInterval(liveTimer);
  else startLive();
});

// ---------- charts ----------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function shortDate(day) {
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// A plain bar chart: one bar per day, the peak labelled, first and last
// dates underneath. Each bar has a native tooltip with the exact value.
function barChart(figure, rows, key, format = (v) => v) {
  figure.querySelector('.chart-body')?.remove();
  const values = rows.map((r) => r[key] ?? 0);
  const max = Math.max(1, ...values);
  const W = 600;
  const H = 160;
  const gap = rows.length > 45 ? 1 : 3;
  const barW = (W - gap * (rows.length - 1)) / rows.length;

  const wrap = el('div', { class: 'chart-body' });
  const peak = el('p', { class: 'chart-peak' }, `peak ${format(Math.max(...values, 0))}`);
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
  chart.setAttribute('aria-label', `${figure.querySelector('figcaption').textContent}: ${rows.length} days, peak ${format(max)}`);

  chart.append(svg('line', { x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5, class: 'chart-axis' }));
  rows.forEach((r, i) => {
    const v = r[key] ?? 0;
    const h = v ? Math.max(2, (v / max) * (H - 4)) : 0;
    const bar = svg('rect', { x: i * (barW + gap), y: H - h, width: barW, height: h, rx: Math.min(2, barW / 2), class: 'chart-bar' });
    const title = svg('title');
    title.textContent = `${shortDate(r.day)}: ${format(v)}`;
    bar.append(title);
    // Invisible full-height hit area so short bars are still easy to hover.
    const hit = svg('rect', { x: i * (barW + gap), y: 0, width: barW + gap, height: H, class: 'chart-hit' });
    hit.append(title.cloneNode(true));
    chart.append(bar, hit);
  });

  const axis = el('div', { class: 'chart-dates' });
  axis.append(el('span', {}, shortDate(rows[0].day)), el('span', {}, shortDate(rows[rows.length - 1].day)));
  wrap.append(peak, chart, axis);
  figure.append(wrap);
}

function heatmap(figure, cells) {
  figure.querySelector('.chart-body')?.remove();
  const counts = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c.calls]));
  const max = Math.max(1, ...cells.map((c) => c.calls));

  const wrap = el('div', { class: 'chart-body heatmap' });
  wrap.append(el('span'));
  for (let h = 0; h < 24; h++) wrap.append(el('span', { class: 'heat-hour' }, h % 3 === 0 ? String(h) : ''));
  // Monday first: the campus week.
  for (const dow of [1, 2, 3, 4, 5, 6, 0]) {
    wrap.append(el('span', { class: 'heat-day' }, DAY_NAMES[dow]));
    for (let h = 0; h < 24; h++) {
      const n = counts.get(`${dow}-${h}`) || 0;
      const cell = el('span', { class: 'heat-cell', title: `${DAY_NAMES[dow]} ${String(h).padStart(2, '0')}:00 · ${plural(n, 'call')}` });
      cell.style.setProperty('--heat', n ? (0.15 + 0.85 * (n / max)).toFixed(2) : 0);
      wrap.append(cell);
    }
  }
  figure.append(wrap);
}

// Horizontal proportion bars, for small categorical breakdowns.
function breakdown(figure, items) {
  figure.querySelector('.chart-body')?.remove();
  const total = items.reduce((sum, i) => sum + i.value, 0);
  const wrap = el('div', { class: 'chart-body breakdown' });
  if (!total) {
    wrap.append(el('p', { class: 'admin-empty' }, 'No data in this range yet.'));
  }
  for (const item of total ? items : []) {
    const pct = Math.round((item.value / total) * 100);
    const row = el('div', { class: 'breakdown-row' });
    const bar = el('div', { class: 'breakdown-bar' });
    const fill = el('span', { 'data-tone': item.tone || 'accent' });
    fill.style.width = `${pct}%`;
    bar.append(fill);
    row.append(el('span', { class: 'breakdown-label' }, item.label), bar, el('span', { class: 'breakdown-value' }, `${item.value} · ${pct}%`));
    wrap.append(row);
  }
  figure.append(wrap);
}

// ---------- analytics ----------

let statsLoading = false;

async function loadStats() {
  if (statsLoading) return;
  statsLoading = true;
  try {
    const res = await fetch(`/api/admin/stats?days=${$('range').value}`);
    const data = await res.json();
    $('analytics-off').hidden = data.enabled;
    $('analytics-body').hidden = !data.enabled;
    if (!data.enabled || !data.stats) return;

    const { daily, totals, heatmap: cells, devices, connections } = data.stats;
    $('t-users').textContent = totals.users;
    $('t-wau').textContent = totals.weekly_active;
    $('t-calls').textContent = totals.calls;
    $('t-minutes').textContent = `${totals.minutes} minutes talked`;
    $('t-avg').textContent = duration(totals.avg_call_s);
    $('t-skip').textContent = totals.quick_skip_pct == null ? 'no calls yet' : `${totals.quick_skip_pct}% skipped within 10s`;

    barChart($('c-active'), daily, 'active');
    barChart($('c-calls'), daily, 'calls');
    barChart($('c-new'), daily, 'new_users');
    barChart($('c-length'), daily, 'avg_call_s', duration);
    heatmap($('c-heatmap'), cells);
    breakdown($('c-devices'), devices.map((d) => ({ label: d.device, value: d.visits })));
    breakdown($('c-conn'), [
      { label: 'direct', value: connections.direct },
      { label: 'relay', value: connections.relay, tone: 'sky' },
      { label: 'failed', value: connections.failed, tone: 'error' },
    ]);
  } catch (err) {
    console.error('Failed to load stats', err);
  } finally {
    statsLoading = false;
  }
}

$('range').addEventListener('change', loadStats);

startLive();
