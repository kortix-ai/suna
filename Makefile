TESTS := tests
NPM := npm --prefix $(TESTS)

.DEFAULT_GOAL := help
.PHONY: help install fast all ci-pr ci-main ci-nightly ci-release \
        lint typecheck unit integration api contract smoke e2e visual a11y \
        performance security security-dast migration infra chaos mutation \
        coverage gates report portal-up portal-down clean

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	 | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install all test dependencies (node deps + Playwright browsers)
	$(NPM) install
	cd $(TESTS) && npx playwright install --with-deps chromium || true

## ---- one-shot lanes ---------------------------------------------------------
fast: lint typecheck unit smoke ## Fast local loop: lint + typecheck + unit + smoke
	@echo "fast suite complete"

all: lint typecheck unit integration api contract smoke e2e visual a11y migration infra security ## Everything runnable without a cloud target
	@$(MAKE) gates

## ---- CI cadences ------------------------------------------------------------
ci-pr: lint typecheck unit integration api contract security gates ## On every PR
ci-main: e2e visual a11y migration ## On merge to main (full regression + UI)
ci-nightly: performance security-dast mutation chaos ## Scheduled / nightly
ci-release: all e2e visual a11y performance security security-dast gates ## Pre-release full gate

## ---- per category -----------------------------------------------------------
lint: ## Lint all workspaces (best-effort)
	pnpm -r --if-present lint || true
typecheck: ## TypeScript type-check the test suite
	$(NPM) run typecheck
unit: ## Unit tests (vitest)
	$(NPM) run test:unit:cov
integration: ## Integration tests (vitest + testcontainers)
	$(NPM) run test:integration
api: ## API tests (ke2e REST suite)
	$(NPM) run test:api
contract: ## Consumer-driven contract tests (Pact)
	$(NPM) run test:contract
smoke: ## Smoke / liveness checks
	$(NPM) run test:smoke
e2e: ## End-to-end UI tests (Playwright)
	$(NPM) run test:e2e
visual: ## Visual regression (Playwright snapshots)
	$(NPM) run test:visual
a11y: ## Accessibility tests (axe + Playwright)
	$(NPM) run test:a11y
performance: ## Performance / load (k6, Docker)
	$(NPM) run test:perf
security: ## Static security scans (SAST/deps/secrets/container)
	$(NPM) run test:security
security-dast: ## Dynamic security scan + API fuzz (needs TARGET_URL)
	$(NPM) run test:security:dast
migration: ## Database migration tests (throwaway Postgres)
	$(NPM) run test:migration
infra: ## Infrastructure / IaC tests (tflint/checkov/kubeconform)
	$(NPM) run test:infra
chaos: ## Chaos / resilience (Toxiproxy, Docker)
	$(NPM) run test:chaos
mutation: ## Mutation testing (Stryker)
	$(NPM) run test:mutation

## ---- reporting & gates ------------------------------------------------------
coverage: ## Unit tests with coverage report
	$(NPM) run test:unit:cov
gates: ## Evaluate quality gates over test-results/
	$(NPM) run quality-gates
report: ## Build the Allure report + catalog from latest results
	$(NPM) run allure
	$(NPM) run catalog
publish: ## History-carried Allure report + archive to S3 (set S3_BUCKET; local-only without it)
	bash $(TESTS)/scripts/publish-allure.sh
portal-up: ## Start the local Allure portal (localhost:5051)
	cd $(TESTS)/ui/portal && docker compose up -d
portal-down: ## Stop the local Allure portal
	cd $(TESTS)/ui/portal && docker compose down

clean: ## Remove test artifacts
	rm -rf $(TESTS)/test-results
