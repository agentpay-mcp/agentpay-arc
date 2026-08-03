# Hosted Arc journey runner

This runner is the production-shaped caller for the P0-2 story. It keeps the
hosted MCP surface honest: the hosted endpoint currently exposes wallet and
receipt tools, while the offer feed and protected result are served by the
explicit service contract below. A fixture or simulated run is not Arc
transaction proof.

## Contract

`ARC_JOURNEY_OFFERS_URL` must return HTTPS JSON with at least two offers:

```json
{
  "observedAt": "2026-08-03T08:00:00.000Z",
  "offers": [
    {
      "id": "service-a",
      "priceUsdc": "0.010000",
      "token": "USDC",
      "chainId": 5042002,
      "endpointDomainVerified": true,
      "feedbackCount": 10,
      "averageScore": 4.8,
      "recipient": "0x…40 hex characters…",
      "resultUrl": "https://seller.example/result"
    }
  ]
}
```

Every result URL must be HTTPS and belong to the configured service-origin
allowlist. After a hosted receipt is terminal, the runner sends the service
and transaction binding as headers and requires the protected endpoint to
return:

```json
{
  "serviceId": "service-a",
  "transactionId": "circle-transaction-id",
  "content": "the paid result"
}
```

The content is returned only when both identities match exactly. The trace
stores a SHA-256 digest, not the result body.

## Live run guard

The command refuses to run unless all of these are present:

```bash
ARC_JOURNEY_LIVE=1
ARC_JOURNEY_CONFIRM=I_UNDERSTAND_ARC_TESTNET_PAYMENT
ARC_JOURNEY_MCP_URL=https://mcp.arc.agentpay.site/mcp
ARC_JOURNEY_OFFERS_URL=https://…
ARC_JOURNEY_SERVICE_ORIGINS=https://seller.example,https://another-seller.example
ARC_JOURNEY_ACCESS_TOKEN=…
ARC_JOURNEY_IDEMPOTENCY_KEY=<fresh UUID-v4>
ARC_RELEASE_SHA=<exact deployed commit>
npm run journey:arc
```

The hosted MCP `/healthz` response must expose the same `releaseSha`. The
deployment validator requires `ARC_RELEASE_SHA`, and the production entrypoint
also matches it to the immutable release directory it is running from; the
runner fails before reading the wallet when the observed commit is absent or
different. The resulting trace keeps both the requested and observed SHA plus
the health origin.

The access token is read only from the environment and is never included in
the trace or error text. The command performs a single `send_usdc` call, then
re-reads `get_payment_receipt`; unknown or ambiguous states stop in
`PAYMENT_UNRESOLVED` and never fetch the protected result. A real run still
requires separate human authorization for OAuth credentials, funded testnet
USDC, and the seller deployment.

## Simulated CI evidence

The deterministic tests inject an MCP client and `fetch`. They assert the
decline branch, insufficient-balance stop, receipt reconciliation, result
binding, bounded offer count, transaction-hash agreement, and live guard. Their `SIMULATED` label must not
be changed to `LIVE` in a recording or submission without a fresh exact-SHA
transaction and receipt verification.
