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
  --bg:       #0b1222;
  --surface:  #0f1c30;
  --border:   #1a2d45;
  --border2:  #223348;
  --tx:       #e8f2fa;
  --tx-muted: #90b4cc;
  --tx-dim:   #5e82a0;
  --accent:   #5bb8d4;
  --good:     #38c98a;
  --bad:      #e0575c;
  --warn:     #e6a830;
  --good-bg:  #09271a;
  --bad-bg:   #280c0e;
  --hover:    rgba(255,255,255,.04);
}

body{font-family:ui-monospace,'SF Mono','Fira Code','Cascadia Code','Courier New',monospace;background:var(--bg);color:var(--tx);min-height:100vh;font-size:112px}
a{color:inherit}

/* header */
.hdr{background:var(--surface);border-bottom:1px solid var(--border);padding:0 24px;height:84px;display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:16px;line-height:1.2}
.hdr-title{font-size:1.25em;font-weight:bold;color:var(--tx);letter-spacing:.04em}
.hdr-title span{color:var(--accent)}
.hdr-meta{font-size:1em;color:var(--tx-muted);margin-top:2px}
.hdr-right{display:flex;align-items:center;gap:12px}

/* status dot */
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle}
.s-ok      .dot{background:var(--good)}
.s-error   .dot{background:var(--bad)}
.s-running .dot{background:var(--warn);animation:blink 1s infinite}
.s-pending .dot{background:var(--tx-dim)}
.status-label{font-size:1em;color:var(--tx-muted)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}

/* run button */
.btn{background:var(--accent);color:#071420;border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:1em;font-weight:bold;line-height:1.4;letter-spacing:.02em}
.btn:hover:not(:disabled){filter:brightness(1.12)}
.btn:disabled{background:var(--border);color:var(--tx-dim);cursor:not-allowed}

/* main layout */
.main{max-width:1080px;margin:0 auto;padding:20px 24px}

/* stat cards */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:18px 20px}
.stat-val{font-size:1.4rem;font-weight:bold;line-height:1;font-variant-numeric:tabular-nums}
.stat-lbl{font-size:.78rem;text-transform:uppercase;letter-spacing:.1em;color:var(--tx-muted);margin-top:4px}
.stat-sub{font-size:.75rem;color:var(--tx-muted);margin-top:5px}
.g{color:var(--good)}.r{color:var(--bad)}.y{color:var(--warn)}.gy{color:var(--tx-muted)}

/* sections */
.sec{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:18px;overflow:hidden}
.sec-hdr{padding:12px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px}
.sec-title{font-size:.92rem;font-weight:bold;color:var(--tx)}
.badge{font-size:.77rem;padding:2px 9px;border-radius:10px;white-space:nowrap;font-variant-numeric:tabular-nums}
.badge-r{background:var(--bad-bg);color:var(--bad);border:1px solid #3d1214}
.badge-g{background:var(--good-bg);color:var(--good);border:1px solid #0e3824}
.badge-gy{background:transparent;color:var(--tx-muted);border:1px solid var(--border2)}

/* table */
table{width:100%;border-collapse:collapse;font-size:.86rem}
th{padding:7px 16px;text-align:left;color:var(--tx-dim);border-bottom:1px solid var(--border);font-weight:normal;font-size:.80rem;text-transform:uppercase;letter-spacing:.1em}
td{padding:9px 16px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--hover)}
.b{font-weight:bold}
.saddr{color:var(--tx-muted);font-size:.82rem}

/* inline badge */
.ibadge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:.77rem;font-weight:bold;letter-spacing:.02em}
.ibadge-g{background:var(--good-bg);color:var(--good);border:1px solid #0e3824}
.ibadge-gy{color:var(--tx-dim);border:1px solid var(--border2)}

.empty{padding:32px;text-align:center;color:var(--tx-muted);font-size:.86rem}

/* legend */
.legend-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0;padding:4px 0}
.legend-group{padding:14px 18px;border-right:1px solid var(--border)}
.legend-group:last-child{border-right:none}
.legend-label{font-size:.81rem;text-transform:uppercase;letter-spacing:.1em;color:var(--tx-dim);margin-bottom:10px}
.legend-item{font-size:.93rem;color:var(--tx-muted);padding:3px 0;display:flex;align-items:center;gap:7px}

/* footer */
.foot{text-align:center;padding:14px;font-size:.75rem;color:var(--tx-dim)}

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
    <div class="sec-hdr">
      <span class="sec-title">Services Missing a UK Monitor</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="badge badge-gy" id="gap-badge">—</span>
        <button class="btn" id="toggle-btn" onclick="toggleInventory()" style="font-size:.77rem;padding:3px 10px">Show all</button>
      </div>
    </div>
    <div id="gap-body"><div class="empty">No data</div></div>
  </div>

  <div class="sec">
    <div class="sec-hdr">
      <span class="sec-title">UK Monitors Without a pfSense Match</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="badge badge-gy" id="um-badge">—</span>
        <button class="btn" id="um-toggle-btn" onclick="toggleUm()" style="font-size:.77rem;padding:3px 10px">Show all</button>
      </div>
    </div>
    <div id="um-body"><div class="empty">No data</div></div>
  </div>

  <div class="sec">
    <div class="sec-hdr">
      <span class="sec-title">HAProxy Backend Address Health</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="badge badge-gy" id="hap-badge">—</span>
        <button class="btn" id="hap-toggle-btn" onclick="toggleHap()" style="font-size:.77rem;padding:3px 10px">Show all</button>
      </div>
    </div>
    <div id="hap-body"><div class="empty">No data</div></div>
  </div>
