# Admin API contract

Served by the gateway under `/admin/api`. All responses are JSON unless stated.
Authentication: `x-admin-token: <token>` **or** `Authorization: Bearer <token>`.
When no admin token is configured, only loopback requests are accepted.

Errors use the same envelope as the public API: HTTP status + `{ "error": { "message", "type", "code" } }`.

---

## Overview

`GET /admin/api/overview`

```json
{
  "version": "0.1.0",
  "uptimeMs": 123456,
  "accounts": { "total": 3, "active": 2, "muted": 1, "reauth": 0, "disabled": 0, "warm": 2 },
  "keys": { "total": 2, "active": 2 },
  "usage": { "requests": 120, "errors": 3, "promptChars": 900000, "outputChars": 12000,
             "avgLatencyMs": 4200, "toolCalls": 12,
             "byAccount": [{ "accountId": "…", "requests": 80, "errors": 1 }],
             "byDay": [{ "day": "2026-10-24", "requests": 40, "errors": 0 }] },
  "config": { "port": 8787, "host": "127.0.0.1", "headless": true, "accountRpm": 20,
              "accountMinGapMs": 1500, "sessionCleanup": false, "home": "D:\\…\\data" },
  "recent": [ { "ts": 1790000000000, "endpoint": "/v1/chat/completions", "model": "deepseek-chat",
                "status": "ok", "httpStatus": 200, "latencyMs": 3200, "accountId": "…",
                "keyId": "…", "toolCalls": 0, "errorKind": null } ]
}
```

## Accounts

`GET /admin/api/accounts` → array of:

```json
{
  "id": "uuid", "label": "main", "email": "a@b.c", "status": "active",
  "deviceId": "uuid", "did": "uuid", "userId": "uuid",
  "warm": true, "hasPassword": false,
  "mutedUntil": null, "cooldownUntil": null,
  "createdAt": 1790000000000, "lastUsedAt": 1790000000000, "lastError": null,
  "profileDir": "D:\\…\\profiles\\slug", "capturedAt": "2026-10-24T13:00:00.000Z"
}
```

`POST /admin/api/accounts` — start a capture (opens a visible browser window).

```json
{ "label": "main", "email": "a@b.c", "password": "optional", "timeoutMs": 900000 }
```
→ `201 { "account": {…}, "capture": {…} }` (the account exists immediately as `status: "reauth"`).

`GET /admin/api/accounts/:id/capture`

```json
{ "accountId": "uuid", "phase": "waiting", "message": "sign in in the browser window",
  "startedAt": 1790000000000, "finishedAt": null, "error": null }
```
`phase` ∈ `opening | waiting | detected | verifying | done | failed`. When no capture is running → `{ "accountId": "uuid", "phase": "idle" }`.

`POST /admin/api/accounts/:id/cancel-capture` → `{ "cancelled": true }`

`POST /admin/api/accounts/:id/relogin` → same body as create-capture, for an existing account.

`POST /admin/api/accounts/:id/check` → `{ "ok": true, "status": 200 }` or `{ "ok": false, "message": "…" }`.

`PATCH /admin/api/accounts/:id` — `{ "label"?: string, "disabled"?: boolean, "rpmLimit"?: number | null }` → updated account.

`DELETE /admin/api/accounts/:id` → `{ "deleted": true }` (closes the browser, keeps history rows).

## API keys

`GET /admin/api/keys` → array:

```json
{ "id": "uuid", "name": "laptop", "prefix": "sk-dswg-AbCdEf", "accountIds": ["uuid"],
  "models": [], "rpm": null, "createdAt": 1790000000000, "lastUsedAt": null, "revokedAt": null }
```

`POST /admin/api/keys` — `{ "name": "laptop", "accountIds": ["uuid"], "models": [], "rpm": null }`
→ `201 { "key": {…}, "secret": "sk-dswg-…" }` — the secret is returned exactly once.

