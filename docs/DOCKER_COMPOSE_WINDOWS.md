# Docker Compose no Windows

Algumas instalações do Docker Desktop para Windows não disponibilizam o subcomando `docker compose`, apenas o executável `docker-compose`. Os scripts do Suna detectam automaticamente qual comando está disponível e usam `docker-compose` como fallback quando necessário.

## Como o repositório detecta
- Primeiro tenta `docker compose version`.
- Se falhar, tenta `docker-compose version`.
- Se nenhum funcionar, o script avisa para instalar o Docker Desktop ou o Docker Compose.

## Onde isso é aplicado
- `start.py` e `setup.py` usam o comando detectado para subir/derrubar serviços e gerar instruções.
- Mensagens de ajuda e dicas passam a exibir o comando certo para o seu ambiente.

## Verificação manual
```powershell
docker compose version  # deve funcionar em instalações mais novas
docker-compose version  # fallback disponível no Docker Desktop
```

Se apenas `docker-compose` funcionar, basta rodar os scripts normalmente — eles já farão o fallback.
