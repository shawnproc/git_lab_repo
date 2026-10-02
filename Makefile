# Keystone Ledger — common tasks. Run `make help`.
SHELL := /bin/bash
.DEFAULT_GOAL := help

BACKEND := backend
FRONTEND := frontend
UV := uv --directory $(BACKEND)
NPM := npm --prefix $(FRONTEND)

.PHONY: help install run dev build check lint typecheck test audit fmt clean verify-links

help: ## Show targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

install: ## Install pinned backend + frontend deps (from lockfiles)
	$(UV) sync --frozen
	$(NPM) ci --no-fund

build: ## Build the frontend into frontend/dist (served by the backend)
	$(NPM) run build

run: build ## Build UI and start the app on http://127.0.0.1:8787
	$(UV) run --frozen python -m keystone_ledger.serve

dev: ## Backend on :8787 + Vite dev server on :5173 (hot reload)
	@trap 'kill 0' EXIT; \
	KL_DEV_ORIGINS='["http://127.0.0.1:5173"]' $(UV) run --frozen python -m keystone_ledger.serve & \
	$(NPM) run dev

verify-links: ## Check every Learn link and stamp the ones that open
	$(UV) run --frozen python -m keystone_ledger.tools.verify_links

fmt: ## Auto-format
	$(UV) run --frozen ruff format .
	$(UV) run --frozen ruff check --fix .

lint: ## ruff + eslint
	$(UV) run --frozen ruff format --check .
	$(UV) run --frozen ruff check .
	$(NPM) run -s lint

typecheck: ## mypy (strict) + tsc
	$(UV) run --frozen mypy src tests
	$(NPM) run -s typecheck

test: ## pytest + vitest
	$(UV) run --frozen pytest
	$(NPM) run -s test

audit: ## pip-audit (hash-pinned lock export) + npm audit
	@tmp=$$(mktemp); trap 'rm -f $$tmp' EXIT; \
	$(UV) export --frozen --no-emit-project --format requirements-txt -q -o $$tmp && \
	$(UV) run --frozen pip-audit --progress-spinner off --strict --require-hashes --disable-pip -r $$tmp
	$(NPM) audit --audit-level=low

check: lint typecheck test audit ## Everything CI would run
	@echo "✅ make check passed"

clean: ## Remove build outputs (keeps var/ data)
	rm -rf $(FRONTEND)/dist $(BACKEND)/.mypy_cache $(BACKEND)/.ruff_cache $(BACKEND)/.pytest_cache
