# Guia de Integração Nativa: Evolution API no Padrão Suna

## 📋 Objetivo

Adaptar a integração Evolution API para se comportar **exatamente** como as outras integrações nativas do sistema (WhatsApp Business, Supabase, Gmail, etc.), seguindo todos os padrões visuais e funcionais existentes.

---

## 🎨 Parte 1: Metadados das Ferramentas (Backend)

### 1.1 Estrutura de @tool_metadata

Todas as ferramentas do sistema seguem este padrão:

```python
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata

@tool_metadata(
    display_name="Nome Amigável",           # Exibido na UI
    description="Descrição curta e clara",  # Tooltip e listagem
    icon="IconName",                        # Nome do ícone Lucide React
    color="bg-{cor}-100 dark:bg-{cor}-800/50",  # Classes Tailwind
    weight=30,                              # Ordem (menor = mais prioritário)
    visible=True                            # Se aparece na UI frontend
)
class MinhaFerramenta(Tool):
    ...
```

### 1.2 Padrão de Cores e Ícones

#### Cores Disponíveis (padrão Tailwind):
```python
# Comunicação
"bg-purple-100 dark:bg-purple-800/50"  # Chat, Messages
"bg-blue-100 dark:bg-blue-800/50"      # Email, Social

# Produtividade
"bg-green-100 dark:bg-green-800/50"    # Web Search, Browser
"bg-yellow-100 dark:bg-yellow-800/50"  # Knowledge Base

# Técnico
"bg-cyan-100 dark:bg-cyan-800/50"      # Browser, API
"bg-gray-100 dark:bg-gray-800/50"      # Interno, MCP

# Dados
"bg-orange-100 dark:bg-orange-800/50"  # Analytics
"bg-red-100 dark:bg-red-800/50"        # Alerts

# Especial
"bg-indigo-100 dark:bg-indigo-800/50"  # AI, Smart features
```

#### Ícones (Lucide React):
Buscar em: https://lucide.dev/icons/

Exemplos usados no sistema:
- `MessageSquare` - Chat/Messages
- `Search` - Web Search
- `Globe` - Browser
- `Brain` - Knowledge Base
- `Package` - MCP/Integrations
- `Zap` - Automation
- `Database` - Database tools
- `Phone` - Telefonia
- `Send` - Envio de mensagens

**Para Evolution API, sugestões:**
- `MessageCircle` - WhatsApp messaging
- `Phone` - Chamadas/contatos
- `Send` - Envio de mensagens
- `Smartphone` - Mobile/WhatsApp

### 1.3 Weight (Prioridade)

Sistema atual de pesos:
```python
0-50    = Core tools (Chat, Messages)
51-100  = Productivity (Web Search, Browser)
101-200 = Knowledge & Data
201-500 = External integrations
501+    = Experimental/Internal
1000+   = Hidden/Internal only
```

**Para Evolution API:**
```python
weight=250  # Entre outras integrações externas
```

### 1.4 Schema OpenAPI

```python
@openapi_schema({
    "type": "function",
    "function": {
        "name": "nome_da_funcao",  # snake_case
        "description": "Descrição detalhada do que faz, quando usar, e exemplos práticos",
        "parameters": {
            "type": "object",
            "properties": {
                "param1": {
                    "type": "string",
                    "description": "Descrição clara do parâmetro"
                },
                "param2": {
                    "type": "integer",
                    "description": "Outro parâmetro",
                    "default": 10
                }
            },
            "required": ["param1"]
        }
    }
})
async def nome_da_funcao(self, param1: str, param2: int = 10) -> ToolResult:
    """Docstring Python (não é exibida na UI)"""
    try:
        # Implementação
        return self.success_response({"resultado": "..."})
    except Exception as e:
        return self.fail_response(f"Erro: {str(e)}")
```

---

## 🎨 Parte 2: Ferramentas Evolution API

### 2.1 Ferramenta: Enviar Mensagem de Texto