`PATCH /admin/api/keys/:id` — `{ "name"?, "accountIds"?, "models"?, "rpm"? }` → updated key.

`POST /admin/api/keys/:id/revoke` → `{ "revoked": true }`.

`DELETE /admin/api/keys/:id` → `{ "deleted": true }` — removes the row entirely.

`POST /admin/api/keys/clear-revoked` → `{ "deleted": 14 }` — drops every revoked key.

## Usage

`GET /admin/api/usage?hours=24&limit=100` →

```json
{ "summary": { …same as overview.usage… },
  "recent": [ { "id": "uuid", "ts": 1790000000000, "keyId": "uuid", "accountId": "uuid",
                "endpoint": "/v1/messages", "model": "deepseek-reasoner", "status": "ok",
                "httpStatus": 200, "errorKind": null, "promptChars": 1200, "outputChars": 300,
                "toolCalls": 1, "latencyMs": 4000, "ttfbMs": 900, "stream": true } ] }
```

## Logs

`GET /admin/api/logs?limit=200&minutes=1440&accountId=&kind=&turnId=` →

```json
{
  "counts": [ { "kind": "turn.http", "count": 12 }, { "kind": "turn.start", "count": 4 } ],
  "events": [
    { "id": "uuid", "ts": 1790000000000, "kind": "turn.start",
      "accountId": "uuid", "turnId": "QxcxxB--Ha41",
      "data": { "model": "deepseek-chat", "promptChars": 1202, "gapMs": 8400, "deviceId": "uuid", "…": "…" } }
  ]
}
```

`kind` is one of `turn.start`, `turn.http`, `turn.end`, `turn.verdict`,
`turn.retry`, `account.state`, `account.identity`.

`GET /admin/api/logs/export?minutes=1440&limit=5000` → the same window as
`application/x-ndjson`, one event per line, oldest first, with a
`content-disposition` filename so a browser downloads it.

## Corpus, leaks and learned patterns

`GET /admin/api/corpus?limit=100` → `{ "turns": [ { "turnId", "ts", "model", "tools", "streamChars", "textChars", "leaked", "salvaged", "path", "sha256" } ] }`

`GET /admin/api/corpus/:turnId` → `{ "raw": "…sse…", "text": "…", "thinking": "…" }`

`GET /admin/api/leaks?limit=50` → `{ "leaks": [ { "id", "ts", "turnId", "accountId", "kind", "evidence", "text" } ] }`

`GET /admin/api/patterns` → `{ "patterns": [ { "id", "opener", "closer", "score", "origin", "createdAt", "uses" } ] }`

`DELETE /admin/api/patterns/:id` → `{ "deleted": true }`

`POST /admin/api/mine` — `{ "minSamples": 2, "apply": true, "limit": 300 }` →

```json
{ "leaks": 4, "prose": 12,
  "proposals": [ { "opener": "BEGIN_CALL", "closer": "END_CALL", "hits": 4, "falsePositives": 0, "score": 4, "samples": ["…"] } ],
  "stored": [ { "id": "…", "opener": "BEGIN_CALL", "closer": "END_CALL", "score": 4 } ] }
```

## Models

`GET /admin/api/models` →

```json
[ { "id": "deepseek-chat", "label": "DeepSeek Instant", "thinking": false, "search": false, "default": true },
  { "id": "deepseek-reasoner", "label": "DeepSeek Thinking", "thinking": true, "search": false, "default": false },
  { "id": "deepseek-search", "label": "DeepSeek Search", "thinking": false, "search": true, "default": false },
  { "id": "deepseek-reasoner-search", "label": "DeepSeek Thinking + Search", "thinking": true, "search": true, "default": false } ]
```

## Account screenshot

`GET /admin/api/accounts/:id/screenshot` → `image/png` of the live profile page (404 when the profile is not warm).

## Static UI

`GET /admin` → the dashboard (`ui/index.html`), with `ui/app.js` and `ui/styles.css` served alongside.
