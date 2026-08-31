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
| Accessible Site Manager UI | Automated checks pending | Manual markup and keyboard-oriented implementation |
| WordPress connector plugin | Complete locally | PHP lint + credential self-test; real WP pairing pending |
| Credential rotation/disconnection | Pending | Old-token and cross-site rejection tests |
| Environment registry migration | Pending | Idempotent import test |
| Two real sites in one Brain conversation | Pending manual release check | ClickUp Brain MAX |
