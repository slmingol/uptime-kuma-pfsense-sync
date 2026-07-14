#!/usr/bin/env node
'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const https = require('https');
const io = require('socket.io-client');

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  gray:   '\x1b[90m',
  blue:   '\x1b[34m',
};

const args = process.argv.slice(2);
const verbose     = args.includes('--verbose') || args.includes('-v');
const showIgnored = args.includes('--show-ignored');

// Load ignore list (services + monitors the user has confirmed are intentional gaps)
function loadIgnore() {
  const p = path.resolve(__dirname, '.audit-ignore.json');
  if (!fs.existsSync(p)) return { services: new Set(), monitors: new Set() };
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return {
    services: new Set((raw.services || []).map(s => s.toLowerCase())),
    monitors: new Set(raw.monitors || []),
  };
}
const ignore = loadIgnore();

// ─── pfSense ──────────────────────────────────────────────────────────────────

function buildPfSenseClient() {
  const { PFSENSE_HOST, PFSENSE_API_KEY, PFSENSE_API_SECRET } = process.env;
  if (!PFSENSE_HOST || !PFSENSE_API_KEY || !PFSENSE_API_SECRET) {
    throw new Error('Missing PFSENSE_HOST, PFSENSE_API_KEY, or PFSENSE_API_SECRET in environment');
  }
  return axios.create({
    baseURL: PFSENSE_HOST,
    headers: {
      'Accept': 'application/json',
      'x-api-key': PFSENSE_API_SECRET,
    },
    httpsAgent: new https.Agent({
      rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
    }),
  });
}

async function fetchPfSenseData() {
  const client = buildPfSenseClient();
  const [backendsRes, dnsRes] = await Promise.all([
    client.get('/api/v2/services/haproxy/backends'),
    client.get('/api/v2/services/dns_resolver/host_overrides'),
  ]);

  if (backendsRes.data.code !== 200) {
    throw new Error(`pfSense HAProxy backends: ${backendsRes.data.message}`);
  }
  if (dnsRes.data.code !== 200) {
    throw new Error(`pfSense DNS overrides: ${dnsRes.data.message}`);
  }

  return {
    backends: backendsRes.data.data || [],
    dnsHosts: dnsRes.data.data || [],
  };
}

// ─── Uptime Kuma ─────────────────────────────────────────────────────────────

function loadUptimeKumaConfig() {
  const instance = process.env.UPTIME_KUMA_INSTANCE;
  if (instance) {
    const configPath = process.env.UPTIME_KUMA_CONFIG ||
      path.resolve(__dirname, '../uptime-kuma-sync-n-bak/uptime-kuma-config.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(`Uptime Kuma config not found at ${configPath}. Set UPTIME_KUMA_CONFIG env var.`);
    }
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const inst = raw.instances?.[instance];
    if (!inst) {
      const available = Object.keys(raw.instances || {}).join(', ');
      throw new Error(`Instance '${instance}' not found. Available: ${available}`);
    }
    return { url: inst.url, username: inst.username, password: inst.password };
  }

  const url = process.env.UPTIME_KUMA_URL;
  const username = process.env.UPTIME_KUMA_USER;
  const password = process.env.UPTIME_KUMA_PASS;
  if (!url || !username || !password) {
    throw new Error('Set UPTIME_KUMA_INSTANCE or UPTIME_KUMA_URL + UPTIME_KUMA_USER + UPTIME_KUMA_PASS');
  }
  return { url, username, password };
}

async function connectUptimeKuma({ url, username, password }) {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      transports: ['polling', 'websocket'],
      reconnection: false,
    });
    socket.on('connect', () => {
      socket.emit('login', { username, password, token: '' }, (res) => {
        if (res.ok) {
          // Brief wait for server-pushed events (monitorList, etc.)
          setTimeout(() => resolve(socket), 500);
        } else {
          reject(new Error(`Uptime Kuma login failed: ${res.msg}`));
        }
      });
    });
    socket.on('connect_error', (err) => reject(new Error(`Uptime Kuma connect error: ${err.message}`)));
  });
}

