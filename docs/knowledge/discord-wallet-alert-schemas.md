# Discord channel digest — parse contract

Handoff for the Discord digest / confluence agent. Matches what this relay posts into Discord (Cielo Telegram → webhook embeds) plus other allowlisted grammars already documented in-repo.

## Scope

- **Input:** Discord channel messages in `channel_ids: string[]`
- **Transport:** read-only REST poll of message history (not Gateway). Research listener may write reactions/replies elsewhere — this digest must not share that write path.
- **Isolation:** fully separate from `wallets.json` / wallet watchlists. Identity comes from message text (`actor` label + optional wallet links), never from the relay’s wallet file.
- **Output:** normalized `TxEvent[]` → FOMO-style confluence (see below). No auto-research on sell-only evidence.

What posts into these channels today (from this repo): **Discord webhook embeds** with `embeds[0].description` + sidebar `color`. Parse **embed description text** first; fall back to `content` for human pastes / other bots.

There is no chain websocket payload in these channels — only Discord message text/embeds.

## Target schema

```ts
type Side = "buy" | "sell" | "transfer" | "receive" | "mint" | "position" | "unknown"

type TxEvent = {
  parser: "cielo_swap" | "cielo_transfer" | "cielo_receive" | "cielo_mint"
        | "asset_flow" | "hypercore_position" | "hypercore_twap" | "human_lossy"
  messageId: string
  channelId: string
  receivedAt: string // ISO
  actor: string // wallet label / entity name
  chain?: string // solana | ethereum | base | arbitrum | hypercore | ...
  side: Side
  // Primary token of interest for confluence (CA preferred)
  tokenContract?: string // Sol mint or 0x… EVM
  tokenSymbol?: string
  amountUsd?: string // keep as decimal string, do not float-parse for storage
  // Swap legs (when present)
  tokenIn?: string
  tokenOut?: string
  amountIn?: string
  amountOut?: string
  // Evidence quality
  confidence: "high" | "medium" | "low" // high = known bot grammar; low = human extract
  // Optional extras — do not require for confluence
  exchange?: string
  marketCap?: string
  age?: string
  txUrl?: string
  walletUrl?: string
  emojiHints?: string[] // raw leading emojis if still present in text
  embedColor?: number // Discord sidebar; see color→side map
}
```

## Parser allowlist (try in order; first match wins)

| Priority | Parser ID | When to use |
| --- | --- | --- |
| 1 | `cielo_swap` | line matches `Swapped … for …` |
| 2 | `cielo_transfer` / `cielo_receive` / `cielo_mint` | `Transferred:` / `Received:` / `Minted:` |
| 3 | `asset_flow` | `transferred assets on [Chain]` header |
| 4 | `hypercore_position` | `POSITION … · ASSET long\|short` |
| 5 | `hypercore_twap` | `TWAP · …` |
| 6 | `human_lossy` | else: CA + buy/sell keyword only |

Unrecognized → **drop** (do not invent side).

## 1) Known bot: Cielo classic (primary — this relay)

**Telegram raw** lives in `tests/fixtures/cielo/`. **Discord form** strips `#` from hashtags, removes color-circle emojis into embed sidebar, inlines links as `[label](<url>)`.

### Example A — SOL buy (🟢 → green sidebar `0x57f287`)

Telegram source:

```
#@game_for_one SOL by KP
🟢 Swapped 500 #USDT ($500) for 357.39K #SQUIRE On #OKX @ MC: $1.4m | Age: 125d
Token: EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA
#solana | 📊Trade | ViewTx | Wallet | Chart
```

Discord embed description (approx):

```
#@game_for_one SOL by KP
Swapped 500 USDT ($500) for 357.39K SQUIRE On OKX @ MC: $1.4m | Age: 125d
Token: EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA
solana | [📊Trade](<…>) | [ViewTx](<…>) | [Wallet](<…>) | [Chart](<…>)
```

Parse →

