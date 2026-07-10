# Backup da config global do Claude Code

Cópia de `~/.claude/` (fora deste repo, então não versionada por padrão) — os
subagentes e slash commands que orquestram o `agentrelay` a partir daqui.
Mantida sincronizada manualmente; não é lida em runtime.

## O que tem aqui

**Subagentes** (`agents/`, invocados via tool `Agent`, não por `/comando`):

| agente | uso |
|---|---|
| `deep-reasoner` | raciocínio pesado — decisões de arquitetura, bugs sutis/complexos, trade-offs |
| `fable-reasoner` | segunda lente de raciocínio, família de modelo diferente — roda em paralelo ao `deep-reasoner`, nunca no lugar dele |
| `fast-worker` | trabalho mecânico — boilerplate, edits repetitivos, refactors diretos |

**Slash commands** (`commands/`; qualquer `.md` em `~/.claude/commands/` vira
skill automaticamente, invocável com `/<nome-do-arquivo>`):

| comando | uso |
|---|---|
| `/codex-r` | despacha revisão de código pro Codex via agent relay (background), devolve veredito |
| `/codex-i` | despacha implementação pro Codex via agent relay (worktree isolada, background) |
| `/orchestrate` | workflow completo: aciona os 3 subagentes acima + Codex em paralelo pra revisão de plano e/ou delegação de execução |

A política de quando usar cada um está em `CLAUDE.md` (seção "Orchestration
workflow").

Restaurar numa máquina nova:

```bash
cp docs/claude-global-config/agents/*.md ~/.claude/agents/
cp docs/claude-global-config/commands/*.md ~/.claude/commands/
cp docs/claude-global-config/CLAUDE.md ~/.claude/CLAUDE.md
```

Não inclui `~/.claude/settings.json` (registro de MCP servers, hooks,
permissões, env vars como `RELAY_AGENT`) nem `.credentials.json` — o primeiro
tem dados de outros projetos/plugins misturados, o segundo é sensível. O
`settings.json` também é redundante com o próprio `README.md` deste repo
(seção de install), que já documenta como plugar o `agentrelay` e o Stop hook
do zero.
