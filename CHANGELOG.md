# Changelog

All notable changes to **Agent Advisor for Orca** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-26

### Added
- **Invisible Two-Tier Advisor (`advisor` MCP tool):** Brings a Claude Code `/advisor`-style workflow to any agent in Orca (`Grok`, `OpenCode`, `Codex`, `Claude Code`, `Gemini`, `Kilocode`, `Cline`, `Antigravity`).
- **Zero-Tab Headless Providers:** Silent background read-only execution for `Codex`, `Claude`, `Grok`, `Gemini`, plus direct APIs (`OpenRouter`, `Anthropic`, `OpenAI / Compatible`) and native Orca agent fallback.
- **Zero-Config Auto-Setup:** Automatically registers the `advisor` MCP bridge across installed local agents and installs the global `/advisor` skill on startup.
- **Live Model & Effort Pickers:** Automatically pulls real user-available models (`~/.codex/models_cache.json`, `grok models`, `opencode models`, `kilo models`, `~/.claude/settings.json` + `/v1/models`, OpenRouter, Anthropic, OpenAI) with direct `Thinking / Effort` control (`low`, `medium`, `high`, `xhigh`, `max`).
- **Minimal Control Panel:** Single-screen Orca Components panel with On/Off switch, Provider, Model, Thinking/Effort, Advisor level presets (`Rare` / `Balanced` / `Frequent`), and EN/RU localization.
- **Guardrails & Persistent Threads:** Per-workspace branch threads stored in `orca.storage`, secret redaction, path traversal protection, `agent.tool.after` loop detector, and `agent.status.changed` post-finish diff checks.
- **Editorial Brand Identity:** Custom minimalist icon (`assets/icon.png`), transparent panel mark (`assets/mark.png`), and Swiss-editorial cover (`assets/cover.jpg`).