```python
@tool_metadata(
    display_name="WhatsApp (Evolution API)",
    description="Send WhatsApp messages using Evolution API - alternative to official WhatsApp Business",
    icon="MessageCircle",
    color="bg-green-100 dark:bg-green-800/50",
    weight=250,
    visible=True
)
class EvolutionWhatsAppTool(Tool):
    """Tool for sending WhatsApp messages via Evolution API"""

    def __init__(self, instance_config: dict):
        super().__init__()
        self.api_url = instance_config["api_url"]
        self.api_key = instance_config["api_key"]
        self.instance_name = instance_config["instance_name"]

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "send_whatsapp_text",
            "description": "Send a text message via WhatsApp using Evolution API. Use this to send text-only messages to WhatsApp numbers. For media (images, videos, documents), use send_whatsapp_media instead. The recipient must have WhatsApp installed and the number must be in international format (e.g., 5511999999999 for Brazil).",
            "parameters": {
                "type": "object",
                "properties": {
                    "phone": {
                        "type": "string",
                        "description": "WhatsApp phone number in international format without '+' symbol. Example: 5511999999999 (Brazil), 14155551234 (USA)"
                    },
                    "message": {
                        "type": "string",
                        "description": "Text message to send. Supports WhatsApp formatting: *bold*, _italic_, ~strikethrough~, ```monospace```"
                    }
                },
                "required": ["phone", "message"]
            }
        }
    })
    async def send_whatsapp_text(self, phone: str, message: str) -> ToolResult:
        """Send text message via WhatsApp"""
        try:
            # Validação
            if not phone or not phone.isdigit():
                return self.fail_response("Phone number must contain only digits (no + or spaces)")

            if not message or len(message.strip()) == 0:
                return self.fail_response("Message cannot be empty")

            # Enviar via Evolution API
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.api_url}/message/sendText/{self.instance_name}",
                    headers={"apikey": self.api_key},
                    json={
                        "number": phone,
                        "text": message
                    },
                    timeout=30.0
                )

                if response.status_code == 200:
                    result = response.json()
                    return self.success_response({
                        "status": "sent",
                        "phone": phone,
                        "message_id": result.get("key", {}).get("id"),
                        "timestamp": result.get("messageTimestamp")
                    })
                else:
                    return self.fail_response(
                        f"Failed to send message: {response.status_code} - {response.text}"
                    )

        except httpx.TimeoutException:
            return self.fail_response("Request timed out after 30 seconds")
        except Exception as e:
            return self.fail_response(f"Error sending WhatsApp message: {str(e)}")
```

### 2.2 Ferramenta: Enviar Mídia

```python
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "send_whatsapp_media",
            "description": "Send media (image, video, audio, document) via WhatsApp using Evolution API. Supports images (JPEG, PNG, GIF), videos (MP4, MOV), audio (MP3, OGG), and documents (PDF, DOCX, XLSX). The media must be accessible via a public URL. Maximum file size depends on WhatsApp limits: images 5MB, videos 16MB, documents 100MB.",
            "parameters": {
                "type": "object",
                "properties": {
                    "phone": {
                        "type": "string",
                        "description": "WhatsApp phone number in international format"
                    },
                    "media_url": {
                        "type": "string",
                        "description": "Public URL of the media file to send. Must be accessible without authentication."
                    },
                    "media_type": {
                        "type": "string",
                        "enum": ["image", "video", "audio", "document"],
                        "description": "Type of media being sent"
                    },
                    "caption": {
                        "type": "string",
                        "description": "Optional caption/description for the media (images, videos, documents)"
                    },
                    "filename": {
                        "type": "string",
                        "description": "Optional filename for documents (e.g., 'report.pdf')"
                    }
                },
                "required": ["phone", "media_url", "media_type"]
            }
        }
    })
    async def send_whatsapp_media(
        self,
        phone: str,
        media_url: str,
        media_type: str,
        caption: str = "",
        filename: str = None
    ) -> ToolResult:
        """Send media via WhatsApp"""
        try:
            # Validação
            if media_type not in ["image", "video", "audio", "document"]:
                return self.fail_response(f"Invalid media_type: {media_type}")

            if not media_url.startswith(("http://", "https://")):
                return self.fail_response("media_url must be a valid HTTP(S) URL")

            # Preparar payload baseado no tipo
            endpoint_map = {
                "image": "sendMedia",
                "video": "sendMedia",
                "audio": "sendAudio",
                "document": "sendMedia"
            }

            endpoint = endpoint_map.get(media_type, "sendMedia")

            payload = {
                "number": phone,
                "mediaUrl": media_url
            }

            if caption:
                payload["caption"] = caption

            if filename and media_type == "document":
                payload["fileName"] = filename

            # Enviar
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.api_url}/message/{endpoint}/{self.instance_name}",
                    headers={"apikey": self.api_key},
                    json=payload,
                    timeout=60.0  # Mais tempo para upload de mídia
                )

                if response.status_code == 200:
                    result = response.json()
                    return self.success_response({
                        "status": "sent",
                        "phone": phone,
                        "media_type": media_type,
                        "message_id": result.get("key", {}).get("id")
                    })
                else:
                    return self.fail_response(
                        f"Failed to send media: {response.status_code} - {response.text}"
                    )

        except Exception as e:
            return self.fail_response(f"Error sending media: {str(e)}")
```

