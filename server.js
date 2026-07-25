'use strict';

require('dotenv').config();

const express = require('express');
const cron    = require('node-cron');
const {
  fetchPfSenseData, loadUptimeKumaConfig, connectUptimeKuma,
  fetchMonitors, reconcile, categorize, loadIgnoreList,
} = require('./lib/audit-core');

const PORT          = process.env.PORT          || 3000;
const CRON_SCHEDULE = process.env.AUDIT_CRON    || '0 8 * * *';
const VERSION       = require('./package.json').version;

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  status:  'pending',   // pending | running | ok | error
  lastRun: null,
  report:  null,
  error:   null,
};

// ─── HAProxy backend classifier ───────────────────────────────────────────────

const IP_RE = /^\d+\.\d+\.\d+\.\d+$/;

function classifyBackends(backends, dnsHosts) {
  const hostAliasCount = {};
  for (const entry of dnsHosts) {
    hostAliasCount[`${entry.host}.${entry.domain}`] = (entry.aliases || []).length;
  }

  const safe = [], named = [], shared = [];
  for (const backend of backends) {
    for (const server of (backend.servers || [])) {
      const addr = server.address;
      const rec = { backend: backend.name, server: server.name, address: addr, port: server.port };
      if (IP_RE.test(addr)) {
        safe.push(rec);
      } else if (hostAliasCount[addr] !== undefined && hostAliasCount[addr] >= 3) {
        shared.push({ ...rec, aliasCount: hostAliasCount[addr] });
      } else {
        named.push(rec);
      }
    }
  }
  return { safe, named, shared };
}

// ─── Audit runner ─────────────────────────────────────────────────────────────

async function runAudit() {
  if (state.status === 'running') return;
  state.status = 'running';
  state.error  = null;

  let socket;
  try {
    const [pfData, ukConfig] = await Promise.all([
      fetchPfSenseData(),
      Promise.resolve(loadUptimeKumaConfig()),
    ]);
    socket = await connectUptimeKuma(ukConfig);
    const monitors = await fetchMonitors(socket);
    socket.disconnect(); socket = null;

    const { services, unmapped } = reconcile(pfData.backends, pfData.dnsHosts, monitors);
    const ignore  = loadIgnoreList();

    const all      = [...services.values()].sort((a, b) => a.name.localeCompare(b.name));
    const covered  = all.filter(s => s.monitor);
    const gaps     = all.filter(s => !s.monitor);
    const active   = gaps.filter(s => !ignore.services.has(s.name.toLowerCase()));
    const suppressed = gaps.length - active.length;

    const { svcs, third, other } = categorize(unmapped);
    const activeOther = other.filter(m => !ignore.monitors.has(m.name.toLowerCase()));
    const nonGroup    = monitors.filter(m => m.type !== 'group').length;

    const hap = classifyBackends(pfData.backends, pfData.dnsHosts);

    const serverAddr = s => s.hasBackend && s.backend?.servers?.[0]
      ? `${s.backend.servers[0].address}:${s.backend.servers[0].port}` : null;

    state.report = {
      generatedAt: new Date().toISOString(),
      totals: { services: all.length, covered: covered.length, gaps: active.length, suppressed, nonGroup },
      gaps: active.map(s => ({
        name:       s.name,
        hasBackend: s.hasBackend,
        hasDns:     s.hasDns,
        server:     serverAddr(s),
      })),
      services: all.map(s => ({
        name:       s.name,
        hasBackend: s.hasBackend,
        hasDns:     s.hasDns,
        monitored:  !!s.monitor,
        suppressed: !s.monitor && ignore.services.has(s.name.toLowerCase()),
        server:     serverAddr(s),
      })),
      unmapped: {
        svcs:  svcs.map(m => ({ name: m.name, type: m.type, url: m.url || m.hostname || '', kind: 'ext-mirror' })),
        third: third.map(m => ({ name: m.name, type: m.type, url: m.url || m.hostname || '', kind: 'external' })),
        other: activeOther.map(m => ({ name: m.name, type: m.type, url: m.url || m.hostname || '', kind: 'unmatched' })),
      },
      haproxy: {
        safe:   hap.safe,
        named:  hap.named,
        shared: hap.shared,
      },
    };
    state.status  = 'ok';
  } catch (err) {
    if (socket) { try { socket.disconnect(); } catch {} }
    state.error  = err.message;
    state.status = 'error';
  }

  state.lastRun = new Date().toISOString();
  console.log(`[audit] ${state.status} — ${new Date().toISOString()}`);
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

cron.schedule(CRON_SCHEDULE, () => {
  console.log(`[cron] triggering audit (${CRON_SCHEDULE})`);
  runAudit();
});

// ─── HTTP ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/api/report', (_req, res) => res.json({ status: state.status, lastRun: state.lastRun, error: state.error, report: state.report }));

app.post('/api/run', (_req, res) => {
  runAudit();
  res.json({ ok: true });
});

app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(html(CRON_SCHEDULE, VERSION));
});
app.get('/healthz', (_req, res) => res.json({ ok: true, version: VERSION, status: state.status, lastRun: state.lastRun }));

