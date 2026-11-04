import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deleteCustomProvider,
  detectFallbackCycle,
  getFallbackChain,
  saveCustomProvider,
  setFallbackChain,
  clearFallbackChain,
  __adminConfigCacheForTests,
  createMemoryMockKV,
} from '../lib/admin/admin-config';
import * as resolver from '../lib/providers';
import { relayRequest } from '../lib/relay/relay';
import { PROVIDERS } from '../lib/providers/registry';
import { seedLegacyBuiltInProviders } from './fixtures/legacy-builtin-providers';

describe('Fallback Circular Dependency Tests', () => {
  let providersSpy: any;

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    __adminConfigCacheForTests.clear();
    const mockKV = createMemoryMockKV();
    (global as any)._mockKVInstance = mockKV;
    (global as any)._mockKVInstance._isMock = true;
    // The registry no longer ships built-in providers, so seed them as custom
    // ones: `deleteCustomProvider` only walks registry ∪ custom names, and
    // relayRequest needs a provider that resolves the `gpt-` prefix.
    await seedLegacyBuiltInProviders();
    // Set up mock providers
    providersSpy = vi.spyOn(resolver, 'getAllProviders').mockResolvedValue({
      openai: {
        name: 'openai',
        displayName: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        headerFormat: 'openai',
        envKeyField: 'OPENAI_KEYS',
        modelPrefixes: ['gpt-'],
      },
      anthropic: {
        name: 'anthropic',
        displayName: 'Anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        headerFormat: 'anthropic',
        envKeyField: 'CLAUDE_KEYS',
        modelPrefixes: ['claude-'],
      },
      deepseek: {
        name: 'deepseek',
        displayName: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        headerFormat: 'openai',
        envKeyField: 'DEEPSEEK_KEYS',
        modelPrefixes: ['deepseek-'],
      },
    } as any);
  });

  afterEach(async () => {
    providersSpy.mockRestore();
    // Clean up KV fallback overrides
    await clearFallbackChain('openai');
    await clearFallbackChain('anthropic');
    await clearFallbackChain('deepseek');
    vi.restoreAllMocks();
  });

  describe('detectFallbackCycle', () => {
    it('should detect a direct self-fallback cycle (A -> A)', async () => {
      const cycle = await detectFallbackCycle('openai', ['openai']);
      expect(cycle).toEqual(['openai', 'openai']);
    });

    it('should detect a direct self-fallback cycle with model (A -> A:model)', async () => {
      const cycle = await detectFallbackCycle('openai', ['openai:gpt-5.5']);
      expect(cycle).toEqual(['openai', 'openai']);
    });

    it('should detect a 2-node cycle (A -> B -> A)', async () => {
      // Configure B (anthropic) to fall back to A (openai)
      await setFallbackChain('anthropic', ['openai']);

      // Check if A (openai) falling back to B (anthropic) creates a cycle
      const cycle = await detectFallbackCycle('openai', ['anthropic']);
      expect(cycle).toEqual(['openai', 'anthropic', 'openai']);
    });

    it('should detect a longer cycle (A -> B -> C -> A)', async () => {
      // Configure B (anthropic) -> C (deepseek)
      await setFallbackChain('anthropic', ['deepseek']);
      // Configure C (deepseek) -> A (openai)
      await setFallbackChain('deepseek', ['openai']);

      // Check if A (openai) -> B (anthropic) creates a cycle
      const cycle = await detectFallbackCycle('openai', ['anthropic']);
      expect(cycle).toEqual(['openai', 'anthropic', 'deepseek', 'openai']);
    });

    it('should allow valid acyclic fallback configurations (A -> B -> C)', async () => {
      // Configure B (anthropic) -> C (deepseek)
      await setFallbackChain('anthropic', ['deepseek']);

      // Check if A (openai) -> B (anthropic) is allowed
      const cycle = await detectFallbackCycle('openai', ['anthropic']);
      expect(cycle).toBeNull();
    });
  });

  describe('setFallbackChain validation', () => {
    it('should throw an error and not save if a cycle is detected', async () => {
      await setFallbackChain('anthropic', ['openai']);

      await expect(setFallbackChain('openai', ['anthropic'])).rejects.toThrow(
        'Circular fallback detected: openai -> anthropic -> openai'
      );
    });
  });

  describe('deleteCustomProvider cleanup', () => {
    it('removes references to the deleted provider from other fallback chains', async () => {
      await saveCustomProvider({
        name: 'delete_me',
        displayName: 'Delete Me',
        baseUrl: 'https://delete-me.example.com/v1',
        headerFormat: 'openai',
        envKeyField: 'DELETE_ME_KEYS',
        modelPrefixes: ['delete-me-'],
        models: [],
        isCustom: true,
      });
      await setFallbackChain('openai', ['delete_me:gpt-test', 'anthropic']);
      await setFallbackChain('anthropic', ['delete_me']);

      await deleteCustomProvider('delete_me');

      await expect(getFallbackChain('openai')).resolves.toEqual(['anthropic']);
      await expect(getFallbackChain('anthropic', ['openai'])).resolves.toEqual(['openai']);
    });
  });

  describe('Static registry verification', () => {
    it('should ensure there are no cycles in the default static registry configurations', async () => {
      // Restore actual resolver behavior for this test to test real code configuration
      providersSpy.mockRestore();

      const allProviders = await resolver.getAllProviders(true);
      for (const providerName of Object.keys(allProviders)) {
        const prov = allProviders[providerName];
        const staticFallbacks = prov.fallbackProviders || (prov.fallbackProvider ? [prov.fallbackProvider] : []);
        
        // Ensure no cycle is introduced by the default config
        const cycle = await detectFallbackCycle(providerName, staticFallbacks);
        expect(cycle, `Static fallback cycle detected for ${providerName}: ${cycle?.join(' -> ')}`).toBeNull();
      }
    });
  });

  describe('Runtime fallback loop prevention', () => {
    it('returns a 504 timeout without attempting fallback providers', async () => {
      vi.useFakeTimers();
      try {
        vi.stubEnv('OPENAI_KEYS', 'openai_key');
        vi.stubEnv('CLAUDE_KEYS', 'claude_key');
        vi.stubEnv('RELAY_UPSTREAM_TIMEOUT_MS', '1000');

        const fetchMock = vi.fn((_url, init?: RequestInit) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }));
        global.fetch = fetchMock as any;

        const keyPoolMod = await import('../lib/relay/key-pool');
        vi.spyOn(keyPoolMod, 'selectKey')
          .mockResolvedValueOnce({ hash: 'openai_hash', key: 'openai_key', provider: 'openai' } as any)
          .mockResolvedValueOnce({ hash: 'anthropic_hash', key: 'claude_key', provider: 'anthropic' } as any);
        vi.spyOn(keyPoolMod, 'getKeyPool').mockResolvedValue({
          provider: 'openai',
          keys: [{ hash: 'openai_hash', key: 'openai_key', provider: 'openai' }],
          counter: 0,
        } as any);

        const configMod = await import('../lib/admin/admin-config');
        vi.spyOn(configMod, 'getFallbackChain').mockResolvedValue(['anthropic']);

        const promise = relayRequest({
          model: 'gpt-6-preview',
          messages: [{ role: 'user', content: 'test' }],
        });

        const assertion = expect(promise).rejects.toMatchObject({
          name: 'RelayError',
          status: 504,
          type: 'upstream_error',
        });

        await vi.advanceTimersByTimeAsync(1000);

        await assertion;
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toContain('openai.com');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should prevent attempting a provider more than once in relayRequest', async () => {
      // Mock global fetch to fail so it rolls through fallbacks
      const fetchMock = vi.fn().mockResolvedValue({
        status: 502,
        ok: false,
        text: async () => 'Error',
      });
      global.fetch = fetchMock;

      // Mock selectKey and getKeyPool so we bypass key pool empty errors
      const keyPoolMod = await import('../lib/relay/key-pool');
      vi.spyOn(keyPoolMod, 'selectKey').mockResolvedValue({ hash: 'key_hash', key: 'key_val' } as any);
      vi.spyOn(keyPoolMod, 'getKeyPool').mockResolvedValue({ keys: [{ hash: 'key_hash', key: 'key_val' }] } as any);

      // Force a fallback chain that contains a duplicate: openai -> anthropic -> openai
      // (Normally this is blocked by config validation, but we force it here to test runtime defense-in-depth)
      const configMod = await import('../lib/admin/admin-config');
      vi.spyOn(configMod, 'getFallbackChain').mockResolvedValue(['anthropic', 'openai']);

      try {
        await relayRequest({
          model: 'gpt-6-preview', // routes to openai directly (either mocked or real resolver)
          messages: [{ role: 'user', content: 'test' }],
        });
      } catch (err: any) {
        // Should throw because all providers failed
      }

      // Expected call attempts:
      // 1. Primary provider (openai)
      // 2. Fallback provider 1 (anthropic)
      // 3. Fallback provider 2 (openai) -> Should be SKIPPED due to deduplication!
      // Thus, fetch should be called at most twice (one for primary, one for anthropic, none for duplicate openai)
      // Each provider has maxRetries = Math.min(pool.keys.length, 3) = 1. So 1 fetch per provider.
      const calledUrls = fetchMock.mock.calls.map(call => call[0]);
      
      // The urls called should belong to openai and anthropic, but not openai again.
      expect(calledUrls.length).toBe(2);
      expect(calledUrls[0]).toContain('openai.com');
      expect(calledUrls[1]).toContain('anthropic.com');
    });
  });
});
