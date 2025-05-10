.PHONY: setup up down migrate fmt

setup:  ## one-time env + DB prep
	cp -n backend/.env.template backend/.env || true
	cp -n frontend/.env.local.template frontend/.env.local || true
	./scripts/supa_migrate.sh

up:     ## run stack
	docker compose -f docker-compose.local.yaml up --build

down:   ## stop & clean
	docker compose -f docker-compose.local.yaml down -v

migrate: ## rerun Supabase migration
	./scripts/supa_migrate.sh

fmt:    ## auto-format backend python
	black backend 