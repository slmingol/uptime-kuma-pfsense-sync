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
        svcs:      svcs.length,
        third:     third.length,
        other:     activeOther.map(m => ({ name: m.name, type: m.type, url: m.url || m.hostname || '' })),
      },
      haproxy: {
        safe:   hap.safe.length,
        named:  hap.named.length,
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

app.get('/', (_req, res) => res.send(html(CRON_SCHEDULE)));
app.get('/healthz', (_req, res) => res.json({ ok: true, status: state.status, lastRun: state.lastRun }));

// ─── HTML dashboard ───────────────────────────────────────────────────────────

function html(schedule) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pfSense ↔ Uptime Kuma</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-monospace,'SF Mono','Fira Code','Cascadia Code','Courier New',monospace;background:#0f172a;color:#f1f5f9;min-height:100vh;font-size:14px}
a{color:inherit}

/* header */
.hdr{background:#1e293b;border-bottom:1px solid #334155;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.hdr-title{font-size:1rem;font-weight:bold;color:#f1f5f9;letter-spacing:.04em}
.hdr-title span{color:#06b6d4}
.hdr-meta{font-size:.8rem;color:#cbd5e1;margin-top:3px}
.hdr-right{display:flex;align-items:center;gap:12px}

/* status dot */
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle}
.s-ok      .dot{background:#22c55e}
.s-error   .dot{background:#ef4444}
.s-running .dot{background:#eab308;animation:blink 1s infinite}
.s-pending .dot{background:#64748b}
.status-label{font-size:.85rem}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}

/* run button */
.btn{background:#3b82f6;color:#fff;border:none;padding:6px 16px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:.82rem;line-height:1.5}
.btn:hover:not(:disabled){background:#2563eb}
.btn:disabled{background:#334155;color:#64748b;cursor:not-allowed}

/* main layout */
.main{max-width:1080px;margin:0 auto;padding:20px 24px}

/* stat cards */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px}
.stat{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:18px 20px}
.stat-val{font-size:2.4rem;font-weight:bold;line-height:1}
.stat-lbl{font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;color:#cbd5e1;margin-top:4px}
.stat-sub{font-size:.75rem;color:#cbd5e1;margin-top:5px}
.g{color:#22c55e}.r{color:#ef4444}.y{color:#eab308}.gy{color:#94a3b8}

/* sections */
.sec{background:#1e293b;border:1px solid #334155;border-radius:8px;margin-bottom:18px;overflow:hidden}
.sec-hdr{padding:12px 18px;border-bottom:1px solid #334155;display:flex;align-items:center;justify-content:space-between;gap:8px}
.sec-title{font-size:.9rem;font-weight:bold;color:#f1f5f9}
.badge{font-size:.75rem;padding:2px 9px;border-radius:10px;white-space:nowrap}
.badge-r{background:#7f1d1d;color:#fca5a5}
.badge-g{background:#14532d;color:#86efac}
.badge-gy{background:#1e293b;color:#cbd5e1;border:1px solid #475569}

/* table */
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{padding:7px 16px;text-align:left;color:#cbd5e1;border-bottom:1px solid #334155;font-weight:normal;font-size:.72rem;text-transform:uppercase;letter-spacing:.1em}
td{padding:9px 16px;border-bottom:1px solid #1e2d3d}
tr:last-child td{border-bottom:none}
tr:hover td{background:#ffffff0d}
.b{font-weight:bold}
.saddr{color:#cbd5e1;font-size:.8rem}

/* inline badge */
.ibadge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:.68rem;font-weight:bold}
.ibadge-g{background:#14532d;color:#86efac}
.ibadge-gy{color:#94a3b8;border:1px solid #475569}

/* monitor chips */
.chips{padding:12px 18px;display:flex;flex-wrap:wrap;gap:8px}
.chip{background:#0f172a;border:1px solid #334155;border-radius:4px;padding:5px 10px;font-size:.8rem}
.chip-sub{color:#cbd5e1;font-size:.72rem}

.empty{padding:32px;text-align:center;color:#94a3b8;font-size:.85rem}

/* footer */
.foot{text-align:center;padding:14px;font-size:.75rem;color:#94a3b8}

/* spinner overlay shown when running */
.spinner-row td{color:#eab308;font-size:.82rem;padding:12px 16px}
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
    <div class="stat"><div class="stat-val gy" id="sv-gaps">—</div><div class="stat-lbl">Gaps</div><div class="stat-sub" id="sv-gaps-sub">missing UK monitor</div></div>
  </div>

  <div class="sec">
    <div class="sec-hdr">
      <span class="sec-title">Services Missing a UK Monitor</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="badge badge-gy" id="gap-badge">—</span>
        <button class="btn" id="toggle-btn" onclick="toggleInventory()" style="font-size:.68rem;padding:3px 10px">Show all</button>
      </div>
    </div>
    <div id="gap-body"><div class="empty">No data</div></div>
  </div>

  <div class="sec">
    <div class="sec-hdr">
      <span class="sec-title">UK Monitors Without a pfSense Match</span>
      <span class="badge badge-gy" id="um-badge">—</span>
    </div>
    <div id="um-body"><div class="empty">No data</div></div>
  </div>

  <div class="sec">
    <div class="sec-hdr">
      <span class="sec-title">HAProxy Backend Address Health</span>
      <span class="badge badge-gy" id="hap-badge">—</span>
    </div>
    <div id="hap-body"><div class="empty">No data</div></div>
  </div>
</div>

<div class="foot">
  Schedule: <strong>${schedule}</strong> &nbsp;&bull;&nbsp;
  <span id="refresh-txt">auto-refresh in 60s</span>
</div>

<script>
var countdown = 60, refreshTimer = null, showAll = false, lastReport = null;

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
    t.suppressed>0 ? t.suppressed+' suppressed by ignore list' : 'missing UK monitor';

  // gap badge + toggle button
  var gb = document.getElementById('gap-badge');
  gb.textContent = t.gaps+' gaps'+(t.suppressed>0?' (+'+t.suppressed+' suppressed)':'');
  gb.className = 'badge '+(t.gaps===0?'badge-g':'badge-r');

  renderServiceTable();

  // unmapped monitors
  var um = rpt.unmapped;
  var umb = document.getElementById('um-badge');
  umb.textContent = um.other.length+' unrecognized / '+um.svcs+' ext-path / '+um.third+' third-party';
  umb.className = 'badge '+(um.other.length===0?'badge-g':'badge-r');

  var umb2 = document.getElementById('um-body');
  if(um.other.length===0){
    umb2.innerHTML = '<div class="empty"><span class="g">&#10003; All UK monitors are linked to pfSense</span></div>';
  } else {
    var h2 = '<div class="chips">';
    um.other.forEach(function(m){
      h2 += '<div class="chip"><strong>'+esc(m.name)+'</strong><br><span class="chip-sub">'+esc(m.type+': '+m.url)+'</span></div>';
    });
    h2 += '</div>';
    umb2.innerHTML = h2;
  }

  // HAProxy backend health
  var hap = rpt.haproxy;
  if(hap){
    var hapb = document.getElementById('hap-badge');
    hapb.textContent = hap.safe+' static IPs / '+hap.named+' hostnames / '+hap.shared.length+' shared';
    hapb.className = 'badge '+(hap.shared.length===0?'badge-g':'badge-r');

    var hapb2 = document.getElementById('hap-body');
    if(hap.shared.length===0){
      hapb2.innerHTML = '<div class="empty"><span class="g">&#10003; No shared/catch-all hostnames detected</span></div>';
    } else {
      var h3 = '<table><thead><tr><th></th><th>Backend</th><th>Server</th><th>Address</th><th>Aliases</th></tr></thead><tbody>';
      hap.shared.forEach(function(s){
        h3 += '<tr>';
        h3 += '<td class="r">&#9888;</td>';
        h3 += '<td class="b">'+esc(s.backend)+'</td>';
        h3 += '<td class="saddr">'+esc(s.server)+'</td>';
        h3 += '<td>'+esc(s.address+':'+s.port)+'</td>';
        h3 += '<td class="saddr">'+s.aliasCount+' aliases</td>';
        h3 += '</tr>';
      });
      h3 += '</tbody></table>';
      hapb2.innerHTML = h3;
    }
  }
}

function renderServiceTable(){
  if(!lastReport) return;
  var gb2 = document.getElementById('gap-body');
  var btn = document.getElementById('toggle-btn');
  btn.textContent = showAll ? 'Show gaps only' : 'Show all';

  var rows = showAll ? lastReport.services : lastReport.gaps;

  if(!showAll && lastReport.gaps.length===0){
    gb2.innerHTML = '<div class="empty"><span class="g">&#10003; All services have a UK monitor</span></div>';
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
