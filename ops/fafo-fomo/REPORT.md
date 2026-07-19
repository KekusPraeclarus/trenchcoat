# FAFO Fomo web probe report

**Probe run:** scaffold  
**Evaluated:** 2026-07-19  
**Source:** authenticated Playwright against fomo.family  
**Verification status:** scaffolding ready (run `pnpm probe:fomo discover`)

## Summary

The unofficial third-party HTTP bridge is removed. Integration is a read-only
Playwright collector with host-only burner profile under
`~/.trenchcoat/fomo-profile/`.

## Gate seeds

See [gates.seed.json](gates.seed.json). All capabilities start as
`insufficient-sample` / provider `fail` until a live probe evaluates them.

## Resume

```bash
pnpm probe:fomo discover --run-id probe-YYYY-MM-DD
pnpm probe:fomo sample --run-id probe-YYYY-MM-DD --duration-hours 24 --interval-minutes 30
pnpm probe:fomo sanitize --run-id probe-YYYY-MM-DD
pnpm probe:fomo evaluate --run-id probe-YYYY-MM-DD
```