### 2.3 Ferramenta: Query Database (Reutilizar Supabase)

**NÃO CRIAR NOVA FERRAMENTA!** Usar a integração Supabase existente via Composio.

Exemplo de uso no agent:
```python
# O agent já tem acesso via Composio:
# - supabase_execute_query
# - supabase_get_table_data
# etc.
```

---

## 🎨 Parte 3: Interface Frontend

### 3.1 Card de App Conectado (Padrão Composio)

O sistema já renderiza apps conectados automaticamente. Não precisa criar UI custom!

**Estrutura esperada no `custom_mcps` do agent:**

```json
{
  "custom_mcps": [
    {
      "qualifiedName": "evolution-api-{account_id}",
      "name": "Evolution WhatsApp",
      "type": "custom",
      "config": {
        "url": "http://localhost:8001/mcp",
        "api_url": "https://evolution-api.example.com",
        "instance_name": "my-instance"
      },
      "enabledTools": [
        "send_whatsapp_text",
        "send_whatsapp_media"
      ]
    }
  ]
}
```

O componente `ComposioRegistry` automaticamente renderiza:
- ✅ Logo/ícone
- ✅ Nome "Evolution WhatsApp"
- ✅ Status "Connected (2 tools enabled)"
- ✅ Botão de configuração
- ✅ Gerenciamento de ferramentas

### 3.2 Ícone Custom (Opcional)

Se quiser ícone customizado ao invés de Lucide:

**Backend (mcp_server_service.py):**
```python
mcp_server = MCPServer(
    id=response.id,
    name="Evolution WhatsApp",
    meta={
        "logo": "https://example.com/evolution-logo.png",  # URL pública
        "description": "Alternative WhatsApp integration using Evolution API"
    },
    ...
)
```

**Ou usar emoji:**
```python
meta={
    "logo": "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E📱%3C/text%3E%3C/svg%3E",
    "description": "..."
}
```

### 3.3 Diálogo de Configuração

Criar componente React para configurar Evolution API:

```typescript
// frontend/src/components/agents/evolution/evolution-config-dialog.tsx

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

interface EvolutionConfigDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (config: EvolutionConfig) => void;
  initialConfig?: EvolutionConfig;
}

export function EvolutionConfigDialog({ open, onClose, onSave, initialConfig }: EvolutionConfigDialogProps) {
  const [config, setConfig] = useState({
    api_url: initialConfig?.api_url || '',
    api_key: initialConfig?.api_key || '',
    instance_name: initialConfig?.instance_name || ''
  });

  const handleSave = () => {
    // Validação
    if (!config.api_url || !config.api_key || !config.instance_name) {
      toast.error('All fields are required');
      return;
    }

    onSave(config);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure Evolution API</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div>
            <Label>API URL</Label>
            <Input
              placeholder="https://evolution-api.example.com"
              value={config.api_url}
              onChange={(e) => setConfig({...config, api_url: e.target.value})}
            />
          </div>

          <div>
            <Label>API Key</Label>
            <Input
              type="password"
              placeholder="Your Evolution API key"
              value={config.api_key}
              onChange={(e) => setConfig({...config, api_key: e.target.value})}
            />
          </div>

          <div>
            <Label>Instance Name</Label>
            <Input
              placeholder="my-whatsapp-instance"
              value={config.instance_name}
              onChange={(e) => setConfig({...config, instance_name: e.target.value})}
            />
            <p className="text-xs text-muted-foreground mt-1">
              The name of your Evolution API instance
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave}>Save Configuration</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

### 3.4 Integrar com ComposioRegistry

Adicionar botão "Add Custom Integration" no `ComposioRegistry`:

```typescript
// Em composio-registry.tsx

