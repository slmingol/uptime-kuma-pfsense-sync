#!/usr/bin/env node
/**
 * Fix HAProxy backends that use generic docker-host/watcher/etc addresses.
 * For each backend where server.address != <backendName>.bub.lan:
 *   1. Create the DNS alias if missing
 *   2. PATCH the backend server address to use the service-specific hostname
 *
 * Usage: node fix-backend-hostnames.js [--dry-run]
 */
'use strict';

const axios  = require('axios');
const https  = require('https');
const path   = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const DRY_RUN = process.argv.includes('--dry-run');

const client = axios.create({
  baseURL: process.env.PFSENSE_HOST,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: { 'Accept': 'application/json', 'x-api-key': process.env.PFSENSE_API_SECRET },
  timeout: 15000,
});

const c = {
  reset:  '\x1b[0m',  bold: '\x1b[1m',
  green:  '\x1b[32m', cyan: '\x1b[36m',
  yellow: '\x1b[33m', gray: '\x1b[90m',
  red:    '\x1b[31m',
};

// Map from current server address (without domain) → svcs container parent name
// Parent host is the "-svcs" entry that holds aliases for that physical host.
const SVCS_PARENT = {
  'docker-host-01': 'docker-host-01-svcs',
  'docker-host-02': 'docker-host-02-svcs',
  'docker-host-03': 'docker-host-03-svcs',
  'ghost-files':    'ghost-files-svcs',
  'orangepi5':      'orangepi5-svcs',
  'watcher':        'watcher-svcs',
  'rockpi-4cplus':  'rockpi-4cplus-svcs',
  'pivot':          'pivot',            // standalone entry, no -svcs
};

// Backends that are disabled — skip server address updates for these serverids
const DISABLED_SERVERIDS = new Set([742]);  // unifi-ctrl1 disabled pfsense-rtr1 fallback

// Special-case: backends whose expected service alias doesn't match the lowercased backend name
const ALIAS_OVERRIDE = {
  'BandOnTheRun':    'bandontherun',
  'CreatureCountdown': 'creaturecountdown',
};

// Backends that point to pfSense itself (ntopng) — standalone host override needed, no -svcs parent
const PFSENSE_IP = '192.168.7.1';
const PFSENSE_BACKENDS = new Set(['ntopng']);

// pi-tor-01 IP for doco_cd_host8
const PI_TOR_01_IP = '192.168.7.31';

async function fetchBackends() {
  const r = await client.get('/api/v2/services/haproxy/backends');
  return r.data.data || [];
}

async function fetchHostOverrides() {
  const r = await client.get('/api/v2/services/dns_resolver/host_overrides');
  return r.data.data || [];
}

async function applyDns() {
  await client.post('/api/v2/services/dns_resolver/apply');
}

async function applyHaproxy() {
  await client.post('/api/v2/services/haproxy/apply');
}

// Normalize the ip field: pfSense returns it as an array or string
function normalizeIp(ip) {
  return Array.isArray(ip) ? ip[0] : ip;
}

// Build alias map: "alias.domain" → first IP
function buildAliasMap(overrides) {
  const map = {};
  for (const o of overrides) {
    const ip = normalizeIp(o.ip);
    map[`${o.host}.${o.domain}`] = ip;
    for (const a of (o.aliases || [])) {
      map[`${a.host}.${a.domain}`] = ip;
    }
  }
  return map;
}

// PATCH a backend server's address field
async function patchServerAddress(backend, server, newAddress) {
  if (!DRY_RUN) {
    const r = await client.patch('/api/v2/services/haproxy/backend/server', {
      parent_id: backend.id,
      id: server.id,
      address: newAddress,
    });
    if (r.data.code !== 200) throw new Error(r.data.message || 'PATCH failed');
  }
  console.log(`  ${c.green}✓${c.reset} HAProxy ${c.cyan}${backend.name}${c.reset}  ${c.gray}${server.address}${c.reset} → ${c.green}${newAddress}${c.reset}${DRY_RUN ? ' [dry-run]' : ''}`);
}

