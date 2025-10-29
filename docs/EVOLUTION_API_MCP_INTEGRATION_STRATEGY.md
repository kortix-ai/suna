# Estratégia de Integração Evolution API via MCP

## 📋 Contexto

O sistema Suna já possui:
- ✅ Integração WhatsApp Business oficial (via Composio)
- ✅ Integração Supabase (via Composio)
- ✅ Sistema MCP (Model Context Protocol) nativo
- ✅ 200+ integrações via Composio

**Objetivo:** Adicionar Evolution API como uma integração alternativa ao WhatsApp Business oficial, seguindo o mesmo padrão de integrações do sistema.

---

## 🏗️ Arquitetura do Sistema de Integrações

### Como Integrações Aparecem no "Browse Apps"

```
┌─────────────────────────────────────────────────────────┐
│  Frontend: "Browse Apps"                                │
│  └─ Lista dinâmica de integrações disponíveis          │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  Backend: composio_integration/toolkit_service.py      │
│  └─ Lista toolkits via API do Composio                 │
│     • Filtra apenas OAUTH2                             │
│     • Retorna: nome, descrição, logo, auth_schemes     │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  Composio API                                           │
│  └─ Gerencia 200+ integrações                          │
│     • WhatsApp Business                                │
│     • Supabase                                         │
│     • Gmail, Slack, etc.                               │
└─────────────────────────────────────────────────────────┘
```

### Como MCP Customizado Funciona

```
┌─────────────────────────────────────────────────────────┐
│  Backend: mcp_module/mcp_service.py                     │
│  └─ Gerencia conexões com MCP Servers                  │
│     • Custom MCP servers                               │
│     • Composio MCP servers                             │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  MCP Server (HTTP/SSE)                                  │
│  └─ Expõe ferramentas via protocolo MCP                │
│     • list_tools() - Lista ferramentas disponíveis     │
│     • call_tool() - Executa ferramenta                 │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  Evolution API                                          │
│  └─ API REST para WhatsApp                             │
└─────────────────────────────────────────────────────────┘
```

---

## 🎯 Duas Opções de Implementação

### Opção 1: Registrar no Composio (❌ Não Recomendado)

**Como funciona:**
- Submeter Evolution API como toolkit oficial no Composio
- Apareceria automaticamente em "Browse Apps"
- Composio gerenciaria OAuth, webhooks, etc.

**Desvantagens:**
- ❌ Requer aprovação do Composio (processo longo)
- ❌ Sem controle sobre a implementação
- ❌ Dependente de roadmap do Composio
- ❌ Evolution API não é oficial (pode não ser aceita)

---

### Opção 2: MCP Server Customizado (✅ RECOMENDADO)

**Como funciona:**
- Criar um MCP server HTTP próprio
- Implementar protocolo MCP (Python SDK oficial)
- Expor ferramentas de Evolution API
- Conectar via `mcp_module/mcp_service.py`

**Vantagens:**
- ✅ Controle total sobre implementação
- ✅ Sem dependência de aprovações externas
- ✅ Rápido de implementar
- ✅ Totalmente customizável
- ✅ Segue padrão do sistema

**Referências no código:**
- `/backend/core/mcp_module/mcp_service.py` - Cliente MCP
- `/backend/core/tools/mcp_tool_wrapper.py` - Wrapper de ferramentas MCP
- `/backend/core/composio_integration/mcp_server_service.py` - Gestão de MCP servers

---

## 📦 Implementação: MCP Server Evolution API

### Fase 1: Criar MCP Server

**Arquivo:** `backend/evolution_mcp_server/server.py`