```json
{
  "parser": "cielo_swap",
  "actor": "@game_for_one SOL by KP",
  "chain": "solana",
  "side": "buy",
  "tokenContract": "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA",
  "tokenSymbol": "SQUIRE",
  "tokenIn": "USDT",
  "tokenOut": "SQUIRE",
  "amountIn": "500",
  "amountOut": "357.39K",
  "amountUsd": "500",
  "exchange": "OKX",
  "marketCap": "1.4m",
  "confidence": "high"
}
```

### Example B — EVM sell (🔴 → red sidebar `0xed4245`)

```
#game_for_one by KP
⭐️ 🔴 Swapped 8.73 #HTK ($728.88) for 0.38 #WETH On #UniswapV3 @ $83.52 | Age: 3687d
Token: 0xe5544a2a5fa9b175da60d8eec67add5582bb31b0
#ethereum | Cielo | ViewTx | Chart | X
```

Discord (approx):

```
game_for_one by KP
⭐️ Swapped 8.73 HTK ($728.88) for 0.38 WETH On UniswapV3 @ $83.52 | Age: 3687d
Token: 0xe5544a2a5fa9b175da60d8eec67add5582bb31b0
ethereum | [Cielo](<…>) | [ViewTx](<…>) | [Chart](<…>) | [X](<…>)
```

Parse → `side: "sell"`, `tokenContract: "0xe554…"`, `tokenIn: "HTK"`, `tokenOut: "WETH"`, `amountUsd: "728.88"`.

### Grammar (Discord-tolerant: `#` optional on tokens/chain)

```
Swapped {amountIn} [#]{tokenIn} ($(usd))? for {amountOut} [#]{tokenOut} (On [#]{exchange})? (trailer)
Token: {contract}
[#]{chain} | …
```

Amounts: `[\d,.]+[KMBkmb]?`

### Buy / sell inference (Cielo swap) — apply in order

1. **Embed color / leading emoji (if still in text):**
   - 🟢 / color `0x57f287` → **buy**
   - 🔴 / color `0xed4245` → **sell**
   - ➕ / color `0xfee75c` → **mint** (not confluence buy/sell)
2. Else **quote-asset heuristic** on legs:
   - `tokenIn` ∈ quote set AND `tokenOut` ∉ quote → **buy** (buying the Token: contract)
   - `tokenOut` ∈ quote set AND `tokenIn` ∉ quote → **sell**
   - Quote set (start): `SOL, WSOL, USDC, USDT, USD1, ETH, WETH, WBNB, BNB, DAI, USDbC, USDCet`
3. Else `side: "unknown"` — **exclude from confluence**

`Token:` line = contract of the **non-quote / alerted** token. That is the confluence key.

### Transfer / receive / mint (context only — not confluence)

```
#blknoiz06
Transferred: 6K #ANSEM ($1,027.14) to 5uWT...oCkq | MC: $171.2m | Age: 31d
Token: 9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump
#solana | Cielo | ViewTx
```

```
#bizyugo
➕ Minted: 36,120.55 #GS ($185.30)
Token: 0xb08d8becab1bf76a9ce3d2d5fa946f65ec1d3e83
#arbitrum | Cielo | ViewTx | X
```

→ `side: "transfer" | "receive" | "mint"`. Store for inbox/context; **never** count as bullish/bearish confluence.

## 2) Known bot: asset-flow / multi-profiler (Nansen · Cielo · Arkham style)

```
🔵 Erebos991 · Nansen | Debank | Cielo | Arkham | Hypurrscan transferred assets on Base · $1.88k
Received: 468934 Tao ($1.88k) from 0xbc7f...2b31
#base | ViewTx
```

```
🔵 Erebos991 · Nansen | Cielo transferred assets on Base · $500
Transferred: 100 USDC ($100) to 0xabcd...ef01
#base | ViewTx
```

- Header: `{emoji}? {actor} · {profilers} transferred assets on {Chain} · ${total}`
- Detail: `Received:` → inbound; `Transferred:` / `Sent:` → outbound
- Usually **no** `Token:` CA — symbol only; `confidence: "medium"`, confluence only if CA recoverable from links/elsewhere
- 🔵 is informational, **not** buy/sell

