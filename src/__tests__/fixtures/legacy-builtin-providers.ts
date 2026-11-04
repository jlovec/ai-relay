/**
 * Frozen copy of the six built-in providers removed from the registry on
 * 2026-11-04.
 *
 * The registry no longer ships them because none ever had API keys configured
 * and every live request is served by a KV custom provider. A number of tests,
 * however, exercise generic machinery (protocol translation, fallback dedupe,
 * prefix resolution, model mapping) using these providers purely as fixtures.
 *
 * Seeding them back through the mock KV keeps that coverage intact: custom
 * providers override registry entries by name, so a test that saves these sees
 * exactly what it saw before the removal.
 */
import type { ProviderConfig } from '../../lib/providers/types';
import { saveCustomProvider } from '../../lib/admin/admin-config';

export const LEGACY_BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    name: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    modelPrefixes: ['gpt-', 'dall-e-'],
    headerFormat: 'openai',
    envKeyField: 'OPENAI_KEYS',
    envBaseUrlField: 'OPENAI_BASE_URL',
    models: [
      { id: 'gpt-5.5', displayName: 'GPT-5.5', contextWindow: 1000000, maxOutput: 128000, supportsStream: true, supportsVision: true, supportsTools: true, pricing: { input: 5, output: 30 } },
      { id: 'gpt-5.4', displayName: 'GPT-5.4', contextWindow: 1000000, maxOutput: 128000, supportsStream: true, supportsVision: true, supportsTools: true, pricing: { input: 2.5, output: 15 } },
      { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', contextWindow: 400000, maxOutput: 128000, supportsStream: true, supportsVision: true, supportsTools: true, pricing: { input: 0.75, output: 4.5 } },
      { id: 'gpt-5.4-nano', displayName: 'GPT-5.4 Nano', contextWindow: 400000, maxOutput: 128000, supportsStream: true, supportsVision: true, supportsTools: true },
    ],
  },
  anthropic: {
    name: 'anthropic',
    displayName: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    modelPrefixes: ['claude-'],
    headerFormat: 'anthropic',
    envKeyField: 'CLAUDE_KEYS',
    envBaseUrlField: 'CLAUDE_BASE_URL',
    models: [
      { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', contextWindow: 1000000, maxOutput: 128000, supportsStream: true, supportsVision: true, supportsTools: true, pricing: { input: 5, output: 25 } },
      { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', contextWindow: 1000000, maxOutput: 64000, supportsStream: true, supportsVision: true, supportsTools: true, pricing: { input: 3, output: 15 } },
      { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', contextWindow: 200000, maxOutput: 64000, supportsStream: true, supportsVision: true, supportsTools: true, pricing: { input: 1, output: 5 } },
    ],
  },
  deepseek: {
    name: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    modelPrefixes: ['deepseek-'],
    headerFormat: 'openai',
    envKeyField: 'DEEPSEEK_KEYS',
    envBaseUrlField: 'DEEPSEEK_BASE_URL',
    models: [
      { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', contextWindow: 1048576, maxOutput: 393216, supportsStream: true, supportsTools: true, pricing: { input: 0.14, output: 0.28 } },
      { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', contextWindow: 1048576, maxOutput: 393216, supportsStream: true, supportsTools: true, pricing: { input: 0.435, output: 0.87 } },
    ],
  },
  // xiaomi comes before the coding plans: it owns the bare `mimo-` prefix, so
  // resolving `mimo-v2.5` lands here rather than on a coding-plan channel.
  xiaomi: {
    name: 'xiaomi',
    displayName: 'MiMo (API Key)',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    modelPrefixes: ['mimo-'],
    headerFormat: 'openai',
    envKeyField: 'XIAOMI_KEYS',
    envBaseUrlField: 'XIAOMI_BASE_URL',
    modelMapping: {
      'mimo-v2.5-pro-coding': 'mimo-v2.5-pro',
      'mimo-v2.5-pro-sgp': 'mimo-v2.5-pro',
      'mimo-v2.5-coding': 'mimo-v2.5',
      'mimo-v2.5-sgp': 'mimo-v2.5',
    },
    models: [
      { id: 'mimo-v2.5', displayName: 'MiMo v2.5', contextWindow: 128000, maxOutput: 16384, supportsStream: true, supportsVision: true, supportsTools: true },
      { id: 'mimo-v2.5-pro', displayName: 'MiMo v2.5 Pro', contextWindow: 128000, maxOutput: 16384, supportsStream: true, supportsVision: true, supportsTools: true },
    ],
  },
  xiaomi_sgp_coding: {
    name: 'xiaomi_sgp_coding',
    displayName: 'MiMo SGP (Coding Plan)',
    baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    modelPrefixes: ['mimo-v2.5-pro-sgp', 'mimo-v2.5-sgp'],
    headerFormat: 'azure',
    envKeyField: 'XIAOMIMIMO_SGP_CODING_KEYS',
    envBaseUrlField: 'XIAOMIMIMO_SGP_CODING_BASE_URL',
    modelMapping: {
      'mimo-v2.5-pro-sgp': 'mimo-v2.5-pro',
      'mimo-v2.5-sgp': 'mimo-v2.5',
    },
    models: [
      { id: 'mimo-v2.5-sgp', displayName: 'MiMo v2.5 (SGP Coding)', contextWindow: 128000, maxOutput: 16384, supportsStream: true, supportsVision: true, supportsTools: true },
      { id: 'mimo-v2.5-pro-sgp', displayName: 'MiMo v2.5 Pro (SGP Coding)', contextWindow: 128000, maxOutput: 16384, supportsStream: true, supportsVision: true, supportsTools: true },
    ],
  },
  xiaomi_coding: {
    name: 'xiaomi_coding',
    displayName: 'MiMo (Coding Plan)',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    modelPrefixes: ['mimo-v2.5-pro-coding', 'mimo-v2.5-coding'],
    headerFormat: 'openai',
    envKeyField: 'XIAOMI_CODING_KEYS',
    envBaseUrlField: 'XIAOMI_CODING_BASE_URL',
    modelMapping: {
      'mimo-v2.5-pro-coding': 'mimo-v2.5-pro',
      'mimo-v2.5-coding': 'mimo-v2.5',
    },
    models: [
      { id: 'mimo-v2.5-coding', displayName: 'MiMo v2.5 (Coding)', contextWindow: 128000, maxOutput: 16384, supportsStream: true, supportsVision: true, supportsTools: true },
      { id: 'mimo-v2.5-pro-coding', displayName: 'MiMo v2.5 Pro (Coding)', contextWindow: 128000, maxOutput: 16384, supportsStream: true, supportsVision: true, supportsTools: true },
    ],
  },
};

/** Save every legacy built-in provider into the active mock KV. */
export async function seedLegacyBuiltInProviders(): Promise<void> {
  for (const provider of Object.values(LEGACY_BUILTIN_PROVIDERS)) {
    await saveCustomProvider({ ...provider });
  }
}