```python
"""
Evolution API MCP Server

Expõe ferramentas de Evolution API via Model Context Protocol
"""

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp import types
import httpx
from typing import Any, Dict

# Cliente Evolution API
class EvolutionAPIClient:
    def __init__(self, api_url: str, api_key: str):
        self.api_url = api_url
        self.api_key = api_key
        self.headers = {"apikey": api_key}

    async def send_text(self, instance: str, phone: str, text: str):
        """Envia mensagem de texto via Evolution API"""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.api_url}/message/sendText/{instance}",
                headers=self.headers,
                json={"number": phone, "text": text}
            )
            return response.json()

    async def send_media(self, instance: str, phone: str, media_url: str, caption: str = ""):
        """Envia mídia via Evolution API"""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.api_url}/message/sendMedia/{instance}",
                headers=self.headers,
                json={
                    "number": phone,
                    "mediaUrl": media_url,
                    "caption": caption
                }
            )
            return response.json()

# MCP Server
app = Server("evolution-api")

@app.list_tools()
async def list_tools() -> list[types.Tool]:
    """Lista ferramentas disponíveis"""
    return [
        types.Tool(
            name="evolution_send_text",
            description="Envia mensagem de texto via WhatsApp usando Evolution API",
            inputSchema={
                "type": "object",
                "properties": {
                    "instance": {
                        "type": "string",
                        "description": "Nome da instância Evolution API"
                    },
                    "phone": {
                        "type": "string",
                        "description": "Número de telefone com DDI (ex: 5511999999999)"
                    },
                    "text": {
                        "type": "string",
                        "description": "Texto da mensagem"
                    }
                },
                "required": ["instance", "phone", "text"]
            }
        ),
        types.Tool(
            name="evolution_send_media",
            description="Envia mídia (imagem, vídeo, áudio, documento) via WhatsApp",
            inputSchema={
                "type": "object",
                "properties": {
                    "instance": {"type": "string"},
                    "phone": {"type": "string"},
                    "media_url": {"type": "string", "description": "URL pública da mídia"},
                    "caption": {"type": "string", "description": "Legenda (opcional)"}
                },
                "required": ["instance", "phone", "media_url"]
            }
        )
    ]

@app.call_tool()
async def call_tool(name: str, arguments: Dict[str, Any]) -> list[types.TextContent]:
    """Executa ferramenta"""

    # Obter credenciais do ambiente ou config
    api_url = os.getenv("EVOLUTION_API_URL")
    api_key = os.getenv("EVOLUTION_API_KEY")

    client = EvolutionAPIClient(api_url, api_key)

    if name == "evolution_send_text":
        result = await client.send_text(
            arguments["instance"],
            arguments["phone"],
            arguments["text"]
        )
        return [types.TextContent(
            type="text",
            text=f"Mensagem enviada com sucesso: {result}"
        )]

    elif name == "evolution_send_media":
        result = await client.send_media(
            arguments["instance"],
            arguments["phone"],
            arguments["media_url"],
            arguments.get("caption", "")
        )
        return [types.TextContent(
            type="text",
            text=f"Mídia enviada com sucesso: {result}"
        )]

    raise ValueError(f"Tool desconhecida: {name}")

# Executar servidor
if __name__ == "__main__":
    import asyncio
    asyncio.run(stdio_server(app))
```

---

### Fase 2: Registrar MCP Server no Sistema

**Arquivo:** `backend/core/evolution_api/integration.py`

```python
"""
Integração do MCP Server Evolution API com o sistema Suna
"""

from core.mcp_module.mcp_service import MCPService
from core.utils.logger import logger

async def register_evolution_mcp(account_id: str, config: dict):
    """
    Registra Evolution API MCP Server para uma conta

    Args:
        account_id: ID da conta Suna
        config: {
            "api_url": "https://evolution-api.example.com",
            "api_key": "sua-chave-api",
            "instance_name": "nome-da-instancia"
        }
    """

    mcp_service = MCPService()

    # Configuração do MCP
    mcp_config = {
        "qualifiedName": f"evolution-api-{account_id}",
        "name": "Evolution API WhatsApp",
        "type": "custom",
        "config": {
            "url": "http://localhost:8001/mcp",  # URL do MCP server
            "api_url": config["api_url"],
            "api_key": config["api_key"],
            "instance_name": config["instance_name"]
        },
        "enabledTools": [
            "evolution_send_text",
            "evolution_send_media"
        ],
        "provider": "custom"
    }

    try:
        connection = await mcp_service.connect_server(mcp_config)
        logger.info(f"Evolution API MCP conectado: {connection.qualified_name}")
        return connection
    except Exception as e:
        logger.error(f"Erro ao conectar Evolution API MCP: {e}")
        raise
```

---

### Fase 3: API Endpoints para Configuração

**Arquivo:** `backend/core/evolution_api/api.py`

```python
"""
API endpoints para gerenciar integração Evolution API
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.services.supabase import DBConnection
from .integration import register_evolution_mcp

router = APIRouter(prefix="/evolution-api", tags=["evolution-api"])

class EvolutionAPIConfig(BaseModel):
    api_url: str
    api_key: str
    instance_name: str
    agent_id: str = None

@router.post("/configure")
async def configure_evolution_api(
    config: EvolutionAPIConfig,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    db: DBConnection = Depends()
):
    """
    Configura integração Evolution API para a conta do usuário
    """

    try:
        # Salvar config no banco
        client = await db.client
        result = await client.table("evolution_api_configs").insert({
            "account_id": user_id,
            "api_url": config.api_url,
            "api_key": config.api_key,  # Criptografar!
            "instance_name": config.instance_name,
            "agent_id": config.agent_id
        }).execute()

        # Registrar MCP
        connection = await register_evolution_mcp(user_id, {
            "api_url": config.api_url,
            "api_key": config.api_key,
            "instance_name": config.instance_name
        })

        return {
            "success": True,
            "message": "Evolution API configurada com sucesso",
            "config_id": result.data[0]["id"]
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/configs")
async def list_configs(
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    db: DBConnection = Depends()
):
    """
    Lista configurações de Evolution API da conta
    """
    client = await db.client
    result = await client.table("evolution_api_configs")\
        .select("*")\
        .eq("account_id", user_id)\
        .execute()

    return {"configs": result.data}
```