// ─── HTML dashboard ───────────────────────────────────────────────────────────

function html(schedule, version) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pfSense ↔ Uptime Kuma</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root{
  --bg:         #f2e8cf;
  --surface:    #faf6ea;
  --border:     #d4c89a;
  --border2:    #c2b888;
  --tx:         #1e3322;
  --tx-muted:   #4a6b42;
  --tx-dim:     #6a994e;
  --accent:     #6a994e;
  --good:       #386641;
  --bad:        #bc4749;
  --warn:       #9a6b1a;
  --good-bg:    #fef3c7;
  --good-bd:    #f59e0b;
  --good-tx:    #78400a;
  --bad-bg:     #f5dede;
  --bad-bd:     #d4a0a0;
  --neu-bg:     #fff7ed;
  --neu-bd:     #fdba74;
  --neu-tx:     #9a3d0a;
  --hover:      rgba(56,102,65,.07);
  --stripe:     rgba(56,102,65,.04);
  --tx-hi:      #1e3322;
  --tx-muted-hi:#4a6b42;
  --hdr-bg:      #386641;
  --hdr-bd:      #2b4f32;
  --hdr-tx:      #f2e8cf;
  --hdr-accent:  #a7c957;
  --hdr-muted:   #b8d4a0;
  --sec-hdr-bg:  #eee8d0;
  --th-bg:       #f5f0e2;
  --btn-bg:      #a7c957;
  --btn-tx:      #1e3322;
  --card-bg:     #fffef7;
  --lgd-hdr-bg:  #3d4f6b;
  --lgd-hdr-tx:  #f0ecd8;
  --lgd-body-bg: #fdf5e6;
}

@media(prefers-color-scheme:dark){:root{
  --bg:         #111c10;
  --surface:    #182416;
  --border:     #2a4028;
  --border2:    #344d30;
  --tx:         #b8ccaa;
  --tx-muted:   #8cc47e;
  --tx-dim:     #d0e8c0;
  --accent:     #6a994e;
  --good:       #a7c957;
  --bad:        #e07878;
  --warn:       #d4a830;
  --good-bg:    #3d2600;
  --good-bd:    #b45309;
  --good-tx:    #fcd34d;
  --bad-bg:     #2e1414;
  --bad-bd:     #5a2424;
  --neu-bg:     #2e1a00;
  --neu-bd:     #92400e;
  --neu-tx:     #fb923c;
  --hover:      rgba(167,201,87,.08);
  --stripe:     rgba(167,201,87,.05);
  --tx-hi:      #ffffff;
  --tx-muted-hi:#ffffff;
  --hdr-bg:      #0d1a0c;
  --hdr-bd:      #1a3018;
  --hdr-tx:      #e8f0d8;
  --hdr-accent:  #a7c957;
  --hdr-muted:   #6a994e;
  --sec-hdr-bg:  #162414;
  --th-bg:       #131f12;
  --btn-bg:      #6a994e;
  --btn-tx:      #e8f0d8;
  --card-bg:     #1a1f2e;
  --lgd-hdr-bg:  #253351;
  --lgd-hdr-tx:  #c8d8f0;
  --lgd-body-bg: #141926;
}}
:root[data-theme="dark"]{
  --bg:         #111c10;
  --surface:    #182416;
  --border:     #2a4028;
  --border2:    #344d30;
  --tx:         #b8ccaa;
  --tx-muted:   #8cc47e;
  --tx-dim:     #d0e8c0;
  --accent:     #6a994e;
  --good:       #a7c957;
  --bad:        #e07878;
  --warn:       #d4a830;
  --good-bg:    #3d2600;
  --good-bd:    #b45309;
  --good-tx:    #fcd34d;
  --bad-bg:     #2e1414;
  --bad-bd:     #5a2424;
  --neu-bg:     #2e1a00;
  --neu-bd:     #92400e;
  --neu-tx:     #fb923c;
  --hover:      rgba(167,201,87,.08);
  --stripe:     rgba(167,201,87,.05);
  --tx-hi:      #ffffff;
  --tx-muted-hi:#ffffff;
  --hdr-bg:      #0d1a0c;
  --hdr-bd:      #1a3018;
  --hdr-tx:      #e8f0d8;
  --hdr-accent:  #a7c957;
  --hdr-muted:   #6a994e;
  --sec-hdr-bg:  #162414;
  --th-bg:       #131f12;
  --btn-bg:      #6a994e;
  --btn-tx:      #e8f0d8;
  --card-bg:     #1a1f2e;
  --lgd-hdr-bg:  #253351;
  --lgd-hdr-tx:  #c8d8f0;
  --lgd-body-bg: #141926;
}
:root[data-theme="light"]{
  --bg:         #f2e8cf;
  --surface:    #faf6ea;
  --border:     #d4c89a;
  --border2:    #c2b888;
  --tx:         #1e3322;
  --tx-muted:   #4a6b42;
  --tx-dim:     #6a994e;
  --accent:     #6a994e;
  --good:       #386641;
  --bad:        #bc4749;
  --warn:       #9a6b1a;
  --good-bg:    #fef3c7;
  --good-bd:    #f59e0b;
  --good-tx:    #78400a;
  --bad-bg:     #f5dede;
  --bad-bd:     #d4a0a0;
  --neu-bg:     #fff7ed;
  --neu-bd:     #fdba74;
  --neu-tx:     #9a3d0a;
  --hover:      rgba(56,102,65,.07);
  --stripe:     rgba(56,102,65,.04);
  --tx-hi:      #1e3322;
  --tx-muted-hi:#4a6b42;
  --hdr-bg:      #386641;
  --hdr-bd:      #2b4f32;
  --hdr-tx:      #f2e8cf;
  --hdr-accent:  #a7c957;
  --hdr-muted:   #b8d4a0;
  --sec-hdr-bg:  #eee8d0;
  --th-bg:       #f5f0e2;
  --btn-bg:      #a7c957;
  --btn-tx:      #1e3322;
  --card-bg:     #fffef7;
  --lgd-hdr-bg:  #3d4f6b;
  --lgd-hdr-tx:  #f0ecd8;
  --lgd-body-bg: #fdf5e6;
}

