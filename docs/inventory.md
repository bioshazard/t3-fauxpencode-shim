# Static OpenCode inventory

Corpus: `t3code-9b2d0431-opencode-9f69463f-pi-0.84.4`

Pinned T3: `9b2d04317c68233782e0630464ac86d77d0686f3`  
Pinned OpenCode: `9f69463f1d556af2b5b51d2efa1c04f5f544f911`

Generated from `contracts/inventory.json`; edit the JSON, then run `bun run contract:inventory`.

| ID | Operation | Transport | Method | Path | Support | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| OC-CLI-0001 | opencode --version | process | exec | — | required | apps/server/src/provider/Layers/OpenCodeProvider.ts:394 (checkOpenCodeProviderStatus) |
| OC-HTTP-0001 | global.health | http | GET | `/global/health` | required | apps/server/src/provider/opencodeRuntime.ts:144 (verifyOpenCodeServerVersion)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:1326 (Global.health) |
| OC-HTTP-0002 | provider.list | http | GET | `/provider` | required | apps/server/src/provider/opencodeRuntime.ts:837 (loadProviders)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:3320 (Provider.list) |
| OC-HTTP-0003 | app.agents | http | GET | `/agent` | required | apps/server/src/provider/opencodeRuntime.ts:853 (loadAgents)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:580 (App.agents) |
| OC-HTTP-0004 | app.skills | http | GET | `/skill` | required | apps/server/src/provider/opencodeRuntime.ts:859 (loadSkills)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:609 (App.skills) |
| OC-SSE-0001 | event.subscribe | sse | GET | `/event` | required | apps/server/src/provider/Layers/OpenCodeAdapter.ts:2235 (startEventPump)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:1410 (Event.subscribe) |
| OC-HTTP-0005 | session.create | http | POST | `/session` | required | apps/server/src/provider/Layers/OpenCodeAdapter.ts:2406 (startSession)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:3399 (Session.create) |
| OC-HTTP-0006 | session.get | http | GET | `/session/{sessionID}` | required | apps/server/src/provider/Layers/OpenCodeAdapter.ts:1489 (isRelatedOpenCodeSession)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:3516 (Session.get) |
| OC-HTTP-0007 | session.update | http | PATCH | `/session/{sessionID}` | conditional | apps/server/src/provider/Layers/OpenCodeAdapter.ts:2365 (startSession)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:3559 (Session.update) |
| OC-HTTP-0008 | session.fork | http | POST | `/session/{sessionID}/fork` | conditional | apps/server/src/provider/Layers/OpenCodeAdapter.ts:2382 (startSession)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:3897 (Session.fork) |
| OC-HTTP-0009 | session.messages | http | GET | `/session/{sessionID}/message` | required | apps/server/src/provider/Layers/OpenCodeAdapter.ts:3074 (readThread)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:3731 (Session.messages) |
| OC-HTTP-0010 | session.message | http | GET | `/session/{sessionID}/message/{messageID}` | conditional | apps/server/src/provider/Layers/OpenCodeAdapter.ts:1193 (schedulePromptAdmissionRecovery)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:3829 (Session.message) |
| OC-HTTP-0011 | session.status | http | GET | `/session/status` | required | apps/server/src/provider/Layers/OpenCodeAdapter.ts:1027 (scheduleIdleReconciliation)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:3484 (Session.status) |
| OC-HTTP-0012 | session.promptAsync | http | POST | `/session/{sessionID}/prompt_async` | required | apps/server/src/provider/Layers/OpenCodeAdapter.ts:2687 (sendTurn)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:4095 (Session.promptAsync) |
| OC-HTTP-0013 | session.abort | http | POST | `/session/{sessionID}/abort` | required | apps/server/src/provider/Layers/OpenCodeAdapter.ts:703 (abortOpenCodeSessionForTeardown)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:3913 (Session.abort) |
| OC-HTTP-0014 | session.revert | http | POST | `/session/{sessionID}/revert` | required | apps/server/src/provider/Layers/OpenCodeAdapter.ts:3111 (rollbackThread)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:4286 (Session.revert) |
| OC-HTTP-0015 | permission.list | http | GET | `/permission` | conditional | apps/server/src/provider/Layers/OpenCodeAdapter.ts:1717 (handleSubscribedEvent)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:3087 (Permission.list) |
| OC-HTTP-0016 | permission.reply | http | POST | `/permission/{requestID}/reply` | conditional | apps/server/src/provider/Layers/OpenCodeAdapter.ts:3010 (respondToRequest)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:3125 (Permission.reply) |
| OC-HTTP-0017 | question.list | http | GET | `/question` | conditional | apps/server/src/provider/Layers/OpenCodeAdapter.ts:1718 (handleSubscribedEvent)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:2985 (Question.list) |
| OC-HTTP-0018 | question.reply | http | POST | `/question/{requestID}/reply` | conditional | apps/server/src/provider/Layers/OpenCodeAdapter.ts:3032 (respondToUserInput)<br>packages/sdk/js/src/v2/gen/sdk.gen.ts:3016 (Question.reply) |
| OC-HTTP-0019 | mcp.add | http | POST | `/mcp` | conditional | apps/server/src/provider/Layers/OpenCodeAdapter.ts:2322 (startSession)<br>packages/sdk/js/src/v2/gen/types.gen.ts:8461 (McpAddData) |
| OC-CLI-0002 | models --verbose | process | exec | — | conditional | apps/server/src/provider/opencodeRuntime.ts:880 (loadInventoryFromCli) |
| OC-CLI-0003 | agent list | process | exec | — | conditional | apps/server/src/provider/opencodeRuntime.ts:886 (loadInventoryFromCli) |
| OC-CLI-0004 | debug skill | process | exec | — | conditional | apps/server/src/provider/opencodeRuntime.ts:892 (loadInventoryFromCli) |

## Event discriminators

- `server.connected`
- `session.created`
- `session.updated`
- `session.deleted`
- `message.updated`
- `message.removed`
- `message.part.delta`
- `message.part.updated`
- `permission.asked`
- `permission.replied`
- `question.asked`
- `question.replied`
- `question.rejected`
- `session.status`
- `session.error`