---

### Fase 4: Migration do Banco de Dados

**Arquivo:** `backend/supabase/migrations/20250129_evolution_api_configs.sql`

```sql
-- Tabela para armazenar configurações de Evolution API
CREATE TABLE evolution_api_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    api_url TEXT NOT NULL,
    api_key TEXT NOT NULL,  -- Criptografado
    instance_name TEXT NOT NULL,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(account_id, instance_name)
);

-- Índices
CREATE INDEX idx_evolution_configs_account ON evolution_api_configs(account_id);
CREATE INDEX idx_evolution_configs_agent ON evolution_api_configs(agent_id);

-- RLS (Row Level Security)
ALTER TABLE evolution_api_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own Evolution configs"
    ON evolution_api_configs
    FOR ALL
    USING (account_id = auth.uid());

-- Trigger para updated_at
CREATE TRIGGER update_evolution_configs_updated_at
    BEFORE UPDATE ON evolution_api_configs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

---

### Fase 5: Webhooks Evolution API

**Arquivo:** `backend/core/evolution_api/webhooks.py`

```python
"""
Handler de webhooks da Evolution API
"""

from fastapi import APIRouter, Request, HTTPException
from core.services.supabase import DBConnection
from core.threads import create_or_get_thread
from core.agent_runs import trigger_agent_run
import hmac
import hashlib

router = APIRouter(prefix="/webhooks/evolution", tags=["webhooks"])

def verify_webhook_signature(payload: bytes, signature: str, secret: str) -> bool:
    """Verifica assinatura do webhook"""
    expected = hmac.new(
        secret.encode(),
        payload,
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)

@router.post("/messages/{instance_name}")
async def handle_message_webhook(
    instance_name: str,
    request: Request,
    db: DBConnection = Depends()
):
    """
    Recebe webhooks de mensagens da Evolution API

    Eventos suportados:
    - MESSAGES_UPSERT: Nova mensagem recebida
    - MESSAGES_UPDATE: Mensagem atualizada
    """

    # Verificar assinatura
    signature = request.headers.get("x-evolution-signature")
    body = await request.body()

    # TODO: Buscar webhook_secret do config
    # if not verify_webhook_signature(body, signature, webhook_secret):
    #     raise HTTPException(status_code=401, detail="Invalid signature")

    data = await request.json()
    event = data.get("event")

    if event == "MESSAGES_UPSERT":
        # Nova mensagem recebida
        message = data.get("data", {}).get("message", {})

        # Extrair informações
        phone = message.get("key", {}).get("remoteJid", "").replace("@s.whatsapp.net", "")
        text = message.get("message", {}).get("conversation") or \
               message.get("message", {}).get("extendedTextMessage", {}).get("text")

        if not text:
            return {"status": "ignored", "reason": "No text content"}

        # Buscar config e agent
        client = await db.client
        config = await client.table("evolution_api_configs")\
            .select("*, agents(*)")\
            .eq("instance_name", instance_name)\
            .eq("is_active", True)\
            .single()\
            .execute()

        if not config.data:
            return {"status": "ignored", "reason": "Instance not configured"}

        agent = config.data.get("agents")
        if not agent:
            return {"status": "ignored", "reason": "No agent configured"}

        # Criar ou recuperar thread (um por número de telefone)
        thread = await create_or_get_thread(
            account_id=config.data["account_id"],
            external_id=f"whatsapp_{phone}",
            metadata={
                "channel": "whatsapp",
                "phone": phone,
                "instance": instance_name
            }
        )

        # Disparar execução do agente
        await trigger_agent_run(
            agent_id=agent["id"],
            thread_id=thread["id"],
            input_text=text,
            metadata={
                "source": "evolution_webhook",
                "phone": phone,
                "message_id": message.get("key", {}).get("id")
            }
        )

        return {"status": "success", "thread_id": thread["id"]}

    return {"status": "ignored", "reason": f"Unsupported event: {event}"}
```

---

### Fase 6: Frontend - Configuração UI

**Arquivo:** `apps/web/app/agents/[agent_id]/integrations/evolution-api/page.tsx`

```typescript
/**
 * Página de configuração Evolution API
 */