body{font-family:ui-monospace,'SF Mono','Fira Code','Cascadia Code','Courier New',monospace;background:var(--bg);color:var(--tx);min-height:100vh;font-size:112px;margin:0;padding:0;box-sizing:border-box}
a{color:inherit}

/* header */
.hdr{background:var(--hdr-bg);border-bottom:2px solid var(--hdr-bd);padding:0 32px;height:84px;display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:16px;line-height:1.2}
.hdr-title{font-size:1.25em;font-weight:bold;color:var(--hdr-tx);letter-spacing:.04em}
.hdr-title span{color:var(--hdr-accent)}
.hdr-meta{font-size:1.35em;color:var(--hdr-muted);margin-top:2px}
.hdr-right{display:flex;align-items:center;gap:12px}

/* theme toggle */
.theme-btn{background:none;border:1px solid var(--hdr-muted);color:var(--hdr-muted);border-radius:4px;padding:3px 8px;cursor:pointer;font-family:inherit;font-size:.85em;line-height:1.4}
.theme-btn:hover{border-color:var(--hdr-tx);color:var(--hdr-tx)}

/* status dot */
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle}
.s-ok      .dot{background:var(--hdr-accent)}
.s-error   .dot{background:#f08080}
.s-running .dot{background:#e6c84a;animation:blink 1s infinite}
.s-pending .dot{background:var(--hdr-muted)}
.status-label{font-size:1em;color:var(--hdr-muted)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}

/* run button */
.btn{background:var(--btn-bg);color:var(--btn-tx);border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:1em;font-weight:bold;line-height:1.4;letter-spacing:.02em}
.btn:hover:not(:disabled){filter:brightness(1.08)}
.btn:disabled{opacity:.5;cursor:not-allowed}

/* main layout */
.main{width:100%;padding:20px 32px;box-sizing:border-box}

/* stat cards */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px}
.stat{background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:18px 20px;border-left:4px solid var(--accent)}
.stat-val{font-size:1.4rem;font-weight:bold;line-height:1;font-variant-numeric:tabular-nums}
.stat-lbl{font-size:.78rem;text-transform:uppercase;letter-spacing:.1em;color:var(--tx-muted);margin-top:4px}
.stat-sub{font-size:.75rem;color:var(--tx-dim);margin-top:5px}
.g{color:var(--good)}.r{color:var(--bad)}.y{color:var(--warn)}.gy{color:var(--tx-muted)}

/* sections */
.sec{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:8px;overflow:hidden}
.sec-hdr{padding:8px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--sec-hdr-bg)}
.sec-hdr-click{cursor:pointer;user-select:none}
.sec-hdr-click:hover{filter:brightness(.96)}
.sec-chevron{font-size:.7rem;color:var(--tx-dim);transition:transform .15s}
.sec-title{font-size:.92rem;font-weight:bold;color:var(--tx)}
.badge{font-size:.77rem;padding:2px 9px;border-radius:10px;white-space:nowrap;font-variant-numeric:tabular-nums}
.badge-r{background:var(--bad-bg);color:var(--bad);border:1px solid var(--bad-bd)}
.badge-g{background:var(--good-bg);color:var(--good-tx);border:1px solid var(--good-bd)}
.badge-gy{background:var(--neu-bg);color:var(--neu-tx);border:1px solid var(--neu-bd)}

/* table */
table{width:100%;border-collapse:collapse;font-size:.86rem}
th{padding:7px 16px;text-align:left;color:var(--tx-dim);border-bottom:1px solid var(--border);font-weight:normal;font-size:.80rem;text-transform:uppercase;letter-spacing:.1em;background:var(--th-bg)}
td{padding:9px 16px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:none}
tr:nth-child(even) td{background:var(--stripe)}
tr:hover td{background:var(--hover)}
.b{font-weight:bold}
td.b{color:var(--tx-hi)}
.saddr{color:var(--tx-muted);font-size:.82rem}
td.saddr{color:var(--tx-muted-hi)}

/* inline badge */
.ibadge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:.77rem;font-weight:bold;letter-spacing:.02em}
.ibadge-g{background:var(--good-bg);color:var(--good-tx);border:1px solid var(--good-bd)}
.ibadge-gy{background:var(--neu-bg);color:var(--neu-tx);border:1px solid var(--neu-bd)}

