# Feature Registry

| Feature | Status | Verification |
|---|---|---|
| Four-tool stateless MCP gateway | Complete | `node scripts/selftest.js` |
| Runtime upstream tool discovery | Complete | Offline fake-site routing checks |
| Write, live-root, and read-only guardrails | Complete | Offline guardrail checks |
| `SITES` and JSON registry loaders | Complete | Offline gateway boot checks |
| Hostinger MySQL foundation | Complete locally | Docker migration + idempotency checks |
| Encrypted database registry | Complete locally | 8-check persistence and fallback suite |
| One-time host-bound pairing codes | Complete locally | 7-check callback and replay suite |
| Protected Site Manager API | Complete locally | 401/200 authorization smoke check |
| Accessible Site Manager UI | Complete locally; screen reader pass pending | Accessibility-lead reviewed markup, focus, and live regions |
| WordPress connector plugin | Complete | PHP lint, 20 credential checks, real WordPress + Novamira pairing |
| Dispatched-route credential scoping | Complete | Playground: `?rest_route=`, form body, other routes, front end all refused |
| Re-pair in place, remove, disconnect from WordPress | Complete | 33-check pairing suite + HTTP lifecycle suite + real WordPress |
| Upstream session and tool-name recovery | Complete | `selftest:upstream` + real Novamira session wipe |
| Database retry and periodic refresh | Complete | Code review; manual outage test pending |
| Connector self-update | Complete | Update URI offer, digest and package checks in real WordPress; first real release pending |
| Environment registry migration | Pending | Idempotent import test |
| Two real sites in one Brain conversation | Pending manual release check | ClickUp Brain MAX |