const [showEvolutionDialog, setShowEvolutionDialog] = useState(false);

// No JSX:
<div className="flex gap-2">
  <Button onClick={() => setShowCustomMCPDialog(true)}>
    <Server className="h-4 w-4 mr-2" />
    Add Custom MCP
  </Button>

  <Button onClick={() => setShowEvolutionDialog(true)} variant="outline">
    <MessageCircle className="h-4 w-4 mr-2" />
    Add Evolution API
  </Button>
</div>

<EvolutionConfigDialog
  open={showEvolutionDialog}
  onClose={() => setShowEvolutionDialog(false)}
  onSave={handleSaveEvolutionConfig}
/>
```

---

## 🎨 Parte 4: Webhooks e Threads

### 4.1 Handler de Webhooks

```python
# backend/core/evolution_api/webhooks.py

from fastapi import APIRouter, Request, HTTPException, Depends
from core.services.supabase import DBConnection
from core.threads import create_or_get_thread
from core.agent_runs import create_agent_run
import hmac
import hashlib

router = APIRouter(prefix="/webhooks/evolution", tags=["evolution-webhooks"])

@router.post("/messages/{instance_name}")
async def handle_evolution_webhook(
    instance_name: str,
    request: Request,
    db: DBConnection = Depends()
):
    """Receive webhooks from Evolution API"""

    try:
        payload = await request.json()
        event = payload.get("event")

        if event != "MESSAGES_UPSERT":
            return {"status": "ignored", "reason": f"Unsupported event: {event}"}

        # Extrair dados da mensagem
        message = payload.get("data", {})
        key = message.get("key", {})
        phone = key.get("remoteJid", "").replace("@s.whatsapp.net", "")

        message_data = message.get("message", {})
        text = (
            message_data.get("conversation") or
            message_data.get("extendedTextMessage", {}).get("text") or
            ""
        )

        if not text:
            return {"status": "ignored", "reason": "No text content"}

        # Buscar configuração
        client = await db.client
        config_result = await client.table("evolution_api_configs")\
            .select("*, agents!inner(*)")\
            .eq("instance_name", instance_name)\
            .eq("is_active", True)\
            .single()\
            .execute()

        if not config_result.data:
            return {"status": "error", "reason": "Instance not configured"}

        config = config_result.data
        agent = config["agents"]

        # Criar/recuperar thread (um por telefone)
        thread = await create_or_get_thread(
            account_id=config["account_id"],
            agent_id=agent["id"],
            external_thread_id=f"whatsapp_evolution_{instance_name}_{phone}",
            metadata={
                "channel": "whatsapp_evolution",
                "phone": phone,
                "instance": instance_name,
                "source": "evolution_api"
            }
        )

        # Criar run do agente
        run = await create_agent_run(
            agent_id=agent["id"],
            thread_id=thread["id"],
            input_message=text,
            metadata={
                "webhook_source": "evolution_api",
                "phone": phone,
                "message_id": key.get("id")
            }
        )

        return {
            "status": "success",
            "thread_id": thread["id"],
            "run_id": run["id"]
        }

    except Exception as e:
        logger.error(f"Error handling Evolution webhook: {e}")
        raise HTTPException(status_code=500, detail=str(e))
```

### 4.2 Thread Management

O sistema já tem gestão de threads! Usar funções existentes:

```python
from core.threads import create_or_get_thread, add_message_to_thread

# Criar/recuperar thread
thread = await create_or_get_thread(
    account_id="uuid",
    agent_id="uuid",
    external_thread_id="whatsapp_evolution_instance_5511999999999",  # Único por telefone
    metadata={
        "channel": "whatsapp_evolution",
        "phone": "5511999999999",
        "instance": "my-instance"
    }
)

