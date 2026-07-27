#!/usr/bin/env node
'use strict';

require('dotenv').config();

const readline = require('readline');
const {
  fetchPfSenseData, loadUptimeKumaConfig, connectUptimeKuma,
  fetchMonitors, addMonitor, reconcile, categorize, urlHostname, loadIgnoreList,
} = require('./lib/audit-core');

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  gray:   '\x1b[90m',
};

const args    = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const showAll = args.includes('--all');   // include ignored services
const fixMode = args.includes('--fix');
const dryRun  = args.includes('--dry-run');
const autoYes = args.includes('--yes') || args.includes('-y');

function flagVal(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}
const fixGroup    = flagVal('group') ? parseInt(flagVal('group'), 10) : null;
const fixInterval = flagVal('interval') ? parseInt(flagVal('interval'), 10) : 60;

// ─── Report helpers ───────────────────────────────────────────────────────────

function hdr(title, note = '') {
  const right = note ? `  ${c.gray}${note}${c.reset}` : '';
  console.log(`\n${c.bold}${title}${c.reset}${right}`);
  console.log(c.gray + '─'.repeat(72) + c.reset);
}

function printReport(services, unmapped, monitors) {
  const ignore = loadIgnoreList();

  const all     = [...services.values()].sort((a, b) => a.name.localeCompare(b.name));
  const covered = all.filter(s => s.monitor);
  const gaps    = all.filter(s => !s.monitor);
  const actionable = showAll ? gaps : gaps.filter(s => !ignore.services.has(s.name.toLowerCase()));
  const skipped    = gaps.length - actionable.length;

  const nameW = Math.min(32, Math.max(7, ...all.map(s => s.name.length)) + 1);

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
  const rows = verbose ? all : actionable;

  if (!verbose) {
    const note = skipped > 0 ? `${actionable.length} actionable of ${gaps.length} gaps (${skipped} suppressed)` : `${gaps.length} of ${all.length} services`;
    hdr('Services Missing a UK Monitor', note);
  } else {
    hdr('Service Coverage', `${covered.length}/${all.length} tracked`);
  }

  if (rows.length === 0) {
    console.log(`  ${c.green}All services accounted for.${c.reset}`);
  } else {
    tableHeader();
    for (const s of rows) {
      const icon = s.monitor ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
      let detail = '';
      if (s.monitor) {
        const ref = s.monitor.url || s.monitor.hostname || '';
        detail = `${c.cyan}${s.monitor.name}${c.reset}  ${c.gray}${ref}${c.reset}`;
      } else if (s.hasBackend && s.backend?.servers?.length > 0) {
        const sv = s.backend.servers[0];
        detail = `${c.gray}${sv.address}:${sv.port}${c.reset}`;
      }
      tableRow(icon, s, detail);
    }
  }

  if (!verbose) {
    const hint = skipped > 0
      ? `${covered.length}/${all.length} tracked — ${skipped} suppressed by .audit-ignore.json — use --all to show`
      : `${covered.length}/${all.length} tracked — run with --verbose to also see matched services`;
    console.log(`\n  ${c.gray}${hint}${c.reset}`);
  }

  // ── UK Monitors Not Linked to pfSense ────────────────────────────────────
  const { svcs, third, other } = categorize(unmapped);
  const actionableOther = showAll ? other : other.filter(m => !ignore.monitors.has(m.name.toLowerCase()));
  const skippedMonitors = other.length - actionableOther.length;

  hdr('UK Monitors Not Linked to pfSense', `${unmapped.length} total`);
  console.log(`  ${c.yellow}${String(svcs.length).padStart(3)}${c.reset}  on external-access path  ${c.gray}(*.svcs.lamolabs.com)${c.reset}`);
  console.log(`  ${c.yellow}${String(third.length).padStart(3)}${c.reset}  third-party / external`);
  if (actionableOther.length > 0) {
    console.log(`  ${c.red}${String(actionableOther.length).padStart(3)}${c.reset}  no pfSense counterpart found:`);
    for (const m of actionableOther) {
      console.log(`       ${c.yellow}?${c.reset} ${c.bold}${m.name}${c.reset}  ${c.gray}(${m.type}: ${m.url || m.hostname || ''})${c.reset}`);
    }
  } else {
    console.log(`  ${c.green}    0${c.reset}  no pfSense counterpart  ${c.gray}(all accounted for)${c.reset}`);
  }
  if (skippedMonitors > 0 && !showAll) {
    console.log(`  ${c.gray}      (${skippedMonitors} suppressed by .audit-ignore.json — use --all to show)${c.reset}`);
  }

  if (verbose) {
    if (svcs.length > 0) {
      console.log(`\n  ${c.gray}External-access path monitors:${c.reset}`);
      for (const m of svcs) console.log(`       ${c.gray}? ${m.name}  (${m.url || m.hostname || ''})${c.reset}`);
    }
    if (third.length > 0) {
      console.log(`\n  ${c.gray}Third-party / external monitors:${c.reset}`);
      for (const m of third) console.log(`       ${c.gray}? ${m.name}  (${m.url || m.hostname || ''})${c.reset}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  hdr('Summary');
  const nonGroup = monitors.filter(m => m.type !== 'group').length;
  console.log(`  pfSense services  :  ${c.green}${covered.length} have a UK monitor${c.reset}  /  ${c.red}${actionable.length} actionable gaps${c.reset}  (${all.length} total, ${skipped} suppressed)`);
  console.log(`  UK monitors       :  ${nonGroup} non-group  →  ${svcs.length} ext-path, ${third.length} third-party, ${c.yellow}${actionableOther.length} unrecognized${c.reset}`);
  console.log('');
}

// ─── Fix mode ─────────────────────────────────────────────────────────────────

function buildUrl(svc) {
  if (svc.hasDns) return `https://${svc.name}.lamolabs.org`;
  if (svc.hasBackend && svc.backend?.servers?.length > 0) {
    const sv = svc.backend.servers[0];
    // prefer hostname over raw IP per convention
    if (sv.address && !/^\d+\.\d+\.\d+\.\d+$/.test(sv.address)) {
      return `https://${sv.address}`;
    }
    return `http://${sv.address}:${sv.port}`;
  }
  return null;
}

function buildPayload(svc) {
  const url = buildUrl(svc);
  if (!url) return null;
  return {
    name: svc.name,
    type: 'http',
    url,
    method: 'GET',
    interval: fixInterval,
    retryInterval: fixInterval,
    maxretries: 3,
    accepted_statuscodes: ['200-299'],
    parent: fixGroup,
    active: 1,
    conditions: [],
  };
}

async function confirm(question) {
  if (autoYes) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase() === 'y'); });
  });
}

