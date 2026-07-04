# Backup da config global do Claude Code

Cópia de `~/.claude/` (fora deste repo, então não versionada por padrão) — os
subagentes e slash commands que orquestram o `agentrelay` a partir daqui.
Mantida sincronizada manualmente; não é lida em runtime.

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