.empty{padding:10px;text-align:center;color:var(--tx-muted);font-size:.86rem}

/* legend */
.sec-legend .sec-hdr{background:var(--lgd-hdr-bg);border-bottom-color:var(--lgd-hdr-bg)}
.sec-legend .sec-title{color:var(--lgd-hdr-tx)}
.legend-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0;padding:4px 0;background:var(--lgd-body-bg)}
.legend-group{padding:14px 18px;border-right:1px solid var(--border)}
.legend-group:last-child{border-right:none}
.legend-label{font-size:.81rem;text-transform:uppercase;letter-spacing:.1em;color:var(--tx-dim);margin-bottom:10px}
.legend-item{font-size:.93rem;color:var(--tx-muted);padding:3px 0;display:flex;align-items:center;gap:7px}

/* footer */
.foot{text-align:center;padding:14px;font-size:1.00rem;color:var(--tx-dim)}

/* spinner */
.spinner-row td{color:var(--warn);font-size:.82rem;padding:12px 16px}
</style>
</head>
<body>

<div class="hdr">
  <div>
    <div class="hdr-title">pfSense <span>&#8596;</span> Uptime Kuma Audit</div>
    <div class="hdr-meta" id="meta">Loading&hellip;</div>
  </div>
  <div class="hdr-right">
    <span id="status-wrap" class="s-pending"><span class="dot"></span><span class="status-label" id="status-lbl">Pending</span></span>
    <label style="font-size:.85em;color:var(--hdr-muted);display:flex;align-items:center;gap:5px">
      Rows
      <select id="page-size-sel" onchange="setPageSize(this.value)" style="background:var(--hdr-bd);color:var(--hdr-tx);border:1px solid var(--hdr-muted);border-radius:3px;padding:2px 4px;font-family:inherit;font-size:1em;cursor:pointer">
        <option value="10">10</option>
        <option value="15" selected>15</option>
        <option value="20">20</option>
        <option value="25">25</option>
        <option value="50">50</option>
      </select>
    </label>
    <button class="theme-btn" id="theme-btn" onclick="toggleTheme()">☽</button>
    <button class="btn" id="run-btn" onclick="triggerRun()">Run Now</button>
  </div>
</div>

<div class="main">
  <div class="stats">
    <div class="stat"><div class="stat-val gy" id="sv-total">—</div><div class="stat-lbl">pfSense Services</div><div class="stat-sub">backends + DNS entries</div></div>
    <div class="stat"><div class="stat-val g"  id="sv-cov">—</div><div class="stat-lbl">Monitored</div><div class="stat-sub" id="sv-cov-pct"></div></div>
    <div class="stat"><div class="stat-val gy" id="sv-gaps">—</div><div class="stat-lbl">Active Gaps</div><div class="stat-sub" id="sv-gaps-sub">missing UK monitor</div></div>
  </div>

  <div class="sec">
    <div class="sec-hdr sec-hdr-click" onclick="toggleInventory()">
      <span class="sec-title" id="toggle-btn">Services Missing a UK Monitor</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="badge badge-gy" id="gap-badge">—</span>
        <span class="sec-chevron" id="gap-chevron">&#9654;</span>
      </div>
    </div>
    <div id="gap-body"><div class="empty">No data</div></div>
  </div>

  <div class="sec">
    <div class="sec-hdr sec-hdr-click" onclick="toggleUm()">
      <span class="sec-title" id="um-toggle-btn">UK Monitors Without a pfSense Match</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="badge badge-gy" id="um-badge">—</span>
        <span class="sec-chevron" id="um-chevron">&#9654;</span>
      </div>
    </div>
    <div id="um-body"><div class="empty">No data</div></div>
  </div>

  <div class="sec">
    <div class="sec-hdr sec-hdr-click" onclick="toggleHap()">
      <span class="sec-title" id="hap-toggle-btn">HAProxy Backend Address Health</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="badge badge-gy" id="hap-badge">—</span>
        <span class="sec-chevron" id="hap-chevron">&#9654;</span>
      </div>
    </div>
    <div id="hap-body"><div class="empty">No data</div></div>
  </div>
</div>