async function runFix(socket, services) {
  const ignore = loadIgnoreList();
  const gaps = [...services.values()]
    .filter(s => !s.monitor && !ignore.services.has(s.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (gaps.length === 0) {
    console.log(`\n${c.green}No actionable gaps — nothing to add.${c.reset}\n`);
    return;
  }

  const payloads = gaps.map(s => ({ svc: s, payload: buildPayload(s) }));
  const valid   = payloads.filter(p => p.payload);
  const noUrl   = payloads.filter(p => !p.payload);

  hdr('Fix mode — monitors to create', `${valid.length} to add${noUrl.length ? `, ${noUrl.length} skipped (no usable URL)` : ''}`);
  for (const { svc, payload } of valid) {
    const dns = svc.hasDns ? `${c.green}DNS${c.reset}` : `${c.gray}   ${c.reset}`;
    const hap = svc.hasBackend ? `${c.green}HAP${c.reset}` : `${c.gray}   ${c.reset}`;
    console.log(`  ${c.yellow}+${c.reset} ${c.bold}${svc.name.padEnd(30)}${c.reset}  ${hap}  ${dns}  ${c.cyan}${payload.url}${c.reset}`);
  }
  if (noUrl.length) {
    console.log(`\n  ${c.gray}Skipped (no usable URL):${c.reset}`);
    for (const { svc } of noUrl) console.log(`    ${c.gray}- ${svc.name}${c.reset}`);
  }

  if (dryRun) {
    console.log(`\n${c.gray}Dry run — no monitors created.${c.reset}\n`);
    return;
  }

  const ok = await confirm(`\nCreate ${valid.length} monitor(s)? [y/N] `);
  if (!ok) { console.log(`${c.gray}Aborted.${c.reset}\n`); return; }

  console.log('');
  let created = 0;
  for (const { svc, payload } of valid) {
    process.stdout.write(`  Adding ${svc.name}... `);
    try {
      const id = await addMonitor(socket, payload);
      console.log(`${c.green}✓${c.reset} id=${id}`);
      created++;
    } catch (err) {
      console.log(`${c.red}✗ ${err.message}${c.reset}`);
    }
  }
  console.log(`\n${c.green}${created}/${valid.length} monitors created.${c.reset}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const modeLabel = fixMode ? (dryRun ? ' (fix --dry-run)' : ' (fix)') : (verbose ? ' (verbose)' : '');
  console.log(`${c.bold}pfSense → Uptime Kuma audit${c.reset}${modeLabel}${showAll ? ' (all)' : ''}\n`);
  let socket;
  try {
    process.stdout.write('Fetching pfSense data...        ');
    const { backends, dnsHosts } = await fetchPfSenseData();
    const aliasCount = dnsHosts.reduce((n, e) => n + (e.aliases?.length || 0), 0);
    console.log(`${c.green}done${c.reset}  ${c.gray}${backends.length} backends, ${dnsHosts.length} DNS hosts (${aliasCount} aliases)${c.reset}`);

    const ukConfig = loadUptimeKumaConfig();
    process.stdout.write('Connecting to Uptime Kuma...    ');
    socket = await connectUptimeKuma(ukConfig);
    console.log(`${c.green}done${c.reset}  ${c.gray}${ukConfig.url}${c.reset}`);

    process.stdout.write('Fetching monitors...            ');
    const monitors = await fetchMonitors(socket);
    console.log(`${c.green}done${c.reset}  ${c.gray}${monitors.length} monitors${c.reset}`);

    const { services, unmapped } = reconcile(backends, dnsHosts, monitors);

    if (fixMode) {
      await runFix(socket, services);
    } else {
      printReport(services, unmapped, monitors);
    }

  } catch (err) {
    console.error(`\n${c.red}Error: ${err.message}${c.reset}`);
    process.exit(1);
  } finally {
    if (socket) socket.disconnect();
  }
}

main();