async function main() {
  console.log(`\n${c.bold}HAProxy backend hostname fix${DRY_RUN ? ' (DRY RUN)' : ''}${c.reset}`);
  console.log(c.gray + '─'.repeat(72) + c.reset);

  const [backends, overrides] = await Promise.all([fetchBackends(), fetchHostOverrides()]);
  const aliasMap = buildAliasMap(overrides);

  // Collect all mismatches
  const mismatches = [];
  for (const b of backends) {
    for (const s of (b.servers || [])) {
      if (DISABLED_SERVERIDS.has(s.serverid)) continue;
      const aliasName = (ALIAS_OVERRIDE[b.name] || b.name.toLowerCase());
      const expectedAddr = `${aliasName}.bub.lan`;
      const currentAddr  = (s.address || '').toLowerCase();
      if (currentAddr !== expectedAddr) {
        mismatches.push({ backend: b, server: s, aliasName, expectedAddr });
      }
    }
  }

  console.log(`\n${c.bold}Backends to fix: ${mismatches.length}${c.reset}\n`);

  // Phase 1: DNS
  // Plan: separate standalone creations (which shift pfSense config indices) from alias
  // additions, then re-fetch with fresh indices before PATCHing svcs containers.
  console.log(`${c.bold}Phase 1: DNS aliases${c.reset}`);
  let dnsChanged = false;

  // Collect work into three buckets
  const standalones  = [];   // { aliasName, ip }
  const aliasWork    = {};   // svcsParentName → Set of aliasNames to add
  const conflictWork = [];   // { aliasName, staleParentName, correctParentName }

  for (const { backend, server, aliasName, expectedAddr } of mismatches) {
    const currentAddr    = server.address.toLowerCase();
    const currentHostKey = currentAddr.replace('.bub.lan', '');
    const svcsParentName = SVCS_PARENT[currentHostKey];
    const backendHostIp  = aliasMap[currentAddr] ||
                           (svcsParentName ? aliasMap[`${svcsParentName}.bub.lan`] : null);

    if (aliasMap[expectedAddr]) {
      const existingIp = aliasMap[expectedAddr];
      if (backendHostIp && existingIp !== backendHostIp) {
        const staleParent = Object.entries(SVCS_PARENT)
          .find(([, v]) => aliasMap[`${v}.bub.lan`] === existingIp);
        if (staleParent && svcsParentName) {
          conflictWork.push({ aliasName, staleParentName: staleParent[1], correctParentName: svcsParentName });
        }
      }
      continue;
    }

    if (PFSENSE_BACKENDS.has(backend.name)) {
      standalones.push({ aliasName, ip: PFSENSE_IP });
      continue;
    }
    if (currentAddr === 'pi-tor-01.bub.lan') {
      standalones.push({ aliasName, ip: PI_TOR_01_IP });
      continue;
    }
    if (!svcsParentName) {
      console.log(`  ${c.yellow}⚠ No svcs parent for ${currentAddr} (${backend.name})${c.reset}`);
      continue;
    }
    if (!aliasWork[svcsParentName]) aliasWork[svcsParentName] = new Set();
    aliasWork[svcsParentName].add(aliasName);
  }

  // Step 1a: Create standalone overrides
  for (const { aliasName, ip } of standalones) {
    const exists = overrides.some(o => o.host === aliasName && o.domain === 'bub.lan');
    if (exists) {
      console.log(`  ${c.gray}standalone already exists: ${aliasName}.bub.lan${c.reset}`);
      continue;
    }
    if (!DRY_RUN) {
      const r = await client.post('/api/v2/services/dns_resolver/host_override', {
        host: aliasName, domain: 'bub.lan', ip: [ip], descr: '',
      });
      if (r.data.code !== 200) throw new Error(`POST ${aliasName}.bub.lan: ${r.data.message}`);
    }
    console.log(`  ${c.green}✓${c.reset} DNS host override ${c.cyan}${aliasName}.bub.lan${c.reset} → ${c.gray}${ip}${c.reset}${DRY_RUN ? ' [dry-run]' : ''}`);
    dnsChanged = true;
  }

  // Step 1b: Re-fetch overrides (standalone creations shift pfSense config indices)
  const freshOverrides = DRY_RUN ? overrides : await fetchHostOverrides();

  // Step 1c: Batch all alias additions per parent (one PATCH per svcs container)
  for (const [parentName, aliasNames] of Object.entries(aliasWork)) {
    const [parentHost, ...rest] = parentName.split('-svcs'); // 'docker-host-01-svcs' → host='docker-host-01', suffix='-svcs'
    // Find parent entry in fresh overrides by host name
    const idx = freshOverrides.findIndex(o => o.host === parentName && o.domain === 'bub.lan');
    if (idx === -1) {
      console.log(`  ${c.yellow}⚠ Parent not found in fresh overrides: ${parentName}.bub.lan${c.reset}`);
      continue;
    }
    const entry = freshOverrides[idx];
    const existing = new Set((entry.aliases || []).map(a => `${a.host}.${a.domain}`));
    const toAdd = [...aliasNames].filter(n => !existing.has(`${n}.bub.lan`));
    if (toAdd.length === 0) {
      console.log(`  ${c.gray}all aliases already exist in ${parentName}.bub.lan${c.reset}`);
      continue;
    }
    const newAliases = [
      ...(entry.aliases || []),
      ...toAdd.map(n => ({ host: n, domain: 'bub.lan', descr: '' })),
    ];
    if (!DRY_RUN) {
      const r = await client.patch('/api/v2/services/dns_resolver/host_override', {
        id: idx, host: entry.host, domain: entry.domain, ip: entry.ip, descr: entry.descr || '',
        aliases: newAliases,
      });
      if (r.data.code !== 200) throw new Error(`PATCH ${parentName}: ${r.data.message}`);
      entry.aliases = newAliases;
    }
    for (const n of toAdd) {
      console.log(`  ${c.green}✓${c.reset} DNS alias ${c.cyan}${n}.bub.lan${c.reset} → ${c.gray}${normalizeIp(entry.ip)} (${parentName}.bub.lan)${c.reset}${DRY_RUN ? ' [dry-run]' : ''}`);
    }
    dnsChanged = true;
  }

  // Step 1d: Fix DNS conflicts (alias in wrong svcs container)
  for (const { aliasName, staleParentName, correctParentName } of conflictWork) {
    const staleIp   = aliasMap[`${staleParentName}.bub.lan`];
    const correctIp = aliasMap[`${correctParentName}.bub.lan`];
    console.log(`\n  ${c.yellow}⚠ DNS conflict for ${aliasName}.bub.lan${c.reset}: alias → ${staleIp}, should be → ${correctIp}`);
    // Remove from stale parent
    const staleIdx = freshOverrides.findIndex(o => o.host === staleParentName && o.domain === 'bub.lan');
    if (staleIdx !== -1) {
      const staleEntry = freshOverrides[staleIdx];
      const filtered   = (staleEntry.aliases || []).filter(a => !(a.host === aliasName && a.domain === 'bub.lan'));
      if (!DRY_RUN) {
        await client.patch('/api/v2/services/dns_resolver/host_override', {
          id: staleIdx, host: staleEntry.host, domain: staleEntry.domain,
          ip: staleEntry.ip, descr: staleEntry.descr || '', aliases: filtered,
        });
        staleEntry.aliases = filtered;
      }
      console.log(`  ${c.yellow}↩${c.reset} removed ${c.cyan}${aliasName}.bub.lan${c.reset} from ${c.gray}${staleParentName}.bub.lan${c.reset}${DRY_RUN ? ' [dry-run]' : ''}`);
    }
    // Add to correct parent
    const correctIdx = freshOverrides.findIndex(o => o.host === correctParentName && o.domain === 'bub.lan');
    if (correctIdx !== -1) {
      const correctEntry = freshOverrides[correctIdx];
      const newAliases   = [...(correctEntry.aliases || []), { host: aliasName, domain: 'bub.lan', descr: '' }];
      if (!DRY_RUN) {
        await client.patch('/api/v2/services/dns_resolver/host_override', {
          id: correctIdx, host: correctEntry.host, domain: correctEntry.domain,
          ip: correctEntry.ip, descr: correctEntry.descr || '', aliases: newAliases,
        });
        correctEntry.aliases = newAliases;
      }
      console.log(`  ${c.green}✓${c.reset} DNS alias ${c.cyan}${aliasName}.bub.lan${c.reset} → ${c.gray}${normalizeIp(correctEntry.ip)} (${correctParentName}.bub.lan)${c.reset}${DRY_RUN ? ' [dry-run]' : ''}`);
    }
    dnsChanged = true;
  }

  if (dnsChanged && !DRY_RUN) {
    await applyDns();
    console.log(`  ${c.gray}DNS applied${c.reset}`);
  }

  // Phase 2: HAProxy backend server patches
  console.log(`\n${c.bold}Phase 2: HAProxy backend server addresses${c.reset}`);
  let haproxyChanged = false;
  let ok = 0, fail = 0;

  for (const { backend, server, expectedAddr } of mismatches) {
    try {
      await patchServerAddress(backend, server, expectedAddr);
      ok++;
      haproxyChanged = true;
    } catch (err) {
      console.log(`  ${c.red}✗${c.reset} ${backend.name}: ${err.response?.data?.message || err.message}`);
      fail++;
    }
  }

  if (haproxyChanged && !DRY_RUN) {
    await applyHaproxy();
    console.log(`  ${c.gray}HAProxy applied${c.reset}`);
  }

  console.log(`\n${c.gray}Done: ${ok} backend servers updated, ${fail} failed.${c.reset}\n`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