export default function EvolutionAPIConfigPage() {
  const [config, setConfig] = useState({
    api_url: '',
    api_key: '',
    instance_name: '',
  })

  const handleSave = async () => {
    const response = await fetch('/api/evolution-api/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    })

    if (response.ok) {
      toast.success('Evolution API configurada com sucesso!')
    }
  }

  return (
    <div className="space-y-6">
      <h2>Configurar Evolution API</h2>

      <div>
        <label>URL da API</label>
        <input
          type="url"
          value={config.api_url}
          onChange={(e) => setConfig({...config, api_url: e.target.value})}
          placeholder="https://evolution-api.example.com"
        />
      </div>

      <div>
        <label>API Key</label>
        <input
          type="password"
          value={config.api_key}
          onChange={(e) => setConfig({...config, api_key: e.target.value})}
        />
      </div>

      <div>
        <label>Nome da Instância</label>
        <input
          type="text"
          value={config.instance_name}
          onChange={(e) => setConfig({...config, instance_name: e.target.value})}
        />
      </div>

      <button onClick={handleSave}>Salvar Configuração</button>
    </div>
  )
}
```

---

## 📚 Referências de Código Existente

### Para entender MCP:
- `/backend/core/mcp_module/mcp_service.py` - Cliente MCP
- `/backend/core/tools/mcp_tool_wrapper.py` - Como ferramentas MCP são expostas

### Para entender Composio:
- `/backend/core/composio_integration/toolkit_service.py` - Como toolkits são listados
- `/backend/core/composio_integration/mcp_server_service.py` - Gestão de MCP servers

### Para entender Webhooks:
- `/backend/core/composio_integration/api.py` - Verificação de webhooks (linha 42-77)
- `/backend/core/triggers/` - Sistema de triggers existente

### Para entender Threads:
- `/backend/core/threads.py` - Gestão de threads de conversa

---

## 🎯 Checklist de Implementação

### Backend
- [ ] Criar MCP Server Evolution API (`evolution_mcp_server/server.py`)
- [ ] Implementar cliente Evolution API com todas as funções
- [ ] Criar endpoints de configuração (`evolution_api/api.py`)
- [ ] Migration do banco de dados (`evolution_api_configs` table)
- [ ] Handler de webhooks (`evolution_api/webhooks.py`)
- [ ] Integração com sistema de threads
- [ ] Criptografia de API keys
- [ ] Testes unitários
- [ ] Testes de integração

### Frontend
- [ ] Página de configuração Evolution API
- [ ] Interface para conectar/desconectar
- [ ] Visualização de instâncias conectadas
- [ ] Status de conexão em tempo real
- [ ] Logs de mensagens enviadas/recebidas

### Infraestrutura
- [ ] Deploy do MCP Server
- [ ] Configurar webhooks na Evolution API
- [ ] Monitoramento de conexões
- [ ] Rate limiting
- [ ] Documentação de uso

---

## 🔐 Segurança

1. **Criptografia de Credenciais**
   - Usar `EncryptionService` para API keys
   - Armazenar encrypted no banco
   - Descriptografar apenas em memória

2. **Validação de Webhooks**
   - HMAC signature verification
   - Timestamp validation
   - IP whitelist (opcional)

3. **Rate Limiting**
   - Limitar chamadas à Evolution API
   - Throttling de webhooks
   - Circuit breaker pattern

---

## 📊 Monitoramento

### Métricas a Coletar:
- Mensagens enviadas/recebidas
- Taxa de erro de envio
- Latência média
- Webhooks recebidos
- Threads ativos

### Logs Importantes:
- Tentativas de conexão MCP
- Erros de autenticação
- Timeouts de API
- Webhooks rejeitados

---

## 🚀 Deploy

### Desenvolvimento Local:
```bash
# Backend
cd backend
uv run python evolution_mcp_server/server.py

# Frontend
cd apps/web
npm run dev
```

### Produção:
```bash
# MCP Server como serviço
systemctl start evolution-mcp-server

# Configurar webhook na Evolution API
curl -X POST https://evolution-api.example.com/webhook/set \
  -H "apikey: YOUR_KEY" \
  -d '{
    "url": "https://suna.example.com/webhooks/evolution/messages/instance-name",
    "events": ["MESSAGES_UPSERT", "MESSAGES_UPDATE"]
  }'
```

---

## 📝 Documentação para Usuários

Criar guia em `/docs/USER_GUIDE_EVOLUTION_API.md`:

1. Como criar conta Evolution API
2. Como obter API key
3. Como configurar instância
4. Como conectar ao agente
5. Como testar envio de mensagens
6. Troubleshooting comum

---

## ✅ Conclusão

Esta abordagem:
- ✅ Segue o padrão do sistema (MCP)
- ✅ Mantém separação de concerns
- ✅ Reutiliza infraestrutura existente
- ✅ Permite coexistência com WhatsApp Business oficial
- ✅ É escalável e manutenível

O Kiro deve focar em implementar um MCP Server robusto que expõe as ferramentas de Evolution API de forma padronizada, seguindo os exemplos do código existente.
