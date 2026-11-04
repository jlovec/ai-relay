// ============================================================
// AI API Relay — Upstream Session Header Injection
//
// Some upstreams require a per-conversation identifier on every request and
// reject the call outright when it is absent. OpenCode Go is one: from
// 2026-09-05 it answers 400 "Request is missing x-opencode-session" unless the
// header carries a conversation id.
//
// Providers opt in through `ProviderConfig.sessionHeader`. The value names the
// upstream convention to follow, so additional conventions can be added later
// without changing the call sites.
// ============================================================

import { randomUUID } from 'node:crypto';

/** Upstream session conventions a provider may declare. */
export type SessionHeaderKind = 'opencode-go';

/**
 * Header names carrying a conversation id for the OpenCode Go convention, in
 * precedence order. The first two are what OpenCode clients send today; the
 * third is the legacy affinity header kept for older clients.
 */
const OPENCODE_SESSION_HEADERS = [
  'x-opencode-session',
  'x-session-id',
  'x-session-affinity',
] as const;

/** Canonical header written upstream for each convention. */
const SESSION_HEADER_NAME: Record<SessionHeaderKind, string> = {
  'opencode-go': 'X-Opencode-Session',
};

/**
 * Resolve the session id to send upstream.
 *
 * Precedence matches axonhub: reuse whatever the client already supplied, and
 * fall back to a freshly generated UUID only when every known header is empty.
 * The generated id is not stable across turns, so upstream prompt caching will
 * not hit for clients that send no identifier — same tradeoff axonhub accepts.
 */
function resolveSessionId(
  kind: SessionHeaderKind,
  passthroughHeaders?: Record<string, string>
): string {
  if (passthroughHeaders) {
    // Header names arrive with whatever casing the client used, so match
    // case-insensitively while still honouring the precedence order above.
    const byLowerName = new Map<string, string>();
    for (const [name, value] of Object.entries(passthroughHeaders)) {
      const lowerName = name.toLowerCase();
      if (!byLowerName.has(lowerName)) byLowerName.set(lowerName, value);
    }

    for (const name of OPENCODE_SESSION_HEADERS) {
      const value = byLowerName.get(name);
      if (value && value.trim()) return value.trim();
    }
  }
  return randomUUID();
}

/**
 * Apply the provider's session header convention to an outgoing header map.
 *
 * No-op when the provider declares no convention. Otherwise the canonical
 * header is set unconditionally: a client-supplied value is reused when present,
 * so the pass-through loop never leaves a duplicate that upstream could read
 * inconsistently.
 */
export function applySessionHeader(
  kind: SessionHeaderKind | undefined,
  headers: Record<string, string>,
  passthroughHeaders?: Record<string, string>
): void {
  if (!kind) return;

  const headerName = SESSION_HEADER_NAME[kind];
  if (!headerName) return;

  const id = resolveSessionId(kind, passthroughHeaders);

  // Drop any case-variant the pass-through loop may have copied.
  const target = headerName.toLowerCase();
  for (const existingName of Object.keys(headers)) {
    if (existingName.toLowerCase() === target) {
      delete headers[existingName];
    }
  }
  headers[headerName] = id;
}
