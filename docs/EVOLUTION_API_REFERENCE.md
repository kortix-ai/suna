# 📱 EVOLUTION API - GUIA COMPLETO DE INTEGRAÇÃO

## 📋 Índice

1. [Introdução](#introdução)
2. [Conceitos Fundamentais](#conceitos-fundamentais)
3. [Autenticação](#autenticação)
4. [Gerenciamento de Instâncias](#gerenciamento-de-instâncias)
5. [Envio de Mensagens](#envio-de-mensagens)
6. [Recebimento de Mensagens (Webhooks)](#recebimento-de-mensagens-webhooks)
7. [Configuração de Webhooks](#configuração-de-webhooks)
8. [Estruturas de Dados](#estruturas-de-dados)
9. [Variáveis de Ambiente](#variáveis-de-ambiente)
10. [Exemplos Práticos](#exemplos-práticos)
11. [Tratamento de Erros](#tratamento-de-erros)

---

## 🎯 Introdução

**Evolution API** é uma API open-source para integração com WhatsApp, suportando:
- **WhatsApp API Baileys** (gratuito, baseado no WhatsApp Web)
- **WhatsApp Cloud API** (oficial Meta)

**Documentação Oficial:** https://doc.evolution-api.com
**GitHub:** https://github.com/EvolutionAPI/evolution-api
**Versão Atual:** 2.3.0

---

## 🔑 Conceitos Fundamentais

### Instância (Instance)

Uma **instância** representa uma conexão individual do WhatsApp. Cada número de telefone requer uma instância separada.

**Características:**
- Cada instância tem um nome único (`instanceName`)
- Pode ter uma API Key específica (opcional)
- Mantém sessão persistente
- Suporta múltiplas instâncias simultâneas

### Estrutura de URL Base

```
https://{SERVER_URL}/{endpoint}/{instanceName}
```

**Exemplo:**
```
https://api.seudominio.com/message/sendText/minha_instancia
```

---

## 🔐 Autenticação

### API Key

**Todas** as requisições devem incluir a API Key no header:

```http
apikey: SUA_API_KEY_AQUI
```

### Configuração da API Key

**Opção 1: Global (via .env)**
```env
AUTHENTICATION_API_KEY=429683C4C977415CAAFCCE10F7D57E11
```

**Opção 2: Por Instância**
- Definida ao criar a instância
- Permite controle granular por cliente/projeto

### Exemplo de Header Completo

```http
Content-Type: application/json
apikey: 429683C4C977415CAAFCCE10F7D57E11
```

---

## 🏗️ Gerenciamento de Instâncias

### 1. Criar Instância

**Endpoint:**
```
POST /instance/create
```

**Request Body:**
```json
{
  "instanceName": "captacao_doacoes",
  "token": "TOKEN_OPCIONAL",
  "number": "5511999999999",
  "qrcode": false,
  "integration": "EVOLUTION"
}
```

**Parâmetros:**
- `instanceName` (string, obrigatório): Nome único da instância
- `token` (string, opcional): Token customizado para esta instância
- `number` (string, opcional): Número de telefone com código do país
- `qrcode` (boolean, opcional): Se deve gerar QR code (default: true)
- `integration` (string, opcional): Tipo de integração ("EVOLUTION", "WHATSAPP-BAILEYS", "WHATSAPP-BUSINESS")

**Response (200 OK):**
```json
{
  "instance": {
    "instanceName": "captacao_doacoes",
    "status": "created"
  },
  "qrcode": {
    "code": "base64_qrcode_image",
    "base64": "data:image/png;base64,..."
  }
}
```

**cURL Exemplo:**
```bash
curl -X POST https://api.seudominio.com/instance/create \
  -H "Content-Type: application/json" \
  -H "apikey: 429683C4C977415CAAFCCE10F7D57E11" \
  -d '{
    "instanceName": "captacao_doacoes",
    "qrcode": true,
    "integration": "EVOLUTION"
  }'
```

---

### 2. Listar Instâncias

**Endpoint:**
```
GET /instance/fetchInstances
```

**Response:**
```json
[
  {
    "instanceName": "captacao_doacoes",
    "status": "open",
    "serverUrl": "https://api.seudominio.com",
    "apikey": "429683C4C977415CAAFCCE10F7D57E11"
  }
]
```

---

### 3. Estado da Conexão

**Endpoint:**
```
GET /instance/connectionState/{instanceName}
```

**Response:**
```json
{
  "instance": "captacao_doacoes",
  "state": "open"
}
```

**Estados possíveis:**
- `open`: Conectado
- `close`: Desconectado
- `connecting`: Conectando

---

### 4. Deletar Instância

**Endpoint:**
```
DELETE /instance/delete/{instanceName}
```

**Response:**
```json
{
  "status": "REMOVED",
  "error": false
}
```

---

## 📤 Envio de Mensagens

### 1. Enviar Mensagem de Texto

**Endpoint:**
```
POST /message/sendText/{instanceName}
```

**Request Body (Formato 1 - Simples):**
```json
{
  "number": "5511999999999",
  "text": "Olá! Esta é uma mensagem de teste.",
  "delay": 1200,
  "linkPreview": true,
  "mentionsEveryOne": false,
  "mentioned": []
}
```

**Request Body (Formato 2 - Com Options):**
```json
{
  "number": "5511999999999",
  "options": {
    "delay": 1200,
    "presence": "composing",
    "linkPreview": false
  },
  "textMessage": {
    "text": "Olá! Agradecemos sua participação no evento Enxergar Sem Fronteiras 🙏"
  }
}
```

**Parâmetros:**
- `number` (string, obrigatório): Número com código do país (5511999999999)
- `text` ou `textMessage.text` (string, obrigatório): Texto da mensagem
- `delay` (number, opcional): Delay em ms antes de enviar (simular digitação)
- `presence` (string, opcional): "composing" (digitando) ou "recording" (gravando áudio)
- `linkPreview` (boolean, opcional): Mostrar preview de links
- `mentionsEveryOne` (boolean, opcional): Mencionar todos no grupo
- `mentioned` (array, opcional): Array de números para mencionar

**Response (200 OK):**
```json
{
  "key": {
    "remoteJid": "5511999999999@s.whatsapp.net",
    "fromMe": true,
    "id": "BAE5F3F0A9E0E0E0"
  },
  "message": {
    "extendedTextMessage": {
      "text": "Olá! Agradecemos sua participação..."
    }
  },
  "messageTimestamp": 1633456789,
  "status": "PENDING"
}
```

**cURL Exemplo:**
```bash
curl -X POST https://api.seudominio.com/message/sendText/captacao_doacoes \
  -H "Content-Type: application/json" \
  -H "apikey: 429683C4C977415CAAFCCE10F7D57E11" \
  -d '{
    "number": "5511999999999",
    "options": {
      "delay": 1200,
      "presence": "composing"
    },
    "textMessage": {
      "text": "Olá João! 👋\n\nEsperamos que tenha gostado do evento."
    }
  }'
```

---

### 2. Enviar Mídia (Imagem, Vídeo, Áudio, Documento)

**Endpoint:**
```
POST /message/sendMedia/{instanceName}
```

**Request Body:**
```json
{
  "number": "5511999999999",
  "mediatype": "image",
  "mimetype": "image/jpeg",
  "caption": "Confira nossa última campanha!",
  "media": "https://example.com/imagem.jpg",
  "fileName": "campanha.jpg",
  "delay": 1200
}
```

**Parâmetros:**
- `number` (string, obrigatório): Número destinatário
- `mediatype` (string, obrigatório): "image", "video", "audio", "document"
- `media` (string, obrigatório): URL pública da mídia OU base64
- `caption` (string, opcional): Legenda (para imagem/vídeo)
- `fileName` (string, opcional): Nome do arquivo
- `mimetype` (string, opcional): Tipo MIME

**Exemplo com Base64:**
```json
{
  "number": "5511999999999",
  "mediatype": "image",
  "media": "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
  "caption": "Recibo de doação"
}
```

---

### 3. Enviar Áudio (WhatsApp Voice)

**Endpoint:**
```
POST /message/sendWhatsAppAudio/{instanceName}
```

**Request Body:**
```json
{
  "number": "5511999999999",
  "audioMessage": {
    "audio": "https://example.com/audio.mp3"
  },
  "options": {
    "delay": 1200,
    "presence": "recording",
    "encoding": true
  }
}
```

---

### 4. Enviar Botões

**Endpoint:**
```
POST /message/sendButtons/{instanceName}
```

**Request Body:**
```json
{
  "number": "5511999999999",
  "title": "Doar para Enxergar Sem Fronteiras",
  "description": "Escolha o valor da sua doação:",
  "footer": "Sua contribuição faz diferença! 💚",
  "buttons": [
    {
      "type": "reply",
      "displayText": "R$ 20"
    },
    {
      "type": "reply",
      "displayText": "R$ 50"
    },
    {
      "type": "reply",
      "displayText": "R$ 100"
    },
    {
      "type": "reply",
      "displayText": "Outro valor"
    }
  ]
}
```

---

### 5. Enviar Lista

**Endpoint:**
```
POST /message/sendList/{instanceName}
```

**Request Body:**
```json
{
  "number": "5511999999999",
  "title": "Opções de Doação",
  "description": "Escolha como deseja contribuir:",
  "buttonText": "Ver opções",
  "footerText": "Enxergar Sem Fronteiras",
  "sections": [
    {
      "title": "Doação Única",
      "rows": [
        {
          "title": "R$ 20",
          "description": "Doação única de R$ 20",
          "rowId": "doacao_20"
        },
        {
          "title": "R$ 50",
          "description": "Doação única de R$ 50",
          "rowId": "doacao_50"
        }
      ]
    },
    {
      "title": "Doação Recorrente",
      "rows": [
        {
          "title": "R$ 20/mês",
          "description": "Contribuição mensal",
          "rowId": "recorrente_20"
        }
      ]
    }
  ]
}
```

---

### 6. Verificar se Número está no WhatsApp

**Endpoint:**
```
POST /chat/whatsappNumbers/{instanceName}
```

**Request Body:**
```json
{
  "numbers": [
    "5511999999999",
    "5511888888888"
  ]
}
```

**Response:**
```json
[
  {
    "jid": "5511999999999@s.whatsapp.net",
    "exists": true
  },
  {
    "jid": "5511888888888@s.whatsapp.net",
    "exists": false
  }
]
```

---

## 📥 Recebimento de Mensagens (Webhooks)

### Configurar Webhook na Instância

**Endpoint:**
```
POST /webhook/set/{instanceName}
```

**Request Body:**
```json
{
  "url": "https://seu-suna.com/webhooks/evolution/messages",
  "webhook_by_events": false,
  "webhook_base64": false,
  "events": [
    "MESSAGES_UPSERT",
    "MESSAGES_UPDATE",
    "CONNECTION_UPDATE"
  ]
}
```

**Parâmetros:**
- `url` (string, obrigatório): URL do seu webhook
- `webhook_by_events` (boolean, opcional): Se true, envia evento separado por tipo
- `webhook_base64` (boolean, opcional): Se true, envia mídias em base64
- `events` (array, opcional): Lista de eventos para receber

---

### Eventos Disponíveis

| Evento | Descrição |
|--------|-----------|
| `MESSAGES_UPSERT` | Mensagem nova recebida ou enviada |
| `MESSAGES_UPDATE` | Status de mensagem atualizado (enviado, lido, etc) |
| `MESSAGES_DELETE` | Mensagem deletada |
| `CONNECTION_UPDATE` | Estado da conexão mudou |
| `CALL` | Chamada recebida |
| `GROUP_UPDATE` | Atualização em grupo |
| `GROUP_PARTICIPANTS_UPDATE` | Participantes de grupo |
| `PRESENCE_UPDATE` | Status de presença (online, digitando) |

---

### Estrutura do Payload de Webhook

#### 1. MESSAGES_UPSERT (Mensagem Recebida)

**Payload recebido no seu endpoint:**
```json
{
  "event": "messages.upsert",
  "instance": "captacao_doacoes",
  "data": {
    "key": {
      "remoteJid": "5511999999999@s.whatsapp.net",
      "fromMe": false,
      "id": "BAE5F3F0A9E0E0E0"
    },
    "pushName": "João Silva",
    "message": {
      "conversation": "Sim, gostaria de fazer uma doação!"
    },
    "messageType": "conversation",
    "messageTimestamp": 1633456789,
    "instanceName": "captacao_doacoes",
    "source": "web"
  },
  "server_url": "https://api.seudominio.com",
  "apikey": "429683C4C977415CAAFCCE10F7D57E11",
  "date_time": "2025-01-27T15:30:45.123Z"
}
```

**Campos Importantes:**
- `event`: Sempre "messages.upsert"
- `data.key.remoteJid`: Identificador do remetente (número@s.whatsapp.net)
- `data.key.fromMe`: `false` = recebida, `true` = enviada por você
- `data.pushName`: Nome do contato no WhatsApp
- `data.message.conversation`: Texto da mensagem (tipo simples)
- `data.messageType`: Tipo da mensagem

---

#### 2. Mensagem com Texto Estendido

```json
{
  "event": "messages.upsert",
  "data": {
    "key": {
      "remoteJid": "5511999999999@s.whatsapp.net",
      "fromMe": false
    },
    "message": {
      "extendedTextMessage": {
        "text": "Posso doar R$ 50",
        "contextInfo": {
          "quotedMessage": {
            "conversation": "Qual valor gostaria de doar?"
          }
        }
      }
    },
    "messageType": "extendedTextMessage"
  }
}
```

---

#### 3. Mensagem com Mídia

```json
{
  "event": "messages.upsert",
  "data": {
    "message": {
      "imageMessage": {
        "url": "https://mmg.whatsapp.net/...",
        "mimetype": "image/jpeg",
        "caption": "Comprovante de pagamento",
        "jpegThumbnail": "/9j/4AAQ...",
        "height": 1080,
        "width": 1920
      }
    },
    "messageType": "imageMessage"
  }
}
```

---

#### 4. Mensagem com Botão/Lista (Resposta)

```json
{
  "event": "messages.upsert",
  "data": {
    "message": {
      "buttonsResponseMessage": {
        "selectedButtonId": "doacao_50",
        "selectedDisplayText": "R$ 50"
      }
    },
    "messageType": "buttonsResponseMessage"
  }
}
```

---

#### 5. CONNECTION_UPDATE

```json
{
  "event": "connection.update",
  "instance": "captacao_doacoes",
  "data": {
    "state": "open"
  }
}
```

**Estados:**
- `open`: Conectado
- `close`: Desconectado
- `connecting`: Reconectando

---

### Extrair Número e Mensagem do Webhook

**Python Exemplo:**
```python
def extrair_dados_webhook(payload):
    event = payload.get("event")

    if event != "messages.upsert":
        return None

    data = payload.get("data", {})
    key = data.get("key", {})

    # Ignorar mensagens enviadas por nós
    if key.get("fromMe"):
        return None

    # Extrair número (remover @s.whatsapp.net)
    remote_jid = key.get("remoteJid", "")
    numero = remote_jid.replace("@s.whatsapp.net", "")

    # Extrair texto da mensagem
    message = data.get("message", {})

    # Verificar tipo de mensagem
    texto = None
    if "conversation" in message:
        texto = message["conversation"]
    elif "extendedTextMessage" in message:
        texto = message["extendedTextMessage"]["text"]
    elif "buttonsResponseMessage" in message:
        texto = message["buttonsResponseMessage"]["selectedDisplayText"]
    elif "listResponseMessage" in message:
        texto = message["listResponseMessage"]["title"]

    return {
        "numero": numero,
        "texto": texto,
        "nome": data.get("pushName"),
        "timestamp": data.get("messageTimestamp")
    }
```

---

## ⚙️ Variáveis de Ambiente

### Configuração Mínima (.env)

```env
# URL do servidor
SERVER_URL=https://api.seudominio.com

# Autenticação
AUTHENTICATION_API_KEY=429683C4C977415CAAFCCE10F7D57E11

# Webhook Global (opcional)
WEBHOOK_GLOBAL_ENABLED=false
WEBHOOK_GLOBAL_URL=https://seu-suna.com/webhooks/evolution/messages

# Webhook - Retry Config
WEBHOOK_REQUEST_TIMEOUT_MS=60000
WEBHOOK_RETRY_MAX_ATTEMPTS=10
WEBHOOK_RETRY_INITIAL_DELAY_SECONDS=5
WEBHOOK_RETRY_USE_EXPONENTIAL_BACKOFF=true

# Para WhatsApp Cloud API (se usar)
WA_BUSINESS_TOKEN_WEBHOOK=evolution
WA_BUSINESS_URL=https://graph.facebook.com

# Database (PostgreSQL)
DATABASE_CONNECTION_URI=postgresql://user:pass@localhost:5432/evolution

# Redis (opcional, para cache)
CACHE_REDIS_URI=redis://localhost:6379/6
CACHE_REDIS_SAVE_INSTANCES=false

# Instância
DEL_INSTANCE=false
CONFIG_SESSION_PHONE_CLIENT=Enxergar Sem Fronteiras
CONFIG_SESSION_PHONE_NAME=Chrome
QRCODE_LIMIT=30
```

---

## 💡 Exemplos Práticos

### Exemplo 1: Enviar Mensagem Simples

**Python + httpx:**
```python
import httpx
import os

async def enviar_mensagem_whatsapp(numero: str, texto: str):
    url = f"{os.getenv('EVOLUTION_API_URL')}/message/sendText/{os.getenv('EVOLUTION_INSTANCE')}"

    headers = {
        "Content-Type": "application/json",
        "apikey": os.getenv("EVOLUTION_API_KEY")
    }

    payload = {
        "number": numero,
        "options": {
            "delay": 1200,
            "presence": "composing"
        },
        "textMessage": {
            "text": texto
        }
    }

    async with httpx.AsyncClient() as client:
        response = await client.post(url, headers=headers, json=payload)

        if response.status_code == 200:
            return {"sucesso": True, "dados": response.json()}
        else:
            return {"sucesso": False, "erro": response.text}
```

---

### Exemplo 2: Processar Webhook de Mensagem

**Python + FastAPI:**
```python
from fastapi import APIRouter, Request

router = APIRouter()

@router.post("/webhooks/evolution/messages")
async def receber_mensagem_whatsapp(request: Request):
    payload = await request.json()

    event = payload.get("event")

    # Processar apenas mensagens recebidas
    if event != "messages.upsert":
        return {"status": "ignored"}

    data = payload.get("data", {})
    key = data.get("key", {})

    # Ignorar mensagens enviadas por nós
    if key.get("fromMe"):
        return {"status": "ignored"}

    # Extrair dados
    numero = key.get("remoteJid", "").replace("@s.whatsapp.net", "")
    nome = data.get("pushName")

    # Extrair texto
    message = data.get("message", {})
    texto = message.get("conversation") or \
            message.get("extendedTextMessage", {}).get("text")

    if not texto:
        return {"status": "no_text"}

    # Processar mensagem (enviar para agente Suna)
    await processar_com_agente_suna(numero, texto)

    return {"status": "processed"}


async def processar_com_agente_suna(numero: str, mensagem: str):
    # 1. Buscar ou criar thread para este número
    thread_id = await get_or_create_thread(numero)

    # 2. Enviar mensagem para agente processar
    # (Lógica de integração com Suna aqui)

    # 3. Enviar resposta do agente via Evolution
    pass
```

---

### Exemplo 3: Verificar Status antes de Enviar

```python
async def enviar_com_verificacao(numero: str, texto: str):
    # 1. Verificar se número existe no WhatsApp
    check_url = f"{API_URL}/chat/whatsappNumbers/{INSTANCE}"

    check_payload = {"numbers": [numero]}

    async with httpx.AsyncClient() as client:
        check_response = await client.post(
            check_url,
            headers=HEADERS,
            json=check_payload
        )

        resultado = check_response.json()

        if not resultado[0].get("exists"):
            return {"erro": "Número não está no WhatsApp"}

        # 2. Número válido, enviar mensagem
        return await enviar_mensagem_whatsapp(numero, texto)
```

---

## ⚠️ Tratamento de Erros

### Códigos de Status HTTP

| Código | Significado |
|--------|-------------|
| 200 | Sucesso |
| 400 | Requisição inválida (parâmetros faltando) |
| 401 | Não autorizado (API Key inválida) |
| 403 | Proibido |
| 404 | Instância não encontrada |
| 500 | Erro interno do servidor |

### Erros Comuns

#### 1. Instância Desconectada
```json
{
  "status": "ERROR",
  "error": "Instance not connected"
}
```
**Solução:** Reconectar instância via QR Code

#### 2. Número Inválido
```json
{
  "status": "ERROR",
  "error": "Invalid number format"
}
```
**Solução:** Usar formato com código do país (5511999999999)

#### 3. Rate Limit
```json
{
  "status": "ERROR",
  "error": "Too many requests"
}
```
**Solução:** Implementar delay entre mensagens (1-2 segundos)

---

## 🔧 Configuração de Retry para Webhooks

A Evolution API tem sistema de retry automático para webhooks:

```env
WEBHOOK_RETRY_MAX_ATTEMPTS=10
WEBHOOK_RETRY_INITIAL_DELAY_SECONDS=5
WEBHOOK_RETRY_USE_EXPONENTIAL_BACKOFF=true
WEBHOOK_RETRY_MAX_DELAY_SECONDS=300
WEBHOOK_RETRY_NON_RETRYABLE_STATUS_CODES=400,401,403,404,422
```

**Comportamento:**
- Tenta até 10 vezes
- Delay inicial: 5 segundos
- Backoff exponencial (5s → 10s → 20s → ...)
- Máximo de 300s entre tentativas
- Não retenta em erros 4xx (exceto 429)

---

## 📚 Recursos Adicionais

### Documentação Oficial
- V2 Completa: https://doc.evolution-api.com/v2
- V1 PT-BR: https://doc.evolution-api.com/v1/pt

### GitHub
- Repositório: https://github.com/EvolutionAPI/evolution-api
- Issues: https://github.com/EvolutionAPI/evolution-api/issues

### Postman Collection
- https://www.postman.com/agenciadgcode/evolution-api

### Swagger/OpenAPI
- Disponível em: `{SEU_SERVER_URL}/docs`

---

## ✅ Checklist de Implementação

### Setup Inicial
- [ ] Evolution API instalada e rodando
- [ ] Variáveis de ambiente configuradas
- [ ] API Key gerada e testada

### Configuração de Instância
- [ ] Instância criada via `/instance/create`
- [ ] QR Code escaneado e conectado
- [ ] Estado da conexão verificado (`open`)

### Webhooks
- [ ] Endpoint de webhook criado no seu servidor
- [ ] Webhook configurado na instância
- [ ] Eventos `MESSAGES_UPSERT` recebidos e processados

### Envio de Mensagens
- [ ] Envio de texto simples funcionando
- [ ] Validação de número implementada
- [ ] Delay entre mensagens implementado
- [ ] Tratamento de erros implementado

### Integração com Suna
- [ ] Ferramenta Evolution criada no Suna
- [ ] Método `enviar_mensagem` implementado
- [ ] Método `verificar_numero` implementado
- [ ] Webhook handler conectado ao agente

---

## 🎯 Pronto para Implementar!

Este guia contém **TUDO** que você precisa para integrar Evolution API com Suna.

**Próximos passos:**
1. Criar ferramenta `evolution_whatsapp_tool.py` no Suna
2. Implementar webhook handler `evolution_webhook.py`
3. Configurar agente de captação para usar a ferramenta
4. Testar com números reais

**Tempo estimado:** 3-5 dias de desenvolvimento

---

**Última atualização:** 27/01/2025
**Versão Evolution API:** 2.3.0
**Compatibilidade:** Suna 1.0+
