'use strict';

const path = require('path');
const fs   = require('fs');
const axios = require('axios');
const https = require('https');
const io    = require('socket.io-client');

// ─── pfSense ──────────────────────────────────────────────────────────────────

function buildPfSenseClient() {
  const { PFSENSE_HOST, PFSENSE_API_KEY, PFSENSE_API_SECRET } = process.env;
  if (!PFSENSE_HOST || !PFSENSE_API_KEY || !PFSENSE_API_SECRET) {
    throw new Error('Missing PFSENSE_HOST, PFSENSE_API_KEY, or PFSENSE_API_SECRET');
  }
  return axios.create({
    baseURL: PFSENSE_HOST,
    headers: { 'Accept': 'application/json', 'x-api-key': PFSENSE_API_SECRET },
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
  if (backendsRes.data.code !== 200) throw new Error(`pfSense backends: ${backendsRes.data.message}`);
  if (dnsRes.data.code !== 200)      throw new Error(`pfSense DNS: ${dnsRes.data.message}`);
  return { backends: backendsRes.data.data || [], dnsHosts: dnsRes.data.data || [] };
}

// ─── Uptime Kuma ─────────────────────────────────────────────────────────────

function loadUptimeKumaConfig() {
  const instance = process.env.UPTIME_KUMA_INSTANCE;
  if (instance) {
    const configPath = process.env.UPTIME_KUMA_CONFIG ||
      path.resolve(__dirname, '../../uptime-kuma-sync-n-bak/uptime-kuma-config.json');
    if (!fs.existsSync(configPath)) throw new Error(`UK config not found at ${configPath}`);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const inst = raw.instances?.[instance];
    if (!inst) throw new Error(`Instance '${instance}' not found. Available: ${Object.keys(raw.instances || {}).join(', ')}`);
    return { url: inst.url, username: inst.username, password: inst.password };
  }
  const { UPTIME_KUMA_URL: url, UPTIME_KUMA_USER: username, UPTIME_KUMA_PASS: password } = process.env;
  if (!url || !username || !password) {
    throw new Error('Set UPTIME_KUMA_INSTANCE or UPTIME_KUMA_URL + UPTIME_KUMA_USER + UPTIME_KUMA_PASS');
  }
  return { url, username, password };
}

async function connectUptimeKuma({ url, username, password }) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['polling', 'websocket'], reconnection: false });
    socket.on('connect', () => {
      socket.emit('login', { username, password, token: '' }, (res) => {
        if (res.ok) setTimeout(() => resolve(socket), 500);
        else reject(new Error(`UK login failed: ${res.msg}`));
      });
    });
    socket.on('connect_error', (err) => reject(new Error(`UK connect error: ${err.message}`)));
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
  const byLabel = new Map();
  for (const m of monitors) {
    if (m.type === 'group') continue;
    const label = m.url ? firstLabel(m.url) : m.hostname ? m.hostname.toLowerCase().split('.')[0] : null;
    if (label && !byLabel.has(label)) byLabel.set(label, m);
  }

  // Secondary: match by monitor name (catches backends whose name == monitor name
  // but the monitor URL uses a different DNS alias, e.g. pikvm-kvm-a3-02).
  const byMonitorName = new Map();
  for (const m of monitors) {
    if (m.type === 'group') continue;
    const key = m.name.toLowerCase();
    if (!byMonitorName.has(key)) byMonitorName.set(key, m);
  }

  const services = new Map();
  for (const b of backends) {
    const key = b.name.toLowerCase();
    services.set(key, { name: b.name, hasBackend: true, backend: b, hasDns: false, monitor: null });
  }

  for (const entry of dnsHosts) {
    // Skip parent container entries (they hold aliases, not a service themselves).
    const candidates = entry.aliases && entry.aliases.length > 0
      ? entry.aliases.map(a => ({ host: a.host, domain: a.domain }))
      : [{ host: entry.host, domain: entry.domain }];
    for (const { host, domain } of candidates) {
      if (!domain.endsWith('lamolabs.org')) continue;
      const key = host.toLowerCase();
      if (services.has(key)) services.get(key).hasDns = true;
      else services.set(key, { name: host, hasBackend: false, backend: null, hasDns: true, monitor: null });
    }
  }

  for (const [key, svc] of services) {
    svc.monitor = byLabel.get(key) || byMonitorName.get(key) || null;
  }

  const pfLabels = new Set(services.keys());
  const unmapped = monitors.filter(m => {
    if (m.type === 'group') return false;
    const label = m.url ? firstLabel(m.url) : m.hostname ? m.hostname.split('.')[0].toLowerCase() : null;
    return label && !pfLabels.has(label);
  });

  return { services, unmapped };
}

// ─── Bucketing ────────────────────────────────────────────────────────────────

function categorize(unmapped) {
  const svcs = [], third = [], other = [];
  for (const m of unmapped) {
    const h = m.url ? urlHostname(m.url) : (m.hostname || '').toLowerCase();
    if (h && (h.endsWith('.svcs.lamolabs.com') || (h.endsWith('.lamolabs.com') && !h.endsWith('.lamolabs.org')))) {
      svcs.push(m);
    } else if (h && !h.includes('lamolabs') && !h.includes('bub.lan') && !h.includes('svcs')) {
      third.push(m);
    } else {
      other.push(m);
    }
  }
  return { svcs, third, other };
}

// ─── Ignore list ──────────────────────────────────────────────────────────────

function loadIgnoreList() {
  const configPath = process.env.AUDIT_IGNORE_FILE ||
    path.resolve(__dirname, '../.audit-ignore.json');
  if (!fs.existsSync(configPath)) return { services: new Set(), monitors: new Set() };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return {
      services: new Set((raw.services || []).map(s => s.toLowerCase())),
      monitors: new Set((raw.monitors || []).map(s => s.toLowerCase())),
    };
  } catch {
    return { services: new Set(), monitors: new Set() };
  }
}

async function addMonitor(socket, payload) {
  return new Promise((resolve, reject) => {
    socket.emit('add', payload, (res) => {
      if (res.ok) resolve(res.monitorID);
      else reject(new Error(res.msg || 'add monitor failed'));
    });
  });
}

module.exports = {
  fetchPfSenseData,
  loadUptimeKumaConfig,
  connectUptimeKuma,
  fetchMonitors,
  addMonitor,
  reconcile,
  categorize,
  urlHostname,
  firstLabel,
  loadIgnoreList,
};