See also `docs/knowledge/telegram-alert-schemas.md`.

## 3) Known bot: HyperCore position / TWAP

```
🟠 TheCryptoNexus · Nansen | Debank | Cielo | Arkham | Hypurrscan
POSITION REDUCED · ETH short
Closed 130.7 ETH · $250k · avg $1.91k
5 fills consolidated
#hypercore | ViewWallet
```

Emoji map:

| Emoji | Meaning |
| --- | --- |
| 🟢 | open/increase long |
| 🔴 | open/increase short |
| 🟣 | close/decrease long |
| 🟠 | close/decrease short |

→ `side: "position"`, `confidence: "high"`. **Not** spot buy/sell confluence unless product explicitly maps perps later.

TWAP template:

```
🟢/🔴/🟠/🟣 {ENTITY} · {profilers}
TWAP · OPENING/REDUCING LONG|SHORT · {ASSET}
Target {SIZE} {ASSET} over {DURATION}
#hypercore | ViewWallet
```

## 4) Human paste (lossy fallback)

Only if no bot grammar matched:

1. Extract first CA: Sol base58 32–44 chars **or** `0x` + 40 hex
2. Side from keywords (case-insensitive):
   - buy / long / ape / entry / accumulating → `buy`
   - sell / short / exit / dump / trimming → `sell`
3. Actor = message author username (Discord), not wallet label
4. `confidence: "low"` — optional weak confluence weight (recommend weight 0 or exclude until proven)

## FOMO confluence rules

Window: configurable (e.g. last N minutes / last M messages per channel).

Group key: **`tokenContract` (required)**. Symbol-only events do not join confluence.

| Condition | Signal |
| --- | --- |
| ≥ K distinct `actor`s with `side === "buy"` on same CA | **Bullish confluence** (+ optional research enqueue) |
| ≥ K distinct `actor`s with `side === "sell"` on same CA | **Bearish evidence** — inbox/context only, **no** auto-research |
| Zero matching activity in window | **Never bearish** (silence ≠ sell) |
| Only transfers/mints/positions | No confluence |
| `side === "unknown"` | Excluded |

Dedup: same `(channelId, messageId)` once. Same actor + same CA + same side within short TTL → count once.

## Discord REST poll notes

- Read `embeds[].description` (+ `embeds[].color`); also scan `content`
- Ignore bot’s own messages / research replies if identifiable
- Links may be `[ViewTx](<https://…>)` — extract URL from markdown
- Color map used by this relay:

| Emoji | Color | Meaning for spot |
| --- | --- | --- |
| 🟢 | `0x57f287` | buy |
| 🔴 | `0xed4245` | sell |
| ➕ | `0xfee75c` | mint |
| 🔵 | `0x3498db` | info / asset-flow |
| 🟠 / 🟣 | `0xe67e22` / `0x9b59b6` | HyperCore close/↓ |
| none | `0x99aab5` grey | unknown — do not assume side |

## Canonical regexes (this repo)

Reuse / port from `src/parsers/cielo.ts` + fixtures in `tests/fixtures/cielo/`. Live relay does **not** run these parsers outbound — Discord text is nearly verbatim after hashtag/emoji strip — so the same grammars work on Discord descriptions if `#` is made optional.

Detection heuristic already used: `/(?:Swapped|Transferred:|Received:|Minted:)/u`

## Out of scope / do not assume

- No chain websocket payload in these channels — only Discord message text/embeds
- No Arkham-native JSON schema in-repo (Arkham appears as a **profiler link label** in asset-flow headers)
- No structured buy/sell Discord templates from this relay (ADR-0002 rejected them — text is preserved)
- Do not couple to `wallets.json`

## Minimal golden tests

1. SOL swap 🟢 + Token mint → buy confluence candidate
2. ETH swap 🔴 + Token 0x → sell evidence only
3. Transfer with Token → not confluence
4. Asset-flow receive without Token → medium confidence, no confluence
5. HyperCore POSITION → position, no spot confluence
6. Human “buying `EN2nnx…`” → low confidence buy
7. Empty window → never emit bearish
