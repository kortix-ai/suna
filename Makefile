TESTS := tests
TEST_RUN := cd $(TESTS) && bun run

.DEFAULT_GOAL := help
.PHONY: help install fast all ci-pr ci-main ci-nightly ci-release \
        lint typecheck unit integration api api-coverage contract smoke e2e visual a11y \
        performance security security-dast pentest strix migration infra chaos mutation \
        coverage gates report portal-up portal-down clean

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	 | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install all test dependencies (node deps + Playwright browsers)
	cd $(TESTS) && bun install --frozen-lockfile
	cd $(TESTS) && bunx playwright install --with-deps chromium || true

## ---- one-shot lanes ---------------------------------------------------------
fast: lint typecheck unit contract api-coverage ## Fast local loop: no live services
	@echo "fast suite complete"

all: lint typecheck unit integration api contract smoke e2e visual a11y migration infra security pentest ## Broad suite for a configured local/staging target
	@$(MAKE) gates

## ---- CI cadences ------------------------------------------------------------
ci-pr: ## On every PR
	@$(MAKE) clean
	@$(MAKE) lint typecheck unit integration contract api-coverage gates
ci-main: ## On merge to main (full regression + UI)
	@$(MAKE) clean
	@$(MAKE) e2e visual a11y migration
ci-nightly: ## Scheduled / nightly
	@$(MAKE) clean
	@$(MAKE) security pentest performance security-dast mutation chaos
ci-release: ## Pre-release full gate
	@$(MAKE) clean
	@$(MAKE) lint typecheck unit integration api contract smoke e2e visual a11y migration infra security pentest performance security-dast mutation gates

## ---- per category -----------------------------------------------------------
lint: ## Lint all workspaces (best-effort)
	pnpm -r --if-present lint || true
typecheck: ## TypeScript type-check the test suite
	$(TEST_RUN) typecheck
unit: ## Unit tests (vitest)
	$(TEST_RUN) test:unit:cov
integration: ## Integration tests (vitest + testcontainers)
	$(TEST_RUN) test:integration
api: ## API tests (ke2e REST suite)
	$(TEST_RUN) test:api
api-coverage: ## API route coverage gate (no live target)
	$(TEST_RUN) coverage
contract: ## Consumer-driven contract tests (Pact)
	$(TEST_RUN) test:contract
smoke: ## Smoke / liveness checks
	$(TEST_RUN) test:smoke
e2e: ## End-to-end UI tests (Playwright)
	$(TEST_RUN) test:e2e
visual: ## Visual regression (Playwright snapshots)
	$(TEST_RUN) test:visual
a11y: ## Accessibility tests (axe + Playwright)
	$(TEST_RUN) test:a11y
performance: ## Performance / load (k6, Docker)
	$(TEST_RUN) test:perf
perf-regression: ## Fail if k6 p95/error-rate regressed >10% vs committed baseline
	$(TEST_RUN) test:perf:regression
security: ## Static security scans (SAST/deps/secrets/container)
	$(TEST_RUN) test:security
security-fast: ## Fast static security (SAST/deps/secrets — no app image build)
	$(TEST_RUN) test:security:fast
security-dast: ## Dynamic security scan + API fuzz (needs TARGET_URL)
	$(TEST_RUN) test:security:dast
pentest: ## Enterprise black-box pentest probes (needs PENTEST_TARGET_URL)
	$(TEST_RUN) test:pentest
strix: ## OSS agentic source/pentest scan (needs LLM_API_KEY)
	bash $(TESTS)/security/strix/run.sh
migration: ## Database migration tests (throwaway Postgres)
	$(TEST_RUN) test:migration
infra: ## Infrastructure / IaC tests (tflint/checkov/kubeconform)
	$(TEST_RUN) test:infra
chaos: ## Chaos / resilience (Toxiproxy, Docker)
	$(TEST_RUN) test:chaos
mutation: ## Mutation testing (Stryker)
	$(TEST_RUN) test:mutation

## ---- reporting & gates ------------------------------------------------------
coverage: ## Unit tests with coverage report
	$(TEST_RUN) test:unit:cov
gates: ## Evaluate quality gates over test-results/
	$(TEST_RUN) quality-gates
report: ## Build the Allure report + catalog from latest results
	$(TEST_RUN) allure
	$(TEST_RUN) catalog
publish: ## History-carried Allure report + archive to S3 (set S3_BUCKET; local-only without it)
	bash $(TESTS)/scripts/publish-allure.sh
portal-up: ## Start the local Allure portal (localhost:5051)
	cd $(TESTS)/ui/portal && docker compose up -d
portal-down: ## Stop the local Allure portal
	cd $(TESTS)/ui/portal && docker compose down

clean: ## Remove test artifacts
	rm -rf $(TESTS)/test-results
