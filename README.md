<p align="center">
  <img src="banner.svg" alt="uptime-kuma-pfsense-sync" width="100%"/>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white" alt="Node.js >= 18"/>
  <img src="https://img.shields.io/badge/pfSense-REST%20API%20v2-f0581c?logo=pfsense&logoColor=white" alt="pfSense REST API v2"/>
  <img src="https://img.shields.io/badge/Uptime%20Kuma-Socket.IO-5cdd8b?logoColor=white" alt="Uptime Kuma"/>
  <img src="https://img.shields.io/badge/axios-%5E1.0-5a7dc8?logo=axios&logoColor=white" alt="axios"/>
  <img src="https://img.shields.io/badge/socket.io--client-%5E4.6-010101?logo=socket.io&logoColor=white" alt="socket.io-client"/>
  <img src="https://img.shields.io/badge/podman%20%7C%20docker-compatible-892CA0?logo=podman&logoColor=white" alt="podman | docker"/>
  <img src="https://img.shields.io/github/v/release/slmingol/uptime-kuma-pfsense-sync" alt="GitHub release"/>
  <img src="https://img.shields.io/github/actions/workflow/status/slmingol/uptime-kuma-pfsense-sync/release.yml?label=release" alt="Release status"/>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"/>
</p>

---

Audit and reconciliation tool for keeping [Uptime Kuma](https://github.com/louislam/uptime-kuma) monitors in sync with pfSense HAProxy backends and DNS host overrides. Produces a unified service map showing coverage across all three systems — HAProxy, DNS, and Uptime Kuma — in a single pass.

## How it works

The tool fetches data from pfSense (HAProxy backends + DNS resolver host overrides) and Uptime Kuma (monitor list), then builds a unified service registry keyed by first subdomain label (e.g. `nextcloud` from `nextcloud.example.com`). Each service entry shows whether it has a HAProxy backend, a public DNS alias, and an active UK monitor.

Matching is two-pass: first by monitor URL label, then by monitor name — so services where the HAProxy backend name and monitor name agree but the monitor URL uses a different DNS alias are correctly resolved.

## Setup

**Prerequisites:**
- `../pfsense-cli` — pfSense CLI (used by Makefile survey targets)
- `../uptime-kuma-sync-n-bak` — UK backup/sync/list scripts and `uptime-kuma-config.json`

```bash
cp .env.example .env
# edit .env — fill in PFSENSE_HOST, PFSENSE_API_KEY, PFSENSE_API_SECRET
# set UPTIME_KUMA_INSTANCE to a named instance in uptime-kuma-config.json
npm install
```

**.env options:**

```env
# pfSense
PFSENSE_HOST=https://pfsense.example.lan:10443
PFSENSE_API_KEY=your-api-key
PFSENSE_API_SECRET=your-api-secret
NODE_TLS_REJECT_UNAUTHORIZED=0

# Uptime Kuma — Option A: named instance from uptime-kuma-config.json
UPTIME_KUMA_INSTANCE=primary

# Uptime Kuma — Option B: direct credentials
# UPTIME_KUMA_URL=https://uptime-kuma.example.com
# UPTIME_KUMA_USER=admin
# UPTIME_KUMA_PASS=your-password
```

## Usage

```bash
make              # show help

# Reconciliation
make audit        # gap report — actionable gaps only (default)
make survey       # full inventory with match status for every service
make fix          # preview monitors that would be created for gaps (dry-run)
make fix DRY_RUN=0            # create monitors for all actionable gaps
make fix DRY_RUN=0 GROUP=5    # place new monitors in group ID 5
make fix DRY_RUN=0 YES=1      # skip confirmation prompt

# Target a different UK instance
make audit INSTANCE=secondary

# pfSense survey
make pf-audit                 # audit HAProxy backend addresses for hostname risk
make pf-backends              # list all HAProxy backends
make pf-backends FILTER=jelly # filter by name
make pf-dns                   # list all DNS host overrides

# Uptime Kuma survey
make uk-monitors              # list monitors grouped by group
make uk-monitors-tldr         # summary counts by group and type
make uk-backup                # backup monitors to JSON
make uk-diff                  # field-level diff: primary vs secondary

# Add a monitor
make uk-add NAME="My App" URL="http://host:8080"
make uk-add NAME="Host ping" TYPE=ping HOSTNAME=host.bub.lan GROUP=100
```

## Container

The image is built and pushed to GHCR on every release via GitHub Actions.

### Production deploy

No source checkout needed — just the compose file, a config dir, and a `.env`.

```bash
cd /home/slm/docker_apps
mkdir uptime-kuma-pfsense-sync && cd uptime-kuma-pfsense-sync

# Grab the compose file
curl -sO https://raw.githubusercontent.com/slmingol/uptime-kuma-pfsense-sync/main/docker-compose.yaml
curl -sO https://raw.githubusercontent.com/slmingol/uptime-kuma-pfsense-sync/main/.env.example

# Drop in the Uptime Kuma config
mkdir config
scp <devbox>:~/dev/projects/uptime-kuma-sync-n-bak/uptime-kuma-config.json config/

# Configure credentials
cp .env.example .env
# edit .env: PFSENSE_HOST, PFSENSE_API_KEY, PFSENSE_API_SECRET, AUDIT_PORT

podman compose up -d
```

The dashboard runs at `http://<host>:${AUDIT_PORT:-3210}`.

### Local dev

The repo includes `docker-compose.override.yaml` which is auto-merged by compose and adds `build: .` for the local build loop. No prod host will have this file.

```bash
make docker-build          # build from local source
make docker-restart        # rebuild and restart
make docker-audit          # run gap audit in container
make docker-survey         # run full survey in container
make docker-audit INSTANCE=secondary
```

Symlink the config from the sibling repo so the local container can read it:

```bash
mkdir -p config
ln -sf ../../uptime-kuma-sync-n-bak/uptime-kuma-config.json config/uptime-kuma-config.json
```

## Audit output

<p align="center">
  <img src="audit-output.svg" alt="make audit output" width="100%"/>
</p>

**CLI flags (passed via `node audit.js` or the Makefile targets):**

| Flag | Description |
|---|---|
| `--verbose` / `-v` | Show all services, not just gaps |
| `--all` | Include entries suppressed by `.audit-ignore.json` |
| `--fix` | Create UK monitors for all actionable gaps |
| `--dry-run` | With `--fix`: print what would be created without doing it |
| `--yes` / `-y` | With `--fix`: skip the confirmation prompt |
| `--group <id>` | With `--fix`: place new monitors in the given group ID |
| `--interval <s>` | With `--fix`: check interval in seconds (default: 60) |

URL selection for `--fix`: services with a DNS entry get `https://<name>.lamolabs.org`; HAProxy-only services use the first backend server hostname; raw-IP backends fall back to `http://address:port`.

## Web dashboard

The web dashboard (`make server` or `make docker-up`) runs both audits on a shared schedule and presents three panels:

| Panel | What it checks |
|---|---|
| Services Missing a UK Monitor | pfSense backends/DNS entries with no Uptime Kuma monitor |
| UK Monitors Without a pfSense Match | Uptime Kuma monitors not linked to any pfSense service |
| HAProxy Backend Address Health | Backend server addresses classified by risk: static IP (safe), service hostname (reload risk), shared/catch-all host (high risk) |

The schedule defaults to `0 8 * * *` and can be overridden with `AUDIT_CRON`. A "Run Now" button triggers an on-demand run.

## Suppressing known-intentional gaps

Services and monitors that are intentionally unmonitored are listed in `.audit-ignore.json`. They are hidden from the default output but fully visible with `--show-ignored`.

```json
{
  "services": [
    "deploy-agent-01",
    "omv",
    "internal-svc",
    "..."
  ],
  "monitors": [
    "bypass-proxy",
    "NET - router-01",
    "..."
  ]
}
```

Common reasons to ignore a service:
- **Alias for another tracked service** — `files` is a vanity alias for `fileserver`
- **Already covered under a different name** — `MyApp` backend is monitored via the `app` DNS alias
- **Internal infrastructure** — CD pipeline agents, mesh nodes, UK instances themselves

## Domain conventions

| Domain | Purpose |
|---|---|
| `*.example.com` | Public services routed through pfSense HAProxy |
| `*.example.lan` | Internal LAN DNS — not tracked in the service registry |
| `*.vpn.example.com` | External VPN/tunnel access path — same services, different inbound route, not a gap |

HAProxy backend server addresses typically use hostnames (e.g. `service.example.lan`); static IPs are used where DNS reliability at reload time is a concern.
