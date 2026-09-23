# @aelvyril/shared

Zod schemas, route constants, and tiny pure helpers shared by `apps/web` and `apps/gateway`. Zero runtime dependencies beyond `zod`.

## What's in here

- `envelope.ts` — `EventEnvelope`, the discriminated-union `{ seq, conversationId, ts, kind, payload }` shape the browser sees on the SSE stream. One `EnvelopeKind` enum, one payload schema per kind.
- `api.ts` — `ROUTES` (URL constants), `CreateConversationBody`, `PromptBody`, `Conversation`, `ConversationState`. The HTTP contract.
- `namespace.ts` — `SHARED_NAMESPACE` (`"platform"`) and `toUserNamespace(clerkUserId)` (`user:<userId.toLowerCase()>`).
- `index.ts` — barrel. Bumps `SCHEMA_VERSION` on every breaking change.

## Adding a new envelope kind

1. Add the literal to `EnvelopeKind` in `envelope.ts`.
2. Add a `payloadSchemas.<kind>` entry matching the wire shape (zod).
3. Append `envelopeShape.extend({ kind: z.literal("<kind>"), payload: payloadSchemas.<kind> })` to the `EventEnvelope` discriminated union.
4. Map the pi RPC event in `apps/gateway/src/supervisor.ts` `onProtocolEvent` to the new kind (or pass through verbatim if it starts with `custom_`).
5. Handle the new kind in `apps/web/components/chat.tsx` `applyEnvelope` — render it, fold it into `messages`, or no-op.
6. Add a parse-positive test in `envelope.test.ts` (and update the "covers every EnvelopeKind with a payload schema" test if you added a new kind).
7. Bump `SCHEMA_VERSION` in `index.ts` if the wire shape changed in a way old clients must reject.

Old `EventEnvelope.parse` callers will reject unknown kinds with a `ZodError` — that is intentional; the gateway's error handler (`apps/gateway/src/app.ts`) maps it to 400, the web client's SSE parser surfaces it as an `error` envelope.

## Checks

    pnpm --filter @aelvyril/shared test        # 4 tests
    pnpm --filter @aelvyril/shared typecheck

## Notes

- `apps/web/lib/api.ts` re-exports `ROUTES` from here so URL strings live in one place.
- The discriminated union is the API contract — never publish an envelope whose `kind` is not in the enum, and never add a kind without updating both ends.