# AGENTS.md

本檔案供 AI 編碼代理（coding agent）參考。

## Agent skills

### Issue tracker

議題追蹤在 GitHub Issues，所有操作透過 `gh` CLI 執行。 See `docs/agents/issue-tracker.md`.

### Triage labels

沿用五個預設英文標籤（`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`）。 See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：根目錄一份 `CONTEXT.md`，決策記錄放在 `docs/adr/`。 See `docs/agents/domain.md`.
