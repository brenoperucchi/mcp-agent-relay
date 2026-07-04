---
description: Inicia o workflow de orquestração multi-agente (deep-reasoner=Opus, fable-reasoner=Fable 5, fast-worker=Sonnet, codex via MCP agent relay) para uma necessidade ou plano — cobre revisão do plano em paralelo e/ou delegação da execução.
argument-hint: '[review|exec] <necessidade ou plano> — sem prefixo roda o fluxo completo; "review" só valida um plano; "exec" só delega execução de um plano já aprovado'
allowed-tools: Agent, mcp__agentrelay__dispatch_wait, mcp__agentrelay__poll
---

Você é o orquestrador (a regra já vale por padrão via `CLAUDE.md` global —
este command só torna explícito e força o disparo real dos agentes numa única
tacada). Nunca implemente nem revise você mesmo o que deveria ser delegado.

Entrada do usuário: `$ARGUMENTS`

## Modo

Olhe o início de `$ARGUMENTS`:
- Começa com `review ` → **modo revisão de plano** (Seção A). O resto do texto
  após `review ` é a necessidade ou o plano a validar.
- Começa com `exec` (sozinho ou seguido de texto) → **modo execução** (Seção
  B), pulando a revisão. Use o plano já presente nesta conversa (ex: recém
  aprovado, ou saído de Plan Mode); se não houver nenhum plano identificável
  e nada além de "exec" foi passado, pare e pergunte qual plano executar —
  não invente escopo.
- Qualquer outra coisa → **fluxo completo**: Seção A seguida de Seção B, com
  aprovação explícita do usuário entre as duas.

## Seção A — Revisão do plano (deep-reasoner + fable-reasoner + codex em paralelo)

1. Se `$ARGUMENTS` for uma necessidade (não um plano já pronto), esboce você
   mesmo um plano de implementação primeiro — curto, mas concreto (arquivos,
   etapas, riscos).
2. Dispare em **paralelo**, na mesma resposta, sem que nenhum veja a resposta
   dos outros:
   - Um subagente `deep-reasoner` (via Agent tool) com o plano completo,
     pedindo riscos, lacunas e alternativas melhores.
   - Um subagente `fable-reasoner` (via Agent tool) com o mesmo plano e o
     mesmo pedido — é um modelo de família diferente, então serve de segunda
     lente independente, não de substituto do deep-reasoner.
   - Um dispatch pro `codex` via `mcp__agentrelay__dispatch_wait` com o mesmo
     plano, pedindo a mesma crítica — se o `agentrelay` não estiver conectado
     nesta sessão, pule só este braço e avise; os outros dois seguem normal.
3. Sintetize as críticas você mesmo — não repasse as respostas cruas. Ajuste
   o plano com o que fizer sentido de cada uma, e note se elas convergiram
   (mais confiança) ou divergiram (investigue o ponto de discórdia antes de
   decidir).
4. Mostre o plano final revisado ao usuário e peça aprovação explícita antes
   de seguir pra Seção B. Se o modo era só "review", pare aqui.

## Seção B — Delegação de execução

1. Quebre o plano aprovado em etapas e classifique cada uma:
   - **Mecânica** (boilerplate, testes de comportamento já decidido,
     formatação, edições repetitivas) → subagente `fast-worker`.
   - **Julgamento/arquitetura/bug sutil** → subagente `deep-reasoner`.
   - **Perspectiva fresca de par sênior** → dispatch pro `codex` via
     `mcp__agentrelay__dispatch_wait`.
   - **Alto risco ou ambígua** mesmo depois da Seção A → repita o paralelo
     deep-reasoner + fable-reasoner + codex nessa etapa específica antes de
     executá-la.
   - **Trivial demais** pra valer um subagente (ex: 1 rename, 1 linha) → faça
     direto, sem forçar delegação.
2. Mostre esse mapeamento etapa → responsável antes de disparar qualquer
   subagente.
3. Execute a delegação. Nos braços `codex`, use `dispatch_wait` com
   `timeout_ms` generoso; se estourar, informe que o job segue em background
   sob o `job_id` e que o Stop hook avisa quando terminar.
4. Ao final, resuma o que cada responsável entregou — não só "feito".

## Pré-requisitos

- Precisa dos subagentes `deep-reasoner`, `fable-reasoner` e `fast-worker`
  registrados (`/agents` pra conferir) — se algum não existir, avise e não
  invente o comportamento dele no lugar; siga com os que existirem.
- O braço `codex` depende do `agentrelay` MCP conectado e de um worker `codex`
  ativo drenando a fila — se `dispatch_wait` voltar com `timed_out: true` e
  `state: "queued"`, avise que o worker não está rodando.
