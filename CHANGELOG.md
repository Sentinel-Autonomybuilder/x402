# Changelog

## 2026-04-14 — E2E Test Suite + Dashboard

### Added
- **E2E Test Suite** (`server/test/test-fresh-agent.mjs`) — Full end-to-end test that creates fresh EVM + Sentinel wallets, funds on Base, pays via x402 HTTP 402 protocol, provisions on Sentinel (MsgShareSubscription + MsgGrantAllowance), connects VPN via WireGuard, disconnects, and captures every on-chain TX with explorer links
- **Dashboard** (`dashboard/`) — Visual E2E flow dashboard showing the complete 17-step x402 flow with:
  - Live test runner (SSE streaming) — click "Run New E2E Test" to execute a real test with real-time step updates
  - All 5 on-chain transactions with Basescan/Mintscan explorer links
  - Wallet cards (agent EVM, agent Sentinel, operator)
  - Protocol flow diagram (Agent → x402 Server → Base → Sentinel → dVPN Node)
  - Fee grant details (balance, allowed messages, expiration)
  - Timeline visualization
  - Pricing cards
  - 12 clickable explorer/API links
- **E2E Test Results** (`E2E-FRESH-AGENT.txt`) — Cleaned output from live mainnet test run (2026-04-14), 17 steps, 5 TXs, all private info redacted
- **x402 Flow ELI5** (`X402-FLOW-ELI5.txt`) — Plain-language explanation of the x402 payment flow
- **Server README** (`server/README.md`) — Setup, env vars, API endpoints, architecture docs

### Changed
- **Server** (`server/src/index.ts`) — Fixed facilitator setup, added self-hosted facilitator support
- **Sentinel provisioning** (`server/src/sentinel.ts`) — Added subscription pool management, MsgShareSubscription field fix (camelCase/snake_case mismatch), retry on depleted subscriptions
- **Landing page** (`docs/index.html`) — Updated for Base mainnet, real contract address, improved styling
- **README** — Updated project description
- **MANIFESTO** — Minor updates
- **.gitignore** — Added `memory/` directory

### Technical Details
- x402 payment: HTTP 402 → EIP-3009 transferWithAuthorization → zero gas for agent
- Sentinel provisioning: atomic TX with MsgShareSubscription + MsgGrantAllowance
- Fee grant: 5M udvpn, 4 allowed message types, agent pays 0 gas on Sentinel
- VPN tunnel: direct agent↔node via WireGuard, x402 server never sees traffic
- All Sentinel chain queries via RPC (not LCD)
- Dashboard SSE endpoint streams steps in real-time at `/api/test/run`

### Test Results (Mainnet)
- Agent: 0x8FA1D47589841902d39e308d65799B36A27Df075 (Base) / sent1xn5cq84jt9pa82k3hadnr54xxvguj3f7jqkevw (Sentinel)
- Session: 39227850, WireGuard, Columbus US
- Cost: $0.033 USDC for 1 day
- Connect time: 25.9s
- Total E2E time: 70s
- 5 on-chain TXs (2 Base, 3 Sentinel)