async function fetchMonitors(socket) {
  return new Promise((resolve, reject) => {
    socket.once('monitorList', (data) => resolve(Object.values(data || {})));
    socket.emit('getMonitorList', (res) => {
      if (res && res.ok === false) reject(new Error('getMonitorList failed'));
    });
  });
}

// ─── Matching helpers ─────────────────────────────────────────────────────────

function urlHostname(urlStr) {
  try { return new URL(urlStr).hostname.toLowerCase(); }
  catch { return null; }
}

function firstLabel(urlStr) {
  const h = urlHostname(urlStr);
  return h ? h.split('.')[0] : null;
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

function reconcile(backends, dnsHosts, monitors) {
  // Index non-group monitors by first subdomain label of their URL (first match wins).
  // This is the key used to join monitors to pfSense service names.
  const byLabel = new Map();
  for (const m of monitors) {
    if (m.type === 'group') continue;
    const label = m.url      ? firstLabel(m.url)
                : m.hostname ? m.hostname.toLowerCase().split('.')[0]
                : null;
    if (label && !byLabel.has(label)) byLabel.set(label, m);
  }

  // Build a unified service registry keyed by service name (lowercase).
  // Each entry records whether the service exists as a HAProxy backend,
  // as a public DNS entry (*.lamolabs.org), and which monitor covers it.
  const services = new Map();

  for (const b of backends) {
    const key = b.name.toLowerCase();
    services.set(key, { name: b.name, hasBackend: true, backend: b, hasDns: false, monitor: null });
  }

  for (const entry of dnsHosts) {
    // Skip the parent host entry when it has aliases — it's a container record
    // (e.g. lamolabs-svcs.lamolabs.org), not an actual service.
    const candidates = entry.aliases && entry.aliases.length > 0
      ? entry.aliases.map(a => ({ host: a.host, domain: a.domain }))
      : [{ host: entry.host, domain: entry.domain }];

    for (const { host, domain } of candidates) {
      if (!domain.endsWith('lamolabs.org')) continue;
      const key = host.toLowerCase();
      if (services.has(key)) {
        services.get(key).hasDns = true;
      } else {
        services.set(key, { name: host, hasBackend: false, backend: null, hasDns: true, monitor: null });
      }
    }
  }

  // Secondary index: monitors whose name exactly matches a service key.
  // Catches cases where the HAProxy backend name == monitor name but the
  // monitor URL uses a different DNS alias (e.g. pikvm-kvm-a3-02 backend,
  // monitor URL is pikvm-02.lamolabs.org).
  const byMonitorName = new Map();
  for (const m of monitors) {
    if (m.type === 'group') continue;
    const key = m.name.toLowerCase();
    if (!byMonitorName.has(key)) byMonitorName.set(key, m);
  }

  for (const [key, svc] of services) {
    svc.monitor = byLabel.get(key) || byMonitorName.get(key) || null;
  }

  // Monitors whose first subdomain label doesn't match any pfSense service name.
  const pfLabels = new Set(services.keys());
  const unmapped = monitors.filter(m => {
    if (m.type === 'group') return false;
    const label = m.url      ? firstLabel(m.url)
                : m.hostname ? m.hostname.split('.')[0].toLowerCase()
                : null;
    return label && !pfLabels.has(label);
  });

  return { services, unmapped };
}

// ─── Report helpers ───────────────────────────────────────────────────────────

function hdr(title, note = '') {
  const right = note ? `  ${c.gray}${note}${c.reset}` : '';
  console.log(`\n${c.bold}${title}${c.reset}${right}`);
  console.log(c.gray + '─'.repeat(72) + c.reset);
}

// Bucket unmapped monitors into three groups so the user knows which are
// expected (external access path, third-party) vs truly orphaned.
function categorize(unmapped) {
  const svcs = [], third = [], other = [];
  for (const m of unmapped) {
    const h = m.url ? urlHostname(m.url) : (m.hostname || '').toLowerCase();
    if (h.endsWith('.svcs.lamolabs.com') || (h.endsWith('.lamolabs.com') && !h.endsWith('.lamolabs.org'))) {
      svcs.push(m);
    } else if (!h.includes('lamolabs') && !h.includes('bub.lan') && !h.includes('svcs')) {
      third.push(m);
    } else {
      other.push(m);
    }
  }
  return { svcs, third, other };
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printReport(services, unmapped, monitors) {
  const all     = [...services.values()].sort((a, b) => a.name.localeCompare(b.name));
  const covered = all.filter(s => s.monitor);
  const allGaps = all.filter(s => !s.monitor);
  const ignoredSvcs = allGaps.filter(s => ignore.services.has(s.name.toLowerCase()));
  const gaps    = showIgnored ? allGaps : allGaps.filter(s => !ignore.services.has(s.name.toLowerCase()));
  const nameW   = Math.min(32, Math.max(7, ...all.map(s => s.name.length)) + 1);

  function tableHeader() {
    const n = 'SERVICE'.padEnd(nameW);
    console.log(`  ${c.gray}  ${n}  HAP  DNS  DETAIL${c.reset}`);
    console.log(`  ${c.gray}  ${'─'.repeat(nameW)}  ───  ───  ${'─'.repeat(30)}${c.reset}`);
  }

  function tableRow(icon, svc, detail) {
    const n  = c.bold + svc.name.padEnd(nameW) + c.reset;
    const be = svc.hasBackend ? `${c.green}HAP${c.reset}` : `${c.gray}   ${c.reset}`;
    const dn = svc.hasDns    ? `${c.green}DNS${c.reset}` : `${c.gray}   ${c.reset}`;
    console.log(`  ${icon} ${n}  ${be}  ${dn}  ${detail}`);
  }

  // ── Service Coverage ──────────────────────────────────────────────────────
  // Default: gaps only. Verbose: everything.
  const rows = verbose ? all : gaps;

  const ignoredNote = !showIgnored && ignoredSvcs.length > 0
    ? `  ${c.gray}(${ignoredSvcs.length} intentional gaps hidden — run with --show-ignored to see)${c.reset}`
    : '';

  if (!verbose) {
    hdr('Services Missing a UK Monitor', `${gaps.length} of ${all.length} services`);
  } else {
    hdr('Service Coverage', `${covered.length}/${all.length} tracked`);
  }

  if (rows.length === 0) {
    console.log(`  ${c.green}All ${all.length} pfSense services have an Uptime Kuma monitor.${c.reset}`);
  } else {
    tableHeader();
    for (const s of rows) {
      const icon = s.monitor ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
      let detail = '';
      if (s.monitor) {
        const ref = s.monitor.url || s.monitor.hostname || '';
        detail = `${c.cyan}${s.monitor.name}${c.reset}  ${c.gray}${ref}${c.reset}`;
      } else if (s.hasBackend && s.backend.servers.length > 0) {
        const sv = s.backend.servers[0];
        detail = `${c.gray}${sv.address}:${sv.port}${c.reset}`;
      }
      tableRow(icon, s, detail);
    }
  }

  if (!verbose) {
    console.log(`\n  ${c.gray}${covered.length}/${all.length} tracked — run with --verbose to also see matched services${c.reset}`);
    if (ignoredNote) console.log(ignoredNote);
  }

  // ── UK Monitors Not Linked to pfSense ────────────────────────────────────
  // Three buckets so the user knows which are expected vs surprising.
  const { svcs, third, other } = categorize(unmapped);

  hdr('UK Monitors Not Linked to pfSense', `${unmapped.length} total`);
  console.log(`  ${c.yellow}${String(svcs.length).padStart(3)}${c.reset}  on external-access path  ${c.gray}(*.svcs.lamolabs.com — same services, different inbound route)${c.reset}`);
  console.log(`  ${c.yellow}${String(third.length).padStart(3)}${c.reset}  third-party / external    ${c.gray}(google.com, simplelogin.io, ifconfig.*, pinboard.in, …)${c.reset}`);
  const ignoredMons = other.filter(m => ignore.monitors.has(m.name));
  const otherVisible = showIgnored ? other : other.filter(m => !ignore.monitors.has(m.name));

  if (otherVisible.length > 0) {
    console.log(`  ${c.red}${String(otherVisible.length).padStart(3)}${c.reset}  no pfSense counterpart found:`);
    for (const m of otherVisible) {
      console.log(`       ${c.yellow}?${c.reset} ${c.bold}${m.name}${c.reset}  ${c.gray}(${m.type}: ${m.url || m.hostname || ''})${c.reset}`);
    }
  } else {
    console.log(`  ${c.green}    0${c.reset}  no pfSense counterpart  ${c.gray}(all unmapped monitors are accounted for)${c.reset}`);
  }
  if (!showIgnored && ignoredMons.length > 0) {
    console.log(`  ${c.gray}      ${ignoredMons.length} intentional — run with --show-ignored to see${c.reset}`);
  }

  if (verbose && svcs.length > 0) {
    console.log(`\n  ${c.gray}External-access path monitors (*.svcs.lamolabs.com):${c.reset}`);
    for (const m of svcs) {
      console.log(`       ${c.gray}? ${m.name}  (${m.url || m.hostname || ''})${c.reset}`);
    }
  }
  if (verbose && third.length > 0) {
    console.log(`\n  ${c.gray}Third-party / external monitors:${c.reset}`);
    for (const m of third) {
      console.log(`       ${c.gray}? ${m.name}  (${m.url || m.hostname || ''})${c.reset}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  hdr('Summary');
  const nonGroup = monitors.filter(m => m.type !== 'group').length;
  const gapNote = !showIgnored && ignoredSvcs.length > 0 ? `  ${c.gray}+ ${ignoredSvcs.length} intentional${c.reset}` : '';
  const monNote = !showIgnored && ignoredMons.length > 0 ? `  ${c.gray}(${ignoredMons.length} intentional hidden)${c.reset}` : '';
  console.log(`  pfSense services  :  ${c.green}${covered.length} have a UK monitor${c.reset}  /  ${c.red}${gaps.length} actionable gaps${c.reset}${gapNote}  (${all.length} total)`);
  console.log(`  UK monitors       :  ${nonGroup} non-group  →  ${svcs.length} external-path, ${third.length} third-party, ${c.yellow}${otherVisible.length} unrecognized${c.reset}${monNote}`);
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${c.bold}pfSense → Uptime Kuma audit${c.reset}${verbose ? ' (verbose)' : ''}\n`);

  let socket;
  try {
    process.stdout.write(`Fetching pfSense data...        `);
    const { backends, dnsHosts } = await fetchPfSenseData();
    const aliasCount = dnsHosts.reduce((n, e) => n + (e.aliases?.length || 0), 0);
    console.log(`${c.green}done${c.reset}  ${c.gray}${backends.length} backends, ${dnsHosts.length} DNS hosts (${aliasCount} aliases)${c.reset}`);

    const ukConfig = loadUptimeKumaConfig();
    process.stdout.write(`Connecting to Uptime Kuma...    `);
    socket = await connectUptimeKuma(ukConfig);
    console.log(`${c.green}done${c.reset}  ${c.gray}${ukConfig.url}${c.reset}`);

    process.stdout.write(`Fetching monitors...            `);
    const monitors = await fetchMonitors(socket);
    console.log(`${c.green}done${c.reset}  ${c.gray}${monitors.length} monitors${c.reset}`);

    const { services, unmapped } = reconcile(backends, dnsHosts, monitors);
    printReport(services, unmapped, monitors);

  } catch (err) {
    console.error(`\n${c.red}Error: ${err.message}${c.reset}`);
    process.exit(1);
  } finally {
    if (socket) socket.disconnect();
  }
}

main();
