// ============================================================
// AI API Relay — /v1/rerank
//
// Endpoint behaviour lives in ENDPOINTS.rerank (src/lib/relay/endpoints/spec.ts).
// This file is intentionally a thin binding so every /v1 endpoint shares one
// request path.
// ============================================================

import { createRelayHandler } from '@/lib/relay/endpoints/handler';
import { ENDPOINTS } from '@/lib/relay/endpoints/spec';

export const runtime = 'nodejs';
export const maxDuration = 300;

export const POST = createRelayHandler(ENDPOINTS.rerank);
