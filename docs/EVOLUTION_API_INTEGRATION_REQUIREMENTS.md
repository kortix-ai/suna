# REQUISITOS: INTEGRAÇÃO EVOLUTION API COM SUNA

**Projeto:** Sistema de Agentes Conversacionais via WhatsApp
**Cliente:** Enxergar Sem Fronteiras
**Data:** 28/01/2025
**Versão:** 1.0

---

## 1. OBJETIVO GERAL

Integrar a Evolution API ao sistema Suna para permitir que agentes conversem com usuários via WhatsApp de forma bidirecional em tempo real.

Os agentes devem ser capazes de:
- Enviar mensagens de texto pelo WhatsApp
- Receber mensagens enviadas por usuários
- Manter contexto de conversação por número de telefone
- Verificar se números estão ativos no WhatsApp antes de enviar
- Processar múltiplas conversas simultâneas

---

## 2. CONTEXTO

### 2.1 Cenário Atual
- O Suna possui agentes que conversam via chat web/API
- Existe um banco de dados com participantes de eventos (nome, telefone, email)
- A Evolution API já está instalada e configurada na infraestrutura
- Os agentes atualmente só interagem via interface web

### 2.2 Necessidade
Criar uma campanha de captação de doações onde um agente conversa via WhatsApp com pessoas que participaram de eventos anteriores.

### 2.3 Escopo da Integração
Esta integração foca apenas em mensagens de **texto** via WhatsApp. Funcionalidades de áudio, mídia, botões e listas ficam para fase futura.

---

## 3. COMPONENTES NECESSÁRIOS

### 3.1 Ferramenta Nativa de WhatsApp

**Objetivo:** Criar uma ferramenta que qualquer agente no Suna possa ativar para ter capacidade de enviar e receber mensagens via WhatsApp.

**Requisitos:**
- A ferramenta deve aparecer na lista de ferramentas disponíveis ao criar/editar um agente
- Deve ser reutilizável por múltiplos agentes diferentes
- Deve funcionar de forma independente das demais ferramentas do sistema
- Deve gerenciar a conexão com a Evolution API usando credenciais configuradas

**Funcionalidades principais:**
1. Enviar mensagem de texto para um número específico
2. Verificar se um número está registrado no WhatsApp antes de enviar
3. Gerenciar erros de envio (número inválido, instância desconectada, etc)

---

### 3.2 Sistema de Recebimento de Mensagens

**Objetivo:** Capturar mensagens enviadas por usuários no WhatsApp e encaminhar para o agente correto processar.

**Requisitos:**
- Receber notificações da Evolution API quando uma nova mensagem chega
- Identificar qual número enviou a mensagem
- Associar o número a uma conversa/thread existente ou criar uma nova
- Enviar a mensagem para o agente processar
- Retornar a resposta do agente via WhatsApp para o usuário

**Fluxo esperado:**
1. Usuário envia mensagem no WhatsApp
2. Evolution API notifica o Suna
3. Sistema identifica de qual número veio
4. Sistema busca ou cria uma thread para aquele número
5. Mensagem é processada pelo agente
6. Resposta é enviada de volta via WhatsApp

---

### 3.3 Gerenciamento de Threads por Número

**Objetivo:** Manter o histórico de conversação separado por número de telefone, permitindo que cada usuário tenha seu próprio contexto de conversa.

**Requisitos:**
- Cada número de telefone deve ter sua própria thread de conversação
- O histórico da conversa deve persistir entre mensagens
- Deve ser possível retomar uma conversa anterior com o mesmo número
- Threads antigas devem poder ser arquivadas ou encerradas

**Armazenamento necessário:**
Precisa existir uma forma de guardar a associação entre:
- Número de telefone
- Thread/conversa do Suna
- Agente responsável
- Status da conversa (ativa, pausada, encerrada)
- Timestamp da última interação

---

### 3.4 Configuração da Evolution API

**Objetivo:** Armazenar de forma segura as credenciais e configurações necessárias para conectar com a Evolution API.

**Informações que precisam ser configuradas:**
- URL da Evolution API
- API Key de autenticação
- Nome da instância do WhatsApp
- Configurações de retry (tentativas, delays)
- Timeout de requisições

**Requisitos:**
- Configurações devem ser definidas via variáveis de ambiente
- Não devem estar expostas no código
- Devem ser validadas na inicialização do sistema

---

### 3.5 Sistema de Logs e Rastreamento

**Objetivo:** Registrar todas as interações via WhatsApp para auditoria, debugging e análise de desempenho.

**Deve registrar:**
- Mensagens enviadas (número, conteúdo, timestamp, status)
- Mensagens recebidas (número, conteúdo, timestamp)
- Erros de comunicação com Evolution API
- Mudanças de status de conversas
- Tentativas de reenvio

