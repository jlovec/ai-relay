// ============================================================
// AI API Relay — Provider Registry
// ============================================================

import type { ProviderConfig } from './types';

/**
 * Built-in providers, merged underneath the KV-configured custom providers.
 *
 * Intentionally empty: the former built-ins (openai / anthropic / deepseek /
 * xiaomi / xiaomi_sgp_coding / xiaomi_coding) were removed on 2026-11-04.
 * None of them ever had API keys configured, every request to them returned
 * 502, and all live traffic is served by custom providers from KV.
 *
 * To add a built-in provider again, add an entry here. To add one without a
 * deploy, configure it in the admin panel instead — custom providers win on
 * name collision.
 */
export const PROVIDERS: Record<string, ProviderConfig> = {};

/** Known provider names (for usage trend queries etc.) */
export const PROVIDER_NAMES = Object.keys(PROVIDERS);