<div class="sec sec-legend" style="margin-bottom:18px">
  <div class="sec-hdr">
    <span class="sec-title">Legend</span>
  </div>
  <div class="legend-grid">
    <div class="legend-group">
      <div class="legend-label">Service status</div>
      <div class="legend-item"><span class="g">&#10003;</span> Has a UK monitor</div>
      <div class="legend-item"><span class="r">&#10007;</span> Missing a UK monitor</div>
      <div class="legend-item"><span class="gy">&#8211;</span> Suppressed (in ignore list)</div>
    </div>
    <div class="legend-group">
      <div class="legend-label">Column badges</div>
      <div class="legend-item"><span class="ibadge ibadge-g">HAP</span> HAProxy backend exists</div>
      <div class="legend-item"><span class="ibadge ibadge-g">DNS</span> lamolabs.org DNS alias exists</div>
      <div class="legend-item"><span class="ibadge ibadge-gy">—</span> Not present</div>
    </div>
    <div class="legend-group">
      <div class="legend-label">UK monitor kinds</div>
      <div class="legend-item"><span class="ibadge ibadge-g" style="font-size:.65rem">unmatched</span> On lamolabs.org but no pfSense backend found</div>
      <div class="legend-item"><span class="ibadge ibadge-gy" style="font-size:.65rem">ext-mirror</span> .svcs.lamolabs.com mirror — expected duplicate</div>
      <div class="legend-item"><span class="ibadge ibadge-gy" style="font-size:.65rem">external</span> Third-party URL, not a pfSense service</div>
    </div>
    <div class="legend-group">
      <div class="legend-label">HAProxy backend health</div>
      <div class="legend-item"><span class="r">&#9888;</span> <strong>raw IPs</strong> — direct IP address, catch-all vulnerable</div>
      <div class="legend-item"><span class="r">&#9888;</span> <strong>shared</strong> — hostname with many aliases, catch-all risk</div>
      <div class="legend-item"><span class="g">&#10003;</span> <strong>named</strong> — service-specific hostname (healthy)</div>
    </div>
  </div>
</div>

<div class="foot">
  v${version} &nbsp;&bull;&nbsp; Schedule: <strong>${schedule}</strong> &nbsp;&bull;&nbsp;
  <span id="refresh-txt">auto-refresh in 60s</span>
</div>

<script>
var countdown = 60, refreshTimer = null, lastReport = null;

function lsGet(k, def){ var v=localStorage.getItem(k); return v===null?def:v==='true'; }
function lsGetN(k, def){ var v=localStorage.getItem(k); return v===null?def:parseInt(v,10); }
function lsSet(k, v){ localStorage.setItem(k, v); }

var PAGE = lsGetN('pageSize', 15);

var showAll    = lsGet('showAll',    false);
var showAllUm  = lsGet('showAllUm',  false);
var showAllHap = lsGet('showAllHap', false);
var collSup    = lsGet('collSup',    true);
var collOk     = lsGet('collOk',     true);
var pageGap    = lsGetN('pageGap',   0);
var pageSup    = lsGetN('pageSup',   0);
var pageOk     = lsGetN('pageOk',    0);
var pageUm     = lsGetN('pageUm',    0);
var pageHap    = lsGetN('pageHap',   0);