**Finalidade:**
- Debugging quando algo não funciona
- Auditoria de conversas
- Métricas de uso (quantas mensagens, taxa de resposta, etc)
- Compliance (LGPD - dados de saúde)

---

## 4. FERRAMENTA DE CONSULTA AO BANCO DE DADOS

### 4.1 Objetivo
Permitir que agentes consultem o banco de dados do projeto para buscar informações sobre participantes de eventos.

### 4.2 Requisitos
- A ferramenta deve conectar no banco de dados Supabase do projeto
- Deve permitir consultas seguras (apenas SELECT, nunca modificação)
- Deve funcionar com múltiplas tabelas (participantes, eventos, etc)

### 4.3 Consultas Necessárias

**Buscar participantes de eventos:**
- Filtrar por evento específico
- Filtrar por período de participação
- Filtrar por status (participou, inscrito, faltou)
- Retornar: nome, telefone, email, data de participação

**Estatísticas de eventos:**
- Quantos participantes teve um evento
- Quantas pessoas estão inscritas para próximos eventos

### 4.4 Segurança
- Credenciais do banco devem vir de variáveis de ambiente
- Apenas operações de leitura são permitidas
- Queries devem ser parametrizadas para evitar SQL injection
- Não expor dados sensíveis nos logs (telefones, emails devem ser mascarados)

---

## 5. FLUXOS PRINCIPAIS

### 5.1 Fluxo: Iniciar Campanha de Contatos

**Objetivo:** Agente inicia conversa com uma lista de números

**Passos:**
1. Agente consulta banco de dados para obter lista de participantes
2. Para cada participante, agente verifica se número está no WhatsApp
3. Se válido, agente cria uma thread para aquele número
4. Agente envia primeira mensagem personalizada
5. Sistema aguarda resposta do usuário

**Requisitos:**
- Respeitar delay entre envios (evitar spam/ban)
- Marcar números que deram erro
- Não enviar para números já contatados recentemente

---

### 5.2 Fluxo: Responder Mensagem de Usuário

**Objetivo:** Processar resposta de um usuário que já está em conversa

**Passos:**
1. Evolution API notifica que chegou nova mensagem
2. Sistema identifica o número e recupera a thread associada
3. Mensagem é adicionada ao histórico da thread
4. Agente processa a mensagem com todo o contexto
5. Resposta do agente é enviada de volta via WhatsApp
6. Thread é atualizada com a nova resposta

**Requisitos:**
- Resposta deve ser rápida (< 5 segundos)
- Se agente demorar muito, enviar mensagem de "digitando..."
- Gerenciar erros de envio da resposta

---

### 5.3 Fluxo: Tratar Erros de Comunicação

**Objetivo:** Garantir que problemas técnicos não interrompam conversas

**Situações a tratar:**
- Evolution API fora do ar
- Instância do WhatsApp desconectada
- Número bloqueou o bot
- Rate limit atingido
- Timeout na resposta

**Comportamento esperado:**
- Tentar reenviar mensagens com backoff exponencial
- Notificar administrador sobre problemas críticos
- Marcar conversas como "erro" quando não conseguir resolver
- Não perder mensagens recebidas durante quedas

---

## 6. INTEGRAÇÕES

### 6.1 Com Evolution API

**Endpoints que devem ser utilizados:**
- Criar/gerenciar instâncias
- Enviar mensagens de texto
- Verificar status de números
- Configurar webhooks
- Verificar estado da conexão

**Autenticação:**
- Todas requisições devem incluir API Key no header
- Validar se credenciais estão corretas na inicialização

---

### 6.2 Com Banco de Dados Supabase

**Conexão necessária:**
- URL do projeto Supabase
- Service Role Key (permissão de leitura)
- Acesso às tabelas: registrations, patients, events, event_dates

**Segurança:**
- Usar Row Level Security quando disponível
- Conexões devem usar SSL
- Credenciais em variáveis de ambiente

---

### 6.3 Com Sistema de Agentes Suna

**Integração interna:**
- Ferramenta de WhatsApp deve estar disponível no registro de ferramentas
- Agentes devem poder ativar/desativar a ferramenta
- Deve usar o sistema de threads existente do Suna
- Deve respeitar limites e permissões do agente

---

## 7. ARMAZENAMENTO DE DADOS

### 7.1 Associação Número ↔ Thread

**Finalidade:** Guardar qual thread pertence a qual número de telefone

**Informações necessárias:**
- Número de telefone (formato internacional)
- ID da thread no Suna
- ID do agente responsável
- Quando a conversa começou
- Quando foi a última mensagem
- Status atual (ativa, pausada, encerrada)

