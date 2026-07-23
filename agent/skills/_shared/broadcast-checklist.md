# Broadcast checklist

When a job may broadcast, write **only** this envelope in `outbox/<run-id>.json`
(host rejects anything else):

```json
{
  "schema": 1,
  "items": [
    {
      "severity": "watch",
      "text": "≤280 chars, voice rules in AGENTS.md",
      "refs": ["state/narratives/log.jsonl", "inbox/<run-id>/twitter-fyp.json"],
      "auditClaim": {
        "type": "narrative-emergence",
        "subject": "slug-or-token",
        "direction": "up",
        "horizonHours": 72,
        "verificationRule": "narrative.emergence"
      }
    }
  ]
}
```

Never use a top-level `broadcasts` key or a bare `text` field. `text` must be ≤280
chars. **One `BroadcastItem` per normalized `auditClaim.subject` per run** — if
multiple pieces of evidence support one current development, merge the concrete
facts into that item's `text`. Do not emit reworded variants for the same subject;
the host groups same-subject items and sends only one Telegram topic deep-dive.
`refs` must be `state/…` or same-run `inbox/<run-id>/…` paths that already
exist as frozen regular files (host rejects traversal, cross-run, missing, and
mutable refs; same-run inbox refs are canonicalized to sealed archive paths before
ingress). Known `verificationRule` values include `narrative.emergence`,
`narrative.fade`, `narrative.development`, `rotation`, `token.up.72h`,
`token.down.72h`, `sentiment.collapse`.

For any notable concrete update inside a narrative already in
`state/narratives/log.jsonl` (product/ecosystem catalyst, revenue or usage
change, material mcap/tape move, identity/security risk, or names/leaders
moving), use `type: "narrative-development"` with `direction: "rotation"`,
`verificationRule: "narrative.development"`, subject = the narrative slug. Do not
restate the narrative's stage in `text`, and only propose when the catalyst or
update is new — the host rejects developments that repeat a recent accepted
broadcast on the same narrative.

**Founder / protocol primary-source catalysts must broadcast.** When sealed
inbox evidence includes a founder, CEO, protocol official, or official project
channel announcing a material product, wallet, protocol, ecosystem, or
distribution catalyst, write one outbox item in that run — do not wait for CT
cluster convergence or an existing narrative stage shift. Open a new
`narrative-emergence` slug when none matches (honour prior tickers / rebrands);
use `narrative-development` when a matching slug already exists. Empty outbox is
fine only for ordinary noise, never for a founder primary-source catalyst.

Read `state/narratives/log.jsonl` first: do **not** restate a narrative's known
stage (e.g. omit "RH still peaking" when it is already peaking). Mention heat
only when it drops or increases; host rejects status-quo stage restatements.
