# Isolamento por sessão no Stop hook (dedup + cross-talk entre sessões irmãs)

## Contexto

O Stop hook (`bin/relay-stop-hook.mjs`) existe como alternativa pull-side ao
canal MCP nativo (`notifications/claude/channel`), que está quebrado para
`server:` channels em builds recentes do Claude Code
(anthropics/claude-code#71792) e exige um flag/dialog incômodo mesmo quando
funciona. Em uso real ele expôs dois bugs, ambos com a mesma causa raiz: a
identidade usada para decidir "esse job é meu" é fraca demais.

**Problema A — notificação duplicada na mesma sessão**: quando
`dispatch_wait` já entrega um job terminal inline na resposta da tool call, o
Stop hook notifica de novo o mesmo job pouco depois, porque seu seen-set é um
snapshot tirado uma vez no `SessionStart` (`bin/relay-stop-hook.mjs:129`) —
jobs concluídos durante o turno nunca entram nesse snapshot.

**Problema B — cross-talk entre sessões irmãs** (confirmado em produção,
2026-07-02, usuário com 3 sessões do Claude Code abertas no mesmo projeto): o
hook decide se um job "pertence" à sessão via `job.from === agentId`
(`lib/relay-hook.mjs:39`), e `agentId` vem de `RELAY_AGENT` — identidade
LÓGICA compartilhada por todas as sessões do mesmo projeto. Com N sessões
simultâneas, uma sessão é notificada sobre um job que uma sessão irmã
despachou. Contraste histórico: o design anterior (`codex-ws.mjs`, pré-relay)
nunca teve esse problema porque cada disparo usava um arquivo de saída
próprio (`--out` + `.done`) — notificação 1:1 por construção, nunca por
identidade lógica compartilhada.

Esse desenho foi validado por duas rodadas de revisão adversarial do Codex via
`dispatch_wait` real (não simulada) e um agente Plan dedicado, com os fatos de
código abaixo confirmados por leitura direta dos arquivos atuais.

## Abordagem

Um **arquivo "owned" por sessão** (`owned-<sessionId>.json`), escrito
exclusivamente por quem despacha (`server.mjs`), nunca pelo hook. Resolve os
dois problemas com o mesmo mecanismo, guardando duas formas de entrada no
mesmo array (a diferença de propósito vem do formato da string, não de campos
separados):

- **id nu do job** (`"relay-1a2b3c-x7y8z9"`) — gravado no momento do
  **dispatch** (`enqueueFromArgs`, cobre `dispatch` e `dispatch_wait`,
  dedupado ou não). Funciona como **whitelist**: só um job cujo id está aqui é
  candidato a notificação `from`-side para esta sessão. Resolve o Problema B
  — uma sessão irmã nunca grava o id do job de outra, então nunca vira
  candidata para ela. Também cobre o caso de dedup: se uma segunda sessão
  reusa o mesmo `request_id`, ela recebe `out.jobId` de volta e também grava
  — nunca fica órfã.
- **chave terminal completa** (`"relay-1a2b3c-x7y8z9:completed:169..."`,
  mesmo formato de `channelKeys`) — gravada no momento da **entrega** (inline
  em `dispatch_wait`, ou ao empurrar pelo canal). Funciona como **exclusão**:
  uma transição já entregue por outro caminho não é notificada de novo pelo
  hook. Resolve o Problema A.

Fallback gracioso obrigatório em toda a cadeia: quando faltar
`CLAUDE_CODE_SESSION_ID`, `RELAY_AGENT`, ou o owned-file, o comportamento cai
exatamente para o de hoje (filtro só por `agentId`) — nunca notifica MENOS do
que hoje.

Descartada a alternativa de um campo `job.fromSessionId` no schema do job
(mudança de schema mais invasiva) e a escrita direta em
`hook-seen-<session>.json` (quebraria a lógica de "arquivo ausente = sem
baseline, semear e liberar" em `bin/relay-stop-hook.mjs:136`).

### Limitação aceita

**Restart de sessão**: se a sessão reinicia (novo `CLAUDE_CODE_SESSION_ID`)
com um job dela ainda em voo, o owned-file novo está vazio e ela não é mais
notificada sobre esse job — hoje (sem este fix) isso não acontece, pois o
filtro por `agentId` sobrevive a restarts. Trade-off aceito, documentado no
código e coberto por um teste explícito (não deve ser tratado como bug depois
de implementado).

**Divergência de session id**: `process.env.CLAUDE_CODE_SESSION_ID` (visto
pelo `server.mjs`) e `input.session_id` (visto pelo hook) devem ser tratados
como a mesma fonte canônica. Se um dia divergirem silenciosamente, o filtro
falha fechado (fallback) — o hook loga um aviso quando ambos existem e
diferem, usando o valor do env como canônico.

## Arquivos e mudanças

**`lib/relay-owned.mjs` (novo)** — storage puro, sem depender de `server.mjs`
nem de `bin/relay-stop-hook.mjs`:
- `sanitizeSessionId(id)` / `ownedFile(cwd, sessionId)` — mesmo padrão de
  `sanitizeId`/`seenFile` já usado em `bin/relay-stop-hook.mjs:65-70`, mas com
  sua própria sanitização (arquivo independente do `hook-seen-*`).
- `readOwned(cwd, sessionId)` — leitura simples; retorna `null` (não um Set
  vazio) quando o arquivo falta/corrompe, para o chamador distinguir "sem
  dados → fallback" de "dados dizem vazio".
- `recordOwned(cwd, sessionId, entries)` — escrita síncrona sob
  `withFileLock()` (`lib/file-lock.mjs:29`, lock dedicado `${file}.lock`,
  nunca o lock do store principal), merge com o conteúdo atual, trim FIFO
  acima de ~2000 entradas (mantém as últimas ~1000 — ids de job são únicos
  para sempre via `generateJobId`, uma entrada podada nunca causa falso
  positivo). Falha de lock/escrita é engolida silenciosamente — bookkeeping
  nunca pode quebrar um dispatch ou uma entrega.
- Usa `resolveStateDir(cwd)` de `lib/store-paths.mjs:42` (mesmo padrão de
  `resolveWorktreesDir`/`resolveJobEventFile`).

**`lib/relay-hook.mjs`** — as 4 funções ganham um parâmetro opcional
`ownedIds` (`Set<string> | null`, default `null` = comportamento idêntico ao
de hoje, sem regressão):
- `channelKeys(job, agentId, ownedIds)` (linha 36): no branch terminal
  (`from === agentId`), só considera candidato se `ownedIds` for `null` ou
  `ownedIds.has(job.id)` (whitelist); dentro disso, só inclui na lista se
  `ownedIds` for `null` ou **não** tiver a chave terminal completa
  (exclusão). O branch `inbox` (`to === agentId`) não muda — a ambiguidade é
  específica do lado `from`.
- `collectKeys`, `seedKeys`, `surface` (linhas 49, 60, 67): repassam
  `ownedIds` para `channelKeys`.
- `hasInFlightFromAgent(jobs, agentId, ownedIds)` (linha 83): mesmo filtro de
  whitelist pelo id nu — corrige de graça o furo que o Codex apontou (a
  mesma informação já existe desde o dispatch, sem custo extra).

**`bin/relay-stop-hook.mjs`**:
- Import `readOwned` de `../lib/relay-owned.mjs`.
- Resolver a identidade canônica de sessão logo após ler `input`:
  `envSessionId = process.env.CLAUDE_CODE_SESSION_ID`,
  `payloadSessionId = input.session_id`; logar via `log()` (já existe, linha
  41) se ambos existirem e divergirem; usar `envSessionId || payloadSessionId`
  como `ownedSessionId`.
- `const ownedIds = ownedSessionId ? readOwned(cwd, ownedSessionId) : null;`
- Passar `ownedIds` nas 4 chamadas existentes: as duas de `seedKeys` (linhas
  129 e 139), as duas de `surface` (linha 145 e dentro do loop de long-poll,
  linha 156), e a de `hasInFlightFromAgent` (linha 153).
- `hook-seen-<session>.json` (chaveado por `input.session_id`) fica
  intocado — arquivo e sanitização separados do owned-file, de propósito.

**`server.mjs`**:
- Deduplicar: remover a cópia local de `channelKeys` (~linhas 516-525) e
  importar a versão de `lib/relay-hook.mjs` (retorna `{key, kind, job}`, um
  campo a mais que a cópia local — compatível, o código já desestrutura só
  `{key, kind}`).
- `const SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID || null;` ao lado de
  `AGENT_ID` (linha 52).
- Em `enqueueFromArgs`, antes do `return { out };` (linha 310): `if
  (SESSION_ID) recordOwned(CWD, SESSION_ID, [out.jobId]);` — cobre `dispatch`
  e `dispatch_wait`, dedupado ou não.
- Em `dispatchWaitTool`, no branch terminal inline (linha 352-353), antes do
  `return summarize(job, false);`: gravar a chave terminal completa. NÃO
  tocar no branch de timeout (linha 356-357) — timeout não é entrega.
- Em `emitChannelEvents()`, no ramo `kind === "terminal"`: gravar a mesma
  chave terminal ao lado do `notify(...)`, e usar `ownedIds` (via
  `readOwned(CWD, SESSION_ID)`) ao chamar `channelKeys` nessa função também —
  assim o canal MCP para de empurrar eventos de sessões irmãs quando estiver
  ativo, não só o hook.
- Import novo: `recordOwned`, `readOwned` de `./lib/relay-owned.mjs`.

## Ordem de execução

1. `lib/relay-owned.mjs` (sem dependências dos outros passos).
2. `lib/relay-hook.mjs` (parâmetro opcional, testável isoladamente).
3. `bin/relay-stop-hook.mjs` (consome 1 e 2).
4. `server.mjs` (consome 1 e 2, corrige a duplicação).
5. Testes.

## Testes

**`tests/relay-hook.test.mjs`** (unidade, funções puras — estender):
- `channelKeys`/`hasInFlightFromAgent` com `ownedIds = null` → idêntico ao
  comportamento atual (fallback, sem regressão).
- `channelKeys` com `ownedIds` sem o id do job (mesmo `from === agentId`) →
  nenhum candidato terminal (Problema B).
- `channelKeys` com `ownedIds` contendo o id mas também a chave terminal
  completa → candidato excluído mesmo com o id presente (Problema A).
- `hasInFlightFromAgent` com `ownedIds` sem o id do job em-flight → `false`
  mesmo com `from === agentId` batendo.

**`tests/relay-hook.test.mjs`** (executável, via `runHook` já existente):
- Duas sessões (`session_id` diferentes), mesmo `RELAY_AGENT`: gravar
  owned-file de A com o id do job via `recordOwned`; `SessionStart`+`Stop`
  para A bloqueia, para B não.
- Sessão reinicia com novo `session_id`: comportamento de fallback
  documentado explicitamente como limitação aceita, não como bug.
- Owned-file ausente, ou `CLAUDE_CODE_SESSION_ID`/`RELAY_AGENT` ausentes
  isoladamente: cada ausência cai no comportamento de hoje.
- `session_id` divergente entre env e payload: hook loga o aviso em stderr
  (capturar via `execFileSync`) e usa o valor do env.

**`tests/relay-mcp-server.test.mjs`** (integração, processo real via
`startServer(env)`, injetando `CLAUDE_CODE_SESSION_ID`):
- `dispatch_wait` retorna terminal inline → `owned-<sessionId>.json` em disco
  contém o id nu do job E a chave terminal completa (ler via
  `resolveStateDir`/`fs.readFileSync`).
- Duas instâncias de servidor com o mesmo `RELAY_AGENT` mas
  `CLAUDE_CODE_SESSION_ID` diferentes: A despacha, owned-file de A tem o id,
  o de B não; estender o teste já existente que varia `RELAY_AGENT`
  (`tests/relay-mcp-server.test.mjs:682-683`) com essa variante de sessão.
- `dispatch` com `request_id` repetido por uma "segunda sessão" (segundo
  `startServer` com outro `CLAUDE_CODE_SESSION_ID`, mesmo
  `CLAUDE_PROJECT_DIR`): `deduped: true` E owned-file da segunda sessão
  também contém o job id (não fica órfã).
- Canal (`emitChannelEvents`) com duas sessões sob o mesmo `RELAY_AGENT`: B
  não recebe mais `notifications/claude/channel` do job de A.

**Rodar `npm test` ao final** — suíte atual mais os novos casos, todos verdes,
sem depender de `CLAUDE_CODE_SESSION_ID` real (só injetado nos testes) nem do
binário `codex`.
