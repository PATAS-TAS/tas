# API Migration Guide

We are introducing a new response schema alongside the legacy fields to enable a smooth migration.

## Timeline
- Deprecation header: `Deprecation: true`
- Sunset header: `Sunset: <YYYY-MM-DD>` (6 months from first release)
- Link header: `Link: </docs#migration>; rel=deprecation`
- Legacy fields removal: after Sunset date.

## Endpoints
- `POST /v1/classify` now returns BOTH formats:
  - New:
    - `spam: boolean`
    - `score: number`
    - `reasons: string[]`
    - `path: "rules" | "llm"`
    - `request_id: string`
  - Legacy (to be removed after Sunset):
    - `is_spam: boolean`
    - `confidence: number`
    - `reason: string`

- `POST /v1/batch` is available with limits: up to 100 items and 256KB payload cap.
- `GET /v1/healthz` is an alias to `GET /v1/health`.

## Examples
```json
{
  "spam": true,
  "score": 0.91,
  "reasons": ["promo", "discount"],
  "path": "rules",
  "request_id": "r_01ab234cdef",
  "is_spam": true,
  "confidence": 0.91,
  "reason": "promo and 1 more"
}
```

## Migration tips
- Prefer `spam`, `score`, `reasons`, `path`, `request_id`.
- Keep reading legacy fields during the transition window.
- Batch classify using `/v1/batch` for efficiency.


