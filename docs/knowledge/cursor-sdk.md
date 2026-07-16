---
description: Provider knowledge — Cursor SDK local runtime, sandbox, model probe.
scope: project
status: active
---

# Cursor SDK / sandbox

- Package: `@cursor/sdk`
- Model target: `composer-2.5`
- Runtime: local; explicit `CURSOR_API_KEY`; empty setting sources; dispose after wait
- Sandbox enabled for agent tools; supervisor egress stays outside tool policy
- Outer Linux container mounts only `agent/`; Cursor sandbox alone does not satisfy INV-I1
- Scrub tool env of secrets; deny `/tmp` writes and agent-tool networking
- One-shot sessions for jobs/classifiers; resumable create/send/resume only for chat
- Never interpolate scraped text into prompts — path references only