---

### 7.2 Histórico de Mensagens WhatsApp

**Finalidade:** Registrar todas mensagens enviadas/recebidas para auditoria

**Informações necessárias:**
- ID da mensagem na Evolution API
- Número de telefone
- Conteúdo da mensagem
- Direção (enviada ou recebida)
- Timestamp
- Status (enviada, entregue, lida, erro)
- Erros ocorridos (se houver)

---

### 7.3 Log de Operações

**Finalidade:** Rastrear todas operações da integração para debugging

**Informações necessárias:**
- Tipo de operação (envio, recebimento, verificação, erro)
- Timestamp
- Dados relevantes (número, agente, mensagem resumida)
- Resultado (sucesso/erro)
- Mensagem de erro detalhada (se aplicável)
- Tempo de execução

---

## 8. CONFIGURAÇÕES E VARIÁVEIS

### 8.1 Evolution API
- URL base da API
- API Key
- Nome da instância
- Timeout de requisições (padrão: 60 segundos)
- Máximo de tentativas de reenvio (padrão: 3)
- Delay entre tentativas (padrão: backoff exponencial)

### 8.2 Banco de Dados
- URL do Supabase
- Service Role Key
- Schema (padrão: public)

### 8.3 Comportamento do Sistema
- Delay entre envios (padrão: 2 segundos)
- Máximo de conversas simultâneas por agente
- Tempo para considerar conversa inativa (padrão: 24 horas)
- Webhook URL para receber notificações da Evolution

---

## 9. REQUISITOS NÃO FUNCIONAIS

### 9.1 Performance
- Sistema deve suportar pelo menos 50 conversas simultâneas
- Resposta a mensagem recebida deve ocorrer em menos de 5 segundos
- Envio de mensagem deve completar em menos de 3 segundos

### 9.2 Confiabilidade
- Sistema deve ter retry automático em caso de falhas temporárias
- Mensagens não devem ser perdidas durante quedas de conexão
- Webhooks devem ser processados mesmo em caso de picos de tráfego

### 9.3 Segurança
- Dados de telefone devem ser armazenados criptografados
- Logs não devem expor conteúdo completo de mensagens
- API Keys nunca devem aparecer em logs
- Conformidade com LGPD (dados de saúde são sensíveis)

### 9.4 Observabilidade
- Deve ser possível monitorar quantas mensagens foram enviadas/recebidas
- Deve alertar quando Evolution API está fora do ar
- Deve registrar taxa de erro de envios
- Deve medir latência média de resposta

---

## 10. VALIDAÇÕES NECESSÁRIAS

### 10.1 Antes de Enviar Mensagem
- Número está no formato correto (código país + DDD + número)
- Número está ativo no WhatsApp
- Instância está conectada
- Não ultrapassou limite de mensagens

### 10.2 Ao Receber Mensagem
- Mensagem não é duplicada
- Mensagem veio de uma conversa válida
- Não é uma mensagem enviada pelo próprio bot

### 10.3 Configuração Inicial
- Todas variáveis de ambiente necessárias estão definidas
- Evolution API está acessível
- Banco de dados está acessível
- Credenciais são válidas

---

## 11. TRATAMENTO DE ERROS

### 11.1 Erros de Rede
- Timeout na comunicação com Evolution API
- Evolution API retorna erro 5xx
- Perda de conexão durante envio

**Ação esperada:** Retry com backoff exponencial

---

### 11.2 Erros de Validação
- Número de telefone inválido
- Número não está no WhatsApp
- Mensagem vazia ou muito longa

**Ação esperada:** Logar erro e não tentar reenviar

---

### 11.3 Erros de Autenticação
- API Key inválida
- Permissão negada

**Ação esperada:** Alertar administrador, não processar até resolver

---

### 11.4 Erros de Estado
- Instância desconectada
- QR Code expirado
- WhatsApp banido temporariamente

**Ação esperada:** Pausar envios, notificar administrador

---

## 12. CASOS DE USO

### 12.1 Caso de Uso: Campanha de Captação de Doações

**Ator:** Agente de Captação (Suna)

**Pré-condições:**
- Agente está configurado com ferramenta WhatsApp ativa
- Existe lista de participantes no banco de dados
- Evolution API está conectada

**Fluxo:**
1. Administrador ativa a campanha
2. Agente consulta banco de dados e obtém 100 participantes do último evento
3. Para cada participante:
   - Verifica se número é válido
   - Cria thread individual
   - Envia mensagem de apresentação personalizada
   - Aguarda 2 segundos antes do próximo envio
4. Quando usuário responde:
   - Sistema identifica a thread
   - Agente processa resposta
   - Continua conversa natural até conclusão