(function(){
  var saved = localStorage.getItem('theme');
  if(saved) document.documentElement.setAttribute('data-theme', saved);
  else if(window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.setAttribute('data-theme','dark');
  updateThemeBtn();
  var sel = document.getElementById('page-size-sel');
  if(sel) sel.value = String(PAGE);
})();
function setPageSize(v){
  PAGE = parseInt(v, 10);
  lsSet('pageSize', PAGE);
  pageGap=pageSup=pageOk=pageUm=pageHap=0;
  if(lastReport){ renderServiceTable(); renderUmTable(); renderHapTable(); }
}
function updateThemeBtn(){
  var t = document.documentElement.getAttribute('data-theme') || 'light';
  var btn = document.getElementById('theme-btn');
  if(btn) btn.textContent = t === 'dark' ? '☀' : '☽';
}
function toggleTheme(){
  var cur = document.documentElement.getAttribute('data-theme') || 'light';
  var next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeBtn();
}

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function timeAgo(iso){
  if(!iso) return 'never';
  var s = Math.floor((Date.now()-new Date(iso))/1000);
  if(s<5)   return 'just now';
  if(s<60)  return s+'s ago';
  if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}

function render(d){
  if(!d) return;

  // header
  var sw = document.getElementById('status-wrap');
  var statuses = {ok:'s-ok',error:'s-error',running:'s-running',pending:'s-pending'};
  sw.className = statuses[d.status]||'s-pending';
  var labels = {ok:'OK',error:'Error',running:'Running…',pending:'Pending'};
  document.getElementById('status-lbl').textContent = labels[d.status]||d.status;
  document.getElementById('meta').textContent = d.lastRun
    ? 'Last run: '+timeAgo(d.lastRun)+' — '+new Date(d.lastRun).toLocaleString()
    : 'Not yet run';
  document.getElementById('run-btn').disabled = d.status==='running';

  if(d.status==='running'){
    document.getElementById('gap-body').innerHTML = '<table><tr class="spinner-row"><td colspan="5">&#9656; Audit running…</td></tr></table>';
    return;
  }
  if(!d.report){
    if(d.error) document.getElementById('gap-body').innerHTML = '<div class="empty r">'+esc(d.error)+'</div>';
    return;
  }

  var rpt = d.report;
  lastReport = rpt;
  var t = rpt.totals;

  // stat cards
  document.getElementById('sv-total').textContent = t.services;
  document.getElementById('sv-cov').textContent   = t.covered;
  var pct = t.services>0 ? Math.round(t.covered/t.services*100) : 0;
  document.getElementById('sv-cov-pct').textContent = pct+'% coverage';

  var gEl = document.getElementById('sv-gaps');
  gEl.textContent  = t.gaps;
  gEl.className    = 'stat-val '+(t.gaps===0?'g':'r');
  document.getElementById('sv-gaps-sub').textContent =
    t.suppressed>0 ? t.suppressed+' suppressed · not shown' : 'missing UK monitor';

  // gap badge + toggle button
  var gb = document.getElementById('gap-badge');
  gb.textContent = t.gaps+' gaps'+(t.suppressed>0?' (+'+t.suppressed+' suppressed)':'');
  gb.className = 'badge '+(t.gaps===0?'badge-g':'badge-r');

  renderServiceTable();

  // unmapped monitors
  var um = rpt.unmapped;
  var umb = document.getElementById('um-badge');
  umb.textContent = um.other.length+' unmatched / '+um.svcs.length+' ext-mirror / '+um.third.length+' external';
  umb.className = 'badge '+(um.other.length===0?'badge-g':'badge-r');
  renderUmTable();

  // HAProxy backend health
  var hap = rpt.haproxy;
  if(hap){
    var hapb = document.getElementById('hap-badge');
    hapb.textContent = hap.safe.length+' raw IPs / '+hap.named.length+' named / '+hap.shared.length+' shared';
    hapb.className = 'badge '+((hap.safe.length===0&&hap.shared.length===0)?'badge-g':'badge-r');
    renderHapTable();
  }
}

function renderServiceTable(){
  if(!lastReport) return;
  var gb2 = document.getElementById('gap-body');
  var chev = document.getElementById('gap-chevron');
  if(chev) chev.innerHTML = showAll ? '&#9660;' : '&#9654;';

  var rows = showAll ? lastReport.services : lastReport.gaps;

  if(!showAll && lastReport.gaps.length===0){
    var supCount = lastReport.totals.suppressed;
    var okMsg = supCount>0
      ? '&#10003; No active gaps <span class="gy" style="font-size:.8rem;font-weight:normal">('+supCount+' suppressed — click header to expand)</span>'
      : '&#10003; All services have a UK monitor';
    gb2.innerHTML = '<div class="empty"><span class="g">'+okMsg+'</span></div>';
    return;
  }

  var asc = function(a,b){return a.name.localeCompare(b.name);};
  var gaps = rows.filter(function(s){return !s.monitored && !s.suppressed;}).sort(asc);
  var supp = rows.filter(function(s){return !!s.suppressed;}).sort(asc);
  var ok   = rows.filter(function(s){return !!s.monitored && !s.suppressed;}).sort(asc);

  pageGap = Math.min(pageGap, Math.max(0, Math.ceil(gaps.length/PAGE)-1));
  pageSup = Math.min(pageSup, Math.max(0, Math.ceil(supp.length/PAGE)-1));
  pageOk  = Math.min(pageOk,  Math.max(0, Math.ceil(ok.length/PAGE)-1));

  var GHS = 'padding:6px 16px 4px;font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;color:var(--tx-dim);background:var(--th-bg);border-bottom:1px solid var(--border);cursor:pointer;user-select:none';
  var PBS = 'background:var(--accent);color:#fff;border:none;border-radius:3px;padding:2px 10px;cursor:pointer;font-family:inherit;font-size:.75rem;font-weight:bold';
  function groupHdr(label,total,collapsed,toggle){
    var chevron = collapsed ? '&#9654;' : '&#9660;';
    return '<tr onclick="'+toggle+'" style="'+GHS+'"><td colspan="5">'+chevron+' '+label+' ('+total+')</td></tr>';
  }
  function pagRow(page,total,prev,next,cols){
    cols = cols||5;
    if(total<=PAGE) return '';
    var pages=Math.ceil(total/PAGE);
    return '<tr><td colspan="'+cols+'" style="padding:6px 16px;background:var(--th-bg);border-top:1px solid var(--border);text-align:right;font-size:.75rem;color:var(--tx);font-weight:bold">'+
      '<button style="'+PBS+'" onclick="'+prev+'()" '+(page===0?'disabled':'')+'>&#8592;</button>'+
      ' <span style="margin:0 6px">'+( page+1)+' / '+pages+'</span>'+
      '<button style="'+PBS+'" onclick="'+next+'()" '+(page>=pages-1?'disabled':'')+'>&#8594;</button>'+
      '</td></tr>';
  }
  function row(s){
    var isOk  = !!s.monitored && !s.suppressed;
    var isSup = !!s.suppressed;
    var icon  = isOk ? '<span class="g">&#10003;</span>' : (isSup ? '<span class="gy">&#8211;</span>' : '<span class="r">&#10007;</span>');
    return '<tr'+(isOk?' style="opacity:.80"':'')+'>'+
      '<td>'+icon+'</td>'+
      '<td class="'+(isOk?'':'b')+'">'+esc(s.name)+'</td>'+
      '<td>'+(s.hasBackend?'<span class="ibadge ibadge-g">HAP</span>':'<span class="ibadge ibadge-gy">—</span>')+'</td>'+
      '<td>'+(s.hasDns?'<span class="ibadge ibadge-g">DNS</span>':'<span class="ibadge ibadge-gy">—</span>')+'</td>'+
      '<td class="saddr">'+esc(s.server||'')+'</td>'+
      '</tr>';
  }

  var h = '<table><thead><tr><th></th><th>Service</th><th>HAP</th><th>DNS</th><th>Server</th></tr></thead><tbody>';
  if(gaps.length){
    h += groupHdr('Missing monitor', gaps.length, false, '');
    gaps.slice(pageGap*PAGE,(pageGap+1)*PAGE).forEach(function(s){h+=row(s);});
    h += pagRow(pageGap,gaps.length,'prevGap','nextGap');
  }
  if(supp.length){
    h += groupHdr('Suppressed', supp.length, collSup, 'toggleSuppGroup()');
    if(!collSup){
      supp.slice(pageSup*PAGE,(pageSup+1)*PAGE).forEach(function(s){h+=row(s);});
      h += pagRow(pageSup,supp.length,'prevSup','nextSup');
    }
  }
  if(ok.length){
    h += groupHdr('OK', ok.length, collOk, 'toggleOkGroup()');
    if(!collOk){
      ok.slice(pageOk*PAGE,(pageOk+1)*PAGE).forEach(function(s){h+=row(s);});
      h += pagRow(pageOk,ok.length,'prevOk','nextOk');
    }
  }
  h += '</tbody></table>';
  gb2.innerHTML = h;
}

function toggleInventory(){ showAll=!showAll; lsSet('showAll',showAll); pageGap=pageSup=pageOk=0; renderServiceTable(); }
function toggleSuppGroup(){ collSup=!collSup; lsSet('collSup',collSup); pageSup=0; renderServiceTable(); }
function toggleOkGroup(){   collOk=!collOk;   lsSet('collOk',collOk);   pageOk=0;  renderServiceTable(); }
function prevGap(){ pageGap=Math.max(0,pageGap-1); lsSet('pageGap',pageGap); renderServiceTable(); }
function nextGap(){ pageGap++;                      lsSet('pageGap',pageGap); renderServiceTable(); }
function prevSup(){ pageSup=Math.max(0,pageSup-1); lsSet('pageSup',pageSup); renderServiceTable(); }
function nextSup(){ pageSup++;                      lsSet('pageSup',pageSup); renderServiceTable(); }
function prevOk(){  pageOk=Math.max(0,pageOk-1);   lsSet('pageOk',pageOk);   renderServiceTable(); }
function nextOk(){  pageOk++;                       lsSet('pageOk',pageOk);   renderServiceTable(); }

function renderUmTable(){
  if(!lastReport) return;
  var um = lastReport.unmapped;
  var chev = document.getElementById('um-chevron');
  if(chev) chev.innerHTML = showAllUm ? '&#9660;' : '&#9654;';
  var rows = showAllUm ? um.other.concat(um.svcs).concat(um.third) : um.other;
  var el = document.getElementById('um-body');
  if(rows.length===0){
    var note = (um.svcs.length>0||um.third.length>0)
      ? '<span class="gy" style="font-size:.8rem;display:block;margin-top:4px">'+um.svcs.length+' ext-mirror + '+um.third.length+' external skipped (expected)</span>'
      : '';
    el.innerHTML = '<div class="empty"><span class="g">&#10003; No unmatched monitors</span>'+note+'</div>';
    return;
  }
  var kindColor = {unmatched:'r','ext-mirror':'gy',external:'gy'};
  pageUm = Math.min(pageUm, Math.max(0, Math.ceil(rows.length/PAGE)-1));
  var PBS = 'background:var(--accent);color:#fff;border:none;border-radius:3px;padding:2px 10px;cursor:pointer;font-family:inherit;font-size:.75rem;font-weight:bold';
  var h = '<table><thead><tr><th></th><th>Monitor</th><th>Kind</th><th>Type</th><th>URL</th></tr></thead><tbody>';
  rows.slice(pageUm*PAGE,(pageUm+1)*PAGE).forEach(function(m){
    var isIssue = m.kind==='unmatched';
    var icon = isIssue ? '<span class="r">&#10007;</span>' : '<span class="gy">&#8211;</span>';
    h += '<tr'+(isIssue?'':' style="opacity:.80"')+'>';
    h += '<td>'+icon+'</td>';
    h += '<td class="'+(isIssue?'b':'')+'">'+esc(m.name)+'</td>';
    h += '<td><span class="ibadge '+(isIssue?'ibadge-g':'ibadge-gy')+'">'+esc(m.kind)+'</span></td>';
    h += '<td class="saddr">'+esc(m.type)+'</td>';
    h += '<td class="saddr">'+esc(m.url)+'</td>';
    h += '</tr>';
  });
  if(rows.length>PAGE){
    var pages=Math.ceil(rows.length/PAGE);
    h+='<tr><td colspan="5" style="padding:6px 16px;background:var(--th-bg);border-top:1px solid var(--border);text-align:right;font-size:.75rem;color:var(--tx);font-weight:bold">'+
      '<button style="'+PBS+'" onclick="prevUm()" '+(pageUm===0?'disabled':'')+'>&#8592;</button>'+
      ' <span style="margin:0 6px">'+(pageUm+1)+' / '+pages+'</span>'+
      '<button style="'+PBS+'" onclick="nextUm()" '+(pageUm>=pages-1?'disabled':'')+'>&#8594;</button></td></tr>';
  }
  h += '</tbody></table>';
  el.innerHTML = h;
}

function toggleUm(){
  showAllUm = !showAllUm; lsSet('showAllUm', showAllUm); pageUm=0;
  renderUmTable();
}
function prevUm(){ pageUm=Math.max(0,pageUm-1); lsSet('pageUm',pageUm); renderUmTable(); }
function nextUm(){ pageUm++;                     lsSet('pageUm',pageUm); renderUmTable(); }

function renderHapTable(){
  if(!lastReport) return;
  var hap = lastReport.haproxy;
  var chev = document.getElementById('hap-chevron');
  if(chev) chev.innerHTML = showAllHap ? '&#9660;' : '&#9654;';
  var el = document.getElementById('hap-body');
  var rows;
  if(showAllHap){
    rows = hap.shared.map(function(s){ return {flag:'r', label:'&#9888;', aliasNote: s.aliasCount+' aliases', s:s}; })
      .concat(hap.safe.map(function(s){ return {flag:'y', label:'&#9888;', aliasNote:'raw IP', s:s}; }))
      .concat(hap.named.map(function(s){ return {flag:'', label:'<span class="g">&#10003;</span>', aliasNote:'', s:s}; }));
  } else {
    rows = hap.shared.map(function(s){ return {flag:'r', label:'&#9888;', aliasNote:s.aliasCount+' aliases', s:s}; })
      .concat(hap.safe.map(function(s){ return {flag:'y', label:'&#9888;', aliasNote:'raw IP', s:s}; }));
  }
  if(rows.length===0){
    el.innerHTML = '<div class="empty"><span class="g">&#10003; No raw IPs or shared hostnames</span></div>';
    return;
  }
  pageHap = Math.min(pageHap, Math.max(0, Math.ceil(rows.length/PAGE)-1));
  var PBS = 'background:var(--accent);color:#fff;border:none;border-radius:3px;padding:2px 10px;cursor:pointer;font-family:inherit;font-size:.75rem;font-weight:bold';
  var h = '<table><thead><tr><th></th><th>Backend</th><th>Server</th><th>Address</th><th>Note</th></tr></thead><tbody>';
  rows.slice(pageHap*PAGE,(pageHap+1)*PAGE).forEach(function(r){
    h += '<tr'+(r.flag?'':' style="opacity:.80"')+'>';
    h += '<td class="'+r.flag+'">'+r.label+'</td>';
    h += '<td class="b">'+esc(r.s.backend)+'</td>';
    h += '<td class="saddr">'+esc(r.s.server)+'</td>';
    h += '<td>'+esc(r.s.address+':'+r.s.port)+'</td>';
    h += '<td class="saddr">'+esc(r.aliasNote)+'</td>';
    h += '</tr>';
  });
  if(rows.length>PAGE){
    var pages=Math.ceil(rows.length/PAGE);
    h+='<tr><td colspan="5" style="padding:6px 16px;background:var(--th-bg);border-top:1px solid var(--border);text-align:right;font-size:.75rem;color:var(--tx);font-weight:bold">'+
      '<button style="'+PBS+'" onclick="prevHap()" '+(pageHap===0?'disabled':'')+'>&#8592;</button>'+
      ' <span style="margin:0 6px">'+(pageHap+1)+' / '+pages+'</span>'+
      '<button style="'+PBS+'" onclick="nextHap()" '+(pageHap>=pages-1?'disabled':'')+'>&#8594;</button></td></tr>';
  }
  h += '</tbody></table>';
  el.innerHTML = h;
}

function toggleHap(){
  showAllHap = !showAllHap; lsSet('showAllHap', showAllHap); pageHap=0;
  renderHapTable();
}
function prevHap(){ pageHap=Math.max(0,pageHap-1); lsSet('pageHap',pageHap); renderHapTable(); }
function nextHap(){ pageHap++;                      lsSet('pageHap',pageHap); renderHapTable(); }

async function fetchAndRender(){
  try{
    var r = await fetch('/api/report');
    var d = await r.json();
    render(d);
    return d;
  } catch(e){ return null; }
}

async function triggerRun(){
  document.getElementById('run-btn').disabled = true;
  await fetch('/api/run',{method:'POST'});
  clearTimeout(refreshTimer);
  // poll quickly until status leaves 'running'
  var poll = async function(){
    var d = await fetchAndRender();
    if(d && d.status==='running') refreshTimer = setTimeout(poll, 2000);
    else { countdown=60; tick(); }
  };
  setTimeout(poll, 800);
}

function tick(){
  clearTimeout(refreshTimer);
  document.getElementById('refresh-txt').textContent = 'auto-refresh in '+countdown+'s';
  if(countdown<=0){ countdown=60; fetchAndRender().then(function(){ tick(); }); return; }
  countdown--;
  refreshTimer = setTimeout(tick, 1000);
}

fetchAndRender().then(function(){ tick(); });
</script>
</body>
</html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`pfSense ↔ Uptime Kuma audit server`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  cron: ${CRON_SCHEDULE}`);
  console.log('');
  console.log('[audit] running initial audit...');
  await runAudit();
});
