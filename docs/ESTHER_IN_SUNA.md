# Demo da Esther no sandbox do Suna (Daytona)

Passo a passo para rodar o agente Esther diretamente no sandbox do Suna (via chat).

## 1) No chat do Suna
Peça para o agente executar comandos em sandbox e cole o bloco abaixo:

```bash
cat > task.json <<'EOF'
{"project":"Esther Orbiter","goal":"Demo run via Suna sandbox","params":{"mode":"status_report","lang":"pt-PT"}}
EOF
git clone https://github.com/19721102/esther-orbiter.git
cd esther-orbiter
bash scripts/kortix_agent_bootstrap.sh ../task.json
cat out_kortix/result.json
ls -la out_kortix
```

> Antes de rebuildar o frontend local, copie `frontend/.env.example` para `frontend/.env.local` e rode `docker-compose up -d --build`.

## 2) Artefatos esperados
- `out_kortix/result.json`
- `out_kortix/report.txt`
- `out_kortix/run.log`

Esses arquivos são gerados pelo bootstrap e contêm o resultado, relatório e log do run.