</div>

<div class="sec" style="margin-bottom:18px">
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
var countdown = 60, refreshTimer = null, showAll = false, showAllUm = false, showAllHap = false, lastReport = null;

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
  var btn = document.getElementById('toggle-btn');
  btn.textContent = showAll ? 'Show gaps only' : 'Show all';

  var rows = showAll ? lastReport.services : lastReport.gaps;

  if(!showAll && lastReport.gaps.length===0){
    var supCount = lastReport.totals.suppressed;
    var okMsg = supCount>0
      ? '&#10003; No active gaps <span class="gy" style="font-size:.8rem;font-weight:normal">('+supCount+' suppressed — click Show all)</span>'
      : '&#10003; All services have a UK monitor';
    gb2.innerHTML = '<div class="empty"><span class="g">'+okMsg+'</span></div>';
    return;
  }

  var h = '<table><thead><tr><th></th><th>Service</th><th>HAP</th><th>DNS</th><th>Server</th></tr></thead><tbody>';
  rows.forEach(function(s){
    var ok = showAll ? s.monitored : false;
    var sup = showAll && s.suppressed;
    var icon = ok ? '<span class="g">&#10003;</span>' : (sup ? '<span class="gy">&#8211;</span>' : '<span class="r">&#10007;</span>');
    h += '<tr'+(ok?' style="opacity:.45"':'')+'>';
    h += '<td>'+icon+'</td>';
    h += '<td class="'+(ok?'':'b')+'">'+esc(s.name)+'</td>';
    h += '<td>'+(s.hasBackend?'<span class="ibadge ibadge-g">HAP</span>':'<span class="ibadge ibadge-gy">—</span>')+'</td>';
    h += '<td>'+(s.hasDns?'<span class="ibadge ibadge-g">DNS</span>':'<span class="ibadge ibadge-gy">—</span>')+'</td>';
    h += '<td class="saddr">'+esc(s.server||'')+'</td>';
    h += '</tr>';
  });
  h += '</tbody></table>';
  gb2.innerHTML = h;
}

function toggleInventory(){
  showAll = !showAll;
  renderServiceTable();
}

function renderUmTable(){
  if(!lastReport) return;
  var um = lastReport.unmapped;
  var btn = document.getElementById('um-toggle-btn');
  btn.textContent = showAllUm ? 'Show issues only' : 'Show all';
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
  var h = '<table><thead><tr><th></th><th>Monitor</th><th>Kind</th><th>Type</th><th>URL</th></tr></thead><tbody>';
  rows.forEach(function(m){
    var isIssue = m.kind==='unmatched';
    var icon = isIssue ? '<span class="r">&#10007;</span>' : '<span class="gy">&#8211;</span>';
    h += '<tr'+(isIssue?'':' style="opacity:.45"')+'>';
    h += '<td>'+icon+'</td>';
    h += '<td class="'+(isIssue?'b':'')+'">'+esc(m.name)+'</td>';
    h += '<td><span class="ibadge '+(isIssue?'ibadge-g':'ibadge-gy')+'">'+esc(m.kind)+'</span></td>';
    h += '<td class="saddr">'+esc(m.type)+'</td>';
    h += '<td class="saddr">'+esc(m.url)+'</td>';
    h += '</tr>';
  });
  h += '</tbody></table>';
  el.innerHTML = h;
}

function toggleUm(){
  showAllUm = !showAllUm;
  renderUmTable();
}

function renderHapTable(){
  if(!lastReport) return;
  var hap = lastReport.haproxy;
  var btn = document.getElementById('hap-toggle-btn');
  btn.textContent = showAllHap ? 'Show issues only' : 'Show all';
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
  var h = '<table><thead><tr><th></th><th>Backend</th><th>Server</th><th>Address</th><th>Note</th></tr></thead><tbody>';
  rows.forEach(function(r){
    h += '<tr'+(r.flag?'':' style="opacity:.45"')+'>';
    h += '<td class="'+r.flag+'">'+r.label+'</td>';
    h += '<td class="b">'+esc(r.s.backend)+'</td>';
    h += '<td class="saddr">'+esc(r.s.server)+'</td>';
    h += '<td>'+esc(r.s.address+':'+r.s.port)+'</td>';
    h += '<td class="saddr">'+esc(r.aliasNote)+'</td>';
    h += '</tr>';
  });
  h += '</tbody></table>';
  el.innerHTML = h;
}

function toggleHap(){
  showAllHap = !showAllHap;
  renderHapTable();
}

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