# Adicionar mensagem recebida
await add_message_to_thread(
    thread_id=thread["id"],
    role="user",
    content="Mensagem do usuário",
    metadata={"source": "evolution_webhook"}
)
```

---

## 🎨 Parte 5: Registro e Descoberta

### 5.1 Auto-discovery de Ferramentas

O sistema usa **auto-discovery** para encontrar ferramentas!

**Não precisa registrar manualmente.** Apenas:

1. Criar arquivo em `/backend/core/tools/evolution_whatsapp_tool.py`
2. Decorar com `@tool_metadata(...)`
3. O sistema encontra automaticamente via `tool_discovery.py`

### 5.2 Registro de MCP Server

Para aparecer em "Browse Apps", registrar via API:

```python
# backend/core/evolution_api/registration.py

from core.composio_integration.mcp_server_service import MCPServerService

async def register_evolution_mcp_for_account(account_id: str, config: dict):
    """Register Evolution API as MCP server for an account"""

    service = MCPServerService()

    # Criar auth config (se necessário)
    # ...

    # Criar MCP server
    mcp_server = await service.create_mcp_server(
        auth_config_ids=[],  # Vazio para custom
        name=f"Evolution WhatsApp - {config['instance_name']}",
        allowed_tools=["send_whatsapp_text", "send_whatsapp_media"]
    )

    # Gerar URL do MCP
    mcp_url = await service.generate_mcp_url(
        mcp_server_id=mcp_server.id,
        user_ids=[account_id]
    )

    # Salvar no banco
    # ...

    return mcp_server
```

---

## 🎨 Parte 6: Migração do Banco de Dados

```sql
-- backend/supabase/migrations/20250129_evolution_api.sql

-- Configurações de Evolution API
CREATE TABLE evolution_api_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    api_url TEXT NOT NULL,
    api_key TEXT NOT NULL,  -- Encrypted
    instance_name TEXT NOT NULL,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    mcp_server_id TEXT,
    is_active BOOLEAN DEFAULT true,
    webhook_secret TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(account_id, instance_name)
);

-- Índices
CREATE INDEX idx_evolution_configs_account ON evolution_api_configs(account_id);
CREATE INDEX idx_evolution_configs_agent ON evolution_api_configs(agent_id);
CREATE INDEX idx_evolution_configs_active ON evolution_api_configs(is_active) WHERE is_active = true;

-- RLS
ALTER TABLE evolution_api_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their Evolution configs"
    ON evolution_api_configs
    FOR ALL
    USING (account_id = auth.uid());

-- Trigger updated_at
CREATE TRIGGER update_evolution_configs_timestamp
    BEFORE UPDATE ON evolution_api_configs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Log de mensagens (opcional, para debugging)
