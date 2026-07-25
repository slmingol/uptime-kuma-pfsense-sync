## <small>1.8.2 (2026-07-25)</small>

* fix(ui): increase base font size 16px → 18px ([e9afe13](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/e9afe13))

## <small>1.8.1 (2026-07-25)</small>

* fix(ui): increase base font size 14px → 16px and lift small label floor ([5872d67](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/5872d67))

## 1.8.0 (2026-07-25)

* feat(ui): add legend section explaining badges and status indicators ([66918f4](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/66918f4))

## <small>1.7.3 (2026-07-24)</small>

* fix(ui): increase text contrast — tx-dim was barely readable at 2:1 ([80f65bd](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/80f65bd))

## <small>1.7.2 (2026-07-24)</small>

* fix(ui): replace raw color values with a cohesive CSS token palette ([ba5d68d](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/ba5d68d))

## <small>1.7.1 (2026-07-24)</small>

* fix(ui): render UK Monitors section as table instead of chips ([36fef11](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/36fef11))

## 1.7.0 (2026-07-24)

* feat(ui): add Show all toggle to UK Monitors and HAProxy sections ([d13ed87](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/d13ed87))

## <small>1.6.3 (2026-07-24)</small>

* fix(ui): clarify dashboard labels and empty-state messages ([0703f80](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/0703f80))
* chore: add one-shot script to fix HAProxy backend hostnames ([5adb80a](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/5adb80a))

## <small>1.6.2 (2026-07-23)</small>

* docs: fix override filename reference in README (.yml -> .yaml) ([c14744e](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/c14744e))
* chore: rename compose files from .yml to .yaml ([426678d](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/426678d))

## <small>1.6.1 (2026-07-23)</small>

* docs: rewrite container section with prod deploy and dev workflow ([95f77ef](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/95f77ef))

## 1.6.0 (2026-07-23)

* feat: split compose into prod (GHCR pull) and dev (local build) configs ([f65be65](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/f65be65))

## <small>1.5.3 (2026-07-23)</small>

* fix: update .env.example config path reference to ./config/ ([38ecc04](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/38ecc04))

## <small>1.5.2 (2026-07-23)</small>

* fix: use self-contained ./config/ mount for prod compatibility ([f547af9](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/f547af9))

## <small>1.5.1 (2026-07-23)</small>

* fix: improve dashboard text contrast and readability ([19b0913](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/19b0913)), closes [#cbd5e1](https://github.com/slmingol/uptime-kuma-pfsense-sync/issues/cbd5e1) [#f1f5f9](https://github.com/slmingol/uptime-kuma-pfsense-sync/issues/f1f5f9)

## 1.5.0 (2026-07-23)

* feat: add Show all toggle to services panel for full inventory view ([56bc45d](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/56bc45d))

## <small>1.4.1 (2026-07-23)</small>

* docs: document web dashboard panels and HAProxy backend health audit ([3ca25d4](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/3ca25d4))

## 1.4.0 (2026-07-23)

* feat: add HAProxy backend health panel to audit dashboard ([45d556f](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/45d556f))

## <small>1.3.1 (2026-07-23)</small>

* docs: add pf-audit to README usage section ([7b3ee66](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/7b3ee66))

## 1.3.0 (2026-07-23)

* feat: add pf-audit make target for HAProxy backend address audit ([67a815e](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/67a815e))

## 1.2.0 (2026-07-23)

* feat: add uk-add make target and update audit-ignore, README ([3c5455a](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/3c5455a))

## 1.1.0 (2026-07-23)

* feat: add web dashboard with daily scheduled audit ([272ce31](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/272ce31))

## 1.0.0 (2026-07-19)

* fix: upgrade semantic-release-action from v4 to v6 ([4bc9003](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/4bc9003))
* docs: add color SVG terminal output to README ([8f6ef41](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/8f6ef41))
* docs: replace personal hostnames and service names with generic examples ([74910e3](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/74910e3))
* feat: initial release — pfSense ↔ Uptime Kuma audit & reconciliation tool ([f64a8f6](https://github.com/slmingol/uptime-kuma-pfsense-sync/commit/f64a8f6))