**Pós-condições:**
- Todas mensagens foram registradas
- Conversas ativas mantém contexto
- Métricas de campanha estão disponíveis

---

### 12.2 Caso de Uso: Suporte Reativo

**Ator:** Usuário

**Pré-condições:**
- Número do agente está publicado no site
- Usuário adiciona número nos contatos

**Fluxo:**
1. Usuário envia "Olá" via WhatsApp
2. Sistema recebe mensagem
3. Cria nova thread para este número
4. Agente responde com menu de opções
5. Usuário escolhe opção
6. Agente processa e responde
7. Conversa continua até resolução

**Pós-condições:**
- Thread fica ativa por 24h
- Depois é arquivada
- Pode ser reativada se usuário voltar a escrever

---

## 13. CRITÉRIOS DE SUCESSO

### 13.1 Funcionalidade Completa
✅ Agente consegue enviar mensagem de texto via WhatsApp
✅ Agente consegue receber e processar respostas
✅ Múltiplas conversas simultâneas funcionam
✅ Contexto é mantido entre mensagens
✅ Erros são tratados gracefully

### 13.2 Performance Adequada
✅ Taxa de entrega de mensagens > 95%
✅ Latência média de resposta < 5 segundos
✅ Sistema suporta 50+ conversas simultâneas
✅ Uptime > 99%

### 13.3 Qualidade
✅ Mensagens não são perdidas
✅ Não há duplicação de mensagens
✅ Logs permitem debugging eficiente
✅ Segurança e privacidade são respeitadas

---

## 14. EXCLUSÕES (FORA DO ESCOPO)

❌ Envio de imagens, áudios, vídeos ou documentos
❌ Botões interativos e listas
❌ Mensagens em grupo
❌ Status do WhatsApp
❌ Chamadas de voz/vídeo
❌ Interface administrativa visual
❌ Dashboard de métricas
❌ Integração com CRM externo

*Estes itens podem ser implementados em fases futuras*

---

## 15. DEPENDÊNCIAS EXTERNAS

### 15.1 Serviços
- Evolution API instalada e funcionando
- Banco de dados Supabase acessível
- Rede entre Suna e Evolution API estável

### 15.2 Credenciais
- API Key da Evolution API
- Service Role Key do Supabase
- Instância do WhatsApp conectada via QR Code

### 15.3 Bibliotecas
- Cliente HTTP assíncrono para Python
- Cliente Supabase para Python
- WebSocket client (para receber webhooks)

---

## 16. ENTREGÁVEIS ESPERADOS

### 16.1 Código
- Ferramenta WhatsApp completa e funcional
- Ferramenta de consulta ao banco de dados
- Sistema de webhooks para receber mensagens
- Gerenciador de threads por número
- Documentação de configuração

### 16.2 Infraestrutura
- Schemas de banco de dados criados
- Variáveis de ambiente documentadas
- Scripts de setup inicial

### 16.3 Documentação
- Como configurar Evolution API
- Como ativar ferramenta em um agente
- Como iniciar uma campanha
- Como monitorar logs
- Troubleshooting de problemas comuns

### 16.4 Testes
- Testes de envio de mensagem
- Testes de recebimento
- Testes de múltiplas conversas
- Testes de recuperação de erros

---

## 17. CRONOGRAMA SUGERIDO

**Fase 1 (1 semana):** Ferramenta de envio de mensagens + validações
**Fase 2 (1 semana):** Sistema de webhooks + recebimento
**Fase 3 (1 semana):** Gerenciamento de threads + ferramenta de banco
**Fase 4 (1 semana):** Testes, refinamento e documentação

**Total estimado:** 4 semanas

---

## 18. OBSERVAÇÕES IMPORTANTES

1. **Português do Brasil:** Toda comunicação deve considerar idioma PT-BR
2. **Tom da Conversa:** Agente deve ser amigável, respeitoso e persuasivo
3. **Privacidade:** Números de telefone são dados sensíveis (projeto de saúde)
4. **Rate Limiting:** WhatsApp pode banir se enviar muitas mensagens rapidamente
5. **Custo Zero de APIs:** Usar apenas Evolution API (já instalada), sem APIs pagas de terceiros

---

## 19. CONTATO PARA DÚVIDAS

Se houver dúvidas sobre requisitos, consultar:
- Documentação Evolution API: `/docs/EVOLUTION_API_REFERENCE.md`
- Estrutura do banco de dados: Supabase project "enxergar"
- Arquitetura do Suna: Código em `/backend/core/`

---

**FIM DO DOCUMENTO DE REQUISITOS**

*Este documento descreve O QUE deve ser feito. O COMO implementar fica a critério da equipe de desenvolvimento.*