CREATE TABLE evolution_message_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config_id UUID REFERENCES evolution_api_configs(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    phone TEXT NOT NULL,
    message_type TEXT NOT NULL,
    content TEXT,
    message_id TEXT,
    status TEXT,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_evolution_logs_config ON evolution_message_logs(config_id);
CREATE INDEX idx_evolution_logs_created ON evolution_message_logs(created_at);
```

---

## ✅ Checklist de Implementação

### Backend
- [ ] Criar `/backend/core/tools/evolution_whatsapp_tool.py`
  - [ ] Decorator `@tool_metadata` com nome, ícone, cor
  - [ ] Método `send_whatsapp_text`
  - [ ] Método `send_whatsapp_media`
  - [ ] Validações de input
  - [ ] Error handling robusto

- [ ] Criar `/backend/core/evolution_api/webhooks.py`
  - [ ] Handler para MESSAGES_UPSERT
  - [ ] Integração com threads
  - [ ] Trigger de agent runs
  - [ ] Validação de assinatura (HMAC)

- [ ] Criar `/backend/core/evolution_api/api.py`
  - [ ] POST `/evolution-api/configure`
  - [ ] GET `/evolution-api/configs`
  - [ ] DELETE `/evolution-api/configs/{id}`
  - [ ] POST `/evolution-api/test-connection`

- [ ] Migration do banco
  - [ ] Tabela `evolution_api_configs`
  - [ ] Tabela `evolution_message_logs` (opcional)
  - [ ] RLS policies
  - [ ] Índices

### Frontend
- [ ] Criar `/frontend/src/components/agents/evolution/evolution-config-dialog.tsx`
  - [ ] Form de configuração
  - [ ] Validação de campos
  - [ ] Feedback visual

- [ ] Integrar com ComposioRegistry
  - [ ] Botão "Add Evolution API"
  - [ ] Abrir dialog de configuração
  - [ ] Salvar configuração via API
  - [ ] Refresh da lista de apps conectados

- [ ] (Opcional) Card customizado
  - [ ] Logo/ícone Evolution API
  - [ ] Status de conexão
  - [ ] Botão de teste

### Testes
- [ ] Unit tests para ferramentas
- [ ] Integration tests para webhooks
- [ ] E2E test: configurar → enviar mensagem → receber webhook
- [ ] Test de error handling
- [ ] Test de rate limiting

### Documentação
- [ ] User guide: Como configurar Evolution API
- [ ] Developer docs: Como as ferramentas funcionam
- [ ] API reference: Endpoints e schemas
- [ ] Troubleshooting: Erros comuns

---

## 🎯 Resultado Final

Após implementação completa:

1. **Em "Browse Apps":** Evolution WhatsApp aparece junto com outros apps
2. **Configuração:** Dialog simples com 3 campos (URL, Key, Instance)
3. **Card conectado:** Mostra status, número de tools, botão de settings
4. **Ferramentas disponíveis:** Agent pode enviar texto e mídia via WhatsApp
5. **Webhooks:** Mensagens recebidas criam/atualizam threads automaticamente
6. **Visual:** Indistinguível de integrações oficiais (WhatsApp Business, etc)

---

## 📚 Referências de Código

### Ferramentas para estudar:
- `/backend/core/tools/web_search_tool.py` - Exemplo de ferramenta externa
- `/backend/core/tools/browser_tool.py` - Ferramenta com múltiplos métodos
- `/backend/core/tools/sb_kb_tool.py` - Ferramenta com configuração

### Frontend para estudar:
- `/frontend/src/components/agents/composio/composio-registry.tsx` - Listagem de apps
- `/frontend/src/components/agents/composio/composio-connector.tsx` - Conexão de apps
- `/frontend/src/components/agents/mcp/custom-mcp-dialog.tsx` - Dialog de config custom

### Webhooks para estudar:
- `/backend/core/composio_integration/api.py` (linha 42-77) - Validação de webhooks
- `/backend/core/triggers/` - Sistema de triggers existente

---

## 🚀 Deploy

### Desenvolvimento:
```bash
# Backend
cd backend
uv run python -m core.evolution_api.server

# Testar tool
uv run python -c "
from core.tools.evolution_whatsapp_tool import EvolutionWhatsAppTool
import asyncio

async def test():
    tool = EvolutionWhatsAppTool({
        'api_url': 'https://evolution-api.example.com',
        'api_key': 'YOUR_KEY',
        'instance_name': 'test'
    })
    result = await tool.send_whatsapp_text('5511999999999', 'Hello from Suna!')
    print(result)

asyncio.run(test())
"
```

### Produção:
```bash
# Registrar webhooks na Evolution API
curl -X POST https://evolution-api.example.com/webhook/set \
  -H "apikey: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-suna-instance.com/webhooks/evolution/messages/your-instance",
    "events": ["MESSAGES_UPSERT", "MESSAGES_UPDATE"],
    "webhook_by_events": false
  }'
```

---

## 💡 Dicas Finais

1. **Reutilize o máximo possível** do sistema existente (threads, webhooks, MCP)
2. **Siga o padrão visual** exatamente como outros apps
3. **Use auto-discovery** ao invés de registro manual
4. **Teste com agents reais** antes de considerar completo
5. **Documente erros comuns** para facilitar troubleshooting

---

Essa integração será **visualmente e funcionalmente indistinguível** das integrações oficiais! 🎉
