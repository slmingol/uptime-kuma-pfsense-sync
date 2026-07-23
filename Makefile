export NODE_NO_WARNINGS = 1

# Sibling project paths (override if your layout differs)
PFSENSE_CLI ?= ../pfsense-cli
UK_SYNC     ?= ../uptime-kuma-sync-n-bak

# Uptime Kuma instance name (from uptime-kuma-config.json)
INSTANCE ?= primary

# Optional filter string for listing targets
FILTER ?=

# Container engine — prefers podman, falls back to docker
CONTAINER_ENGINE ?= $(shell which podman 2>/dev/null || which docker 2>/dev/null)
COMPOSE          ?= $(CONTAINER_ENGINE) compose
IMAGE            ?= uptime-kuma-pfsense-sync

.PHONY: audit survey pf-backends pf-dns uk-monitors uk-monitors-tldr uk-backup uk-diff install clean \
        server docker-build docker-up docker-down docker-logs docker-restart docker-audit docker-survey help
.DEFAULT_GOAL := help

# ─── Help ─────────────────────────────────────────────────────────────────────

help: ## Show this help message
	@printf "\n"
	@printf "\033[1;37muptime-kuma-pfsense-sync\033[0m\n"
	@printf "\033[90mpfSense HAProxy/DNS \033[0m\033[36m↔\033[0m\033[90m Uptime Kuma reconciliation & survey tool\033[0m\n"
	@printf "\n"
	@awk 'BEGIN {FS = ":.*?## "} \
	  /^##@/ { printf "\n\033[1;33m%s\033[0m\n", substr($$0, 5) } \
	  /^[a-zA-Z_-]+:.*?## / { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' \
	  $(MAKEFILE_LIST)
	@printf "\n"
	@printf "\033[1mExamples:\033[0m\n"
	@printf "  \033[32mmake audit\033[0m                        \033[90m# gap report — what's in pfSense but missing from Uptime Kuma\033[0m\n"
	@printf "  \033[32mmake survey\033[0m                       \033[90m# full inventory with match status for every service\033[0m\n"
	@printf "  \033[32mmake audit\033[0m    \033[33mINSTANCE=secondary\033[0m  \033[90m# audit against the secondary Uptime Kuma instance\033[0m\n"
	@printf "\n"
	@printf "  \033[32mmake pf-backends\033[0m                  \033[90m# list all HAProxy backends in pfSense\033[0m\n"
	@printf "  \033[32mmake pf-backends\033[0m  \033[33mFILTER=jellyfin\033[0m   \033[90m# filter backend listing\033[0m\n"
	@printf "  \033[32mmake pf-dns\033[0m                       \033[90m# list all DNS host overrides\033[0m\n"
	@printf "\n"
	@printf "  \033[32mmake uk-monitors\033[0m                  \033[90m# list Uptime Kuma monitors grouped by group\033[0m\n"
	@printf "  \033[32mmake uk-monitors\033[0m  \033[33mINSTANCE=secondary\033[0m  \033[90m# list monitors on secondary instance\033[0m\n"
	@printf "  \033[32mmake uk-monitors-tldr\033[0m             \033[90m# summary counts by group and type\033[0m\n"
	@printf "  \033[32mmake uk-backup\033[0m                    \033[90m# backup primary monitors to JSON\033[0m\n"
	@printf "  \033[32mmake uk-diff\033[0m                      \033[90m# field-level diff: primary vs secondary\033[0m\n"
	@printf "\n"
	@printf "  \033[32mmake server\033[0m                       \033[90m# run the web dashboard locally (port 3000)\033[0m\n"
	@printf "  \033[32mmake docker-up\033[0m                    \033[90m# start the web dashboard in Docker (port 3210)\033[0m\n"
	@printf "  \033[32mmake docker-logs\033[0m                  \033[90m# tail the container logs\033[0m\n"
	@printf "  \033[32mmake docker-restart\033[0m               \033[90m# rebuild and restart the container\033[0m\n"
	@printf "\n"
	@printf "  \033[90mINSTANCE choices: primary | secondary | local-dev  (from uptime-kuma-config.json)\033[0m\n"
	@printf "\n"

##@ Reconciliation

audit: ## Gap report — pfSense services not tracked in Uptime Kuma [INSTANCE=primary]
	@UPTIME_KUMA_INSTANCE=$(INSTANCE) node audit.js

survey: ## Full inventory — all pfSense services with monitor match status [INSTANCE=primary]
	@UPTIME_KUMA_INSTANCE=$(INSTANCE) node audit.js --verbose

server: ## Run the web dashboard locally (port 3000) [INSTANCE=primary]
	@UPTIME_KUMA_INSTANCE=$(INSTANCE) node server.js

##@ pfSense Survey

pf-backends: ## List all HAProxy backends [FILTER=]
	@cd $(PFSENSE_CLI) && node cli.js haproxy:list $(if $(FILTER),--filter "$(FILTER)") 2>/dev/null

pf-dns: ## List all DNS host overrides [FILTER=]
	@cd $(PFSENSE_CLI) && node cli.js list $(if $(FILTER),--filter "$(FILTER)") 2>/dev/null

##@ Uptime Kuma Survey

uk-monitors: ## List monitors grouped by group [INSTANCE=primary]
	@cd $(UK_SYNC) && node src/uptime-kuma-list.js $(INSTANCE) 2>/dev/null

uk-monitors-tldr: ## Summary count of monitors by group and type [INSTANCE=primary]
	@cd $(UK_SYNC) && node src/uptime-kuma-list.js $(INSTANCE) --tldr 2>/dev/null

uk-backup: ## Backup Uptime Kuma monitors to JSON [INSTANCE=primary]
	@cd $(UK_SYNC) && node src/uptime-kuma-backup.js $(INSTANCE) 2>/dev/null

uk-diff: ## Field-level diff between primary and secondary instances
	@cd $(UK_SYNC) && node src/uptime-kuma-diff.js 2>/dev/null

##@ Container

docker-build: ## Build the container image
	$(COMPOSE) build

docker-up: ## Start the audit web dashboard in the background [AUDIT_PORT=3210]
	$(COMPOSE) up -d
	@printf "\033[32m✓\033[0m Dashboard: \033[36mhttp://localhost:$${AUDIT_PORT:-3210}\033[0m\n"

docker-down: ## Stop the audit web dashboard
	$(COMPOSE) down

docker-logs: ## Tail container logs
	$(COMPOSE) logs -f

docker-restart: ## Rebuild image and restart the container
	$(COMPOSE) down
	$(COMPOSE) build
	$(COMPOSE) up -d
	@printf "\033[32m✓\033[0m Dashboard: \033[36mhttp://localhost:$${AUDIT_PORT:-3210}\033[0m\n"

docker-audit: ## Run a one-shot CLI audit inside the container [INSTANCE=primary]
	@$(COMPOSE) run --rm \
	  -e UPTIME_KUMA_INSTANCE=$(INSTANCE) \
	  --entrypoint node audit audit.js 2>/dev/null

docker-survey: ## Run a one-shot CLI survey inside the container [INSTANCE=primary]
	@$(COMPOSE) run --rm \
	  -e UPTIME_KUMA_INSTANCE=$(INSTANCE) \
	  --entrypoint node audit audit.js --verbose 2>/dev/null

##@ Infrastructure

install: ## Install npm dependencies
	@npm install

clean: ## Remove node_modules
	@rm -rf node_modules
	@printf "\033[90mnode_modules removed\033[0m\n"
