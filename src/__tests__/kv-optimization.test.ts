import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __adminConfigCacheForTests, createMemoryMockKV, getManagedKeys, getManagedKeysVersion, setManagedKeys } from '../lib/admin/admin-config';
import { __usageStorageCacheForTests, getUsageSamplingInfo, KVUsageStorage } from '../lib/usage/storage/kv-storage';
import { BatchUsageRecorder, createUsageEvent } from '../lib/usage';
import { kvKeys } from '../lib/usage/storage/kv-keys';
import { getKeyPool } from '../lib/relay/key-pool';
import { seedLegacyBuiltInProviders } from './fixtures/legacy-builtin-providers';

function installMockKV() {
  const mock = createMemoryMockKV();
  (global as any)._mockKVInstance = mock;
  (global as any)._mockKVInstance._isMock = true;
  return mock;
}

function usageEvent(overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {}) {
  return createUsageEvent({
    provider: 'openai',
    model: 'gpt-5.4-mini',
    apiKeyHash: 'keyhash1',
    statusCode: 200,
    promptTokens: 10,
    completionTokens: 15,
    isStream: false,
    ...overrides,
  });
}

describe('KV command optimization', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    __usageStorageCacheForTests.clear();
    __adminConfigCacheForTests.clear();
    installMockKV();
  });

  it('writes aggregate usage counters immediately via the storage command', async () => {
    const kv = installMockKV();
    const storage = new KVUsageStorage();

    await storage.record(usageEvent());
    await storage.record(usageEvent({ completionTokens: 5 }));

    const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(await kv.hgetall(kvKeys.usageDaily(date))).toMatchObject({
      requests: 2,
      tokens: 40,
      promptTokens: 20,
      completionTokens: 20,
    });
    expect(await kv.hgetall(kvKeys.usageProviderDaily('openai', date))).toMatchObject({
      requests: 2,
      tokens: 40,
    });
  });

  it('does not write per-key usage by default, but keeps history readable', async () => {
    const kv = installMockKV();
    const storage = new KVUsageStorage();
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await storage.record(usageEvent());

    expect(await kv.hgetall(kvKeys.legacyKeyDaily('keyhash1', date))).toBeNull();

    await kv.hset(kvKeys.legacyKeyDaily('keyhash1', date), { requests: '3', tokens: '99' });
    await kv.hset(kvKeys.legacyKeyTotal('keyhash1'), { requests: '10', tokens: '500' });

    await expect(storage.getKeyUsage('keyhash1')).resolves.toEqual({
      daily: { requests: 3, tokens: 99 },
      total: { requests: 10, tokens: 500 },
    });
  });

  it('samples aggregate usage writes and scales stored counters', async () => {
    const kv = installMockKV();
    vi.stubEnv('RELAY_KV_USAGE_SAMPLE_RATE', '0.25');
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const storage = new KVUsageStorage();
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

    expect(getUsageSamplingInfo()).toEqual({ sampleRate: 0.25, estimated: true });

    await storage.record(usageEvent());

    expect(await kv.hgetall(kvKeys.usageDaily(date))).toMatchObject({
      requests: 4,
      tokens: 100,
      promptTokens: 40,
      completionTokens: 60,
    });
    expect(await kv.hgetall(kvKeys.usageProviderDaily('openai', date))).toMatchObject({
      requests: 4,
      tokens: 100,
    });
  });

  it('skips aggregate usage writes when sampling misses', async () => {
    const kv = installMockKV();
    vi.stubEnv('RELAY_KV_USAGE_SAMPLE_RATE', '0.25');
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const storage = new KVUsageStorage();
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await storage.record(usageEvent());

    expect(await kv.hgetall(kvKeys.usageDaily(date))).toBeNull();
  });

  it('applies usage sampling to batched usage writes and scales counters', async () => {
    const kv = installMockKV();
    vi.stubEnv('RELAY_KV_USAGE_SAMPLE_RATE', '0.25');
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const storage = new KVUsageStorage();
    const recorder = new BatchUsageRecorder();
    recorder.setStorage(storage);
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await recorder.record(usageEvent());
    await recorder.flush();

    expect(await kv.hgetall(kvKeys.usageDaily(date))).toMatchObject({
      requests: 4,
      tokens: 100,
      promptTokens: 40,
      completionTokens: 60,
    });
    expect(await kv.hgetall(kvKeys.usageProviderDaily('openai', date))).toMatchObject({
      requests: 4,
      tokens: 100,
    });
  });

  it('skips batched usage writes when sampling misses', async () => {
    const kv = installMockKV();
    vi.stubEnv('RELAY_KV_USAGE_SAMPLE_RATE', '0.25');
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const storage = new KVUsageStorage();
    const recorder = new BatchUsageRecorder();
    recorder.setStorage(storage);
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await recorder.record(usageEvent());
    await recorder.flush();

    expect(await kv.hgetall(kvKeys.usageDaily(date))).toBeNull();
    expect(await kv.hgetall(kvKeys.usageProviderDaily('openai', date))).toBeNull();
  });

  it('does not double count global requests when flushing provider batches', async () => {
    const kv = installMockKV();
    const storage = new KVUsageStorage();
    const recorder = new BatchUsageRecorder();
    recorder.setStorage(storage);
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await recorder.record(usageEvent());
    await recorder.record(usageEvent({ completionTokens: 5 }));
    await recorder.flush();

    expect(await kv.hgetall(kvKeys.usageDaily(date))).toMatchObject({
      requests: 2,
      tokens: 40,
      promptTokens: 20,
      completionTokens: 20,
    });
    expect(await kv.hgetall(kvKeys.usageProviderDaily('openai', date))).toMatchObject({
      requests: 2,
      tokens: 40,
      promptTokens: 20,
      completionTokens: 20,
    });
  });

  it('clears cached per-key usage after usage writes', async () => {
    const kv = installMockKV();
    const storage = new KVUsageStorage();
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await kv.hset(kvKeys.legacyKeyDaily('keyhash1', date), { requests: '1', tokens: '10' });
    await kv.hset(kvKeys.legacyKeyTotal('keyhash1'), { requests: '1', tokens: '10' });
    await expect(storage.getKeyUsage('keyhash1')).resolves.toEqual({
      daily: { requests: 1, tokens: 10 },
      total: { requests: 1, tokens: 10 },
    });

    await kv.hset(kvKeys.legacyKeyDaily('keyhash1', date), { requests: '2', tokens: '20' });
    await kv.hset(kvKeys.legacyKeyTotal('keyhash1'), { requests: '2', tokens: '20' });
    await storage.record(usageEvent({ apiKeyHash: 'other-key' }));

    await expect(storage.getKeyUsage('keyhash1')).resolves.toEqual({
      daily: { requests: 2, tokens: 20 },
      total: { requests: 2, tokens: 20 },
    });
  });

  it('prunes expired admin cache entries during cache activity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T00:00:00Z'));

    try {
      __usageStorageCacheForTests.clear();
      __usageStorageCacheForTests.set('keyUsage:expired:today', { stale: true }, 1);
      expect(__usageStorageCacheForTests.size()).toBe(1);

      vi.advanceTimersByTime(60_001);
      __usageStorageCacheForTests.set('globalUsage:fresh', { fresh: true });

      expect(__usageStorageCacheForTests.size()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports full per-key usage mode when explicitly enabled', async () => {
    const kv = installMockKV();
    vi.stubEnv('RELAY_KV_KEY_USAGE_MODE', 'full');
    const storage = new KVUsageStorage();
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await storage.record(usageEvent());

    expect(await kv.hgetall(kvKeys.legacyKeyDaily('keyhash1', date))).toMatchObject({
      requests: 1,
      tokens: 25,
    });
    expect(await kv.hgetall(kvKeys.legacyKeyTotal('keyhash1'))).toMatchObject({
      requests: 1,
      tokens: 25,
    });
  });

  it('reserves quota atomically when requested', async () => {
    installMockKV();
    vi.stubEnv('RELAY_DAILY_LIMIT', '1');
    vi.stubEnv('RELAY_MONTHLY_LIMIT', '10');
    const storage = new KVUsageStorage();

    await expect(storage.checkQuota(true)).resolves.toMatchObject({
      allowed: true,
      dailyUsed: 1,
      monthlyUsed: 1,
    });
    await expect(storage.checkQuota(true)).resolves.toMatchObject({
      allowed: false,
      dailyUsed: 1,
      monthlyUsed: 1,
    });
  });

  it('does not reserve quota counters when no quota limit is configured', async () => {
    installMockKV();
    const storage = new KVUsageStorage();

    await expect(storage.checkQuota(true)).resolves.toMatchObject({
      allowed: true,
      dailyUsed: 0,
      dailyLimit: 0,
      monthlyUsed: 0,
      monthlyLimit: 0,
    });
    await expect(storage.checkQuota()).resolves.toMatchObject({
      allowed: true,
      dailyUsed: 0,
      dailyLimit: 0,
      monthlyUsed: 0,
      monthlyLimit: 0,
    });
  });

  it('caches missing custom quota config to avoid repeated KV reads', async () => {
    const kv = installMockKV();
    vi.stubEnv('RELAY_DAILY_LIMIT', '1');
    vi.stubEnv('RELAY_MONTHLY_LIMIT', '10');
    const originalHgetall = kv.hgetall.bind(kv);
    kv.hgetall = vi.fn((key: string) => originalHgetall(key));
    const storage = new KVUsageStorage();

    await storage.checkQuota(true);
    await storage.checkQuota(true);

    expect(kv.hgetall).toHaveBeenCalledTimes(1);
    expect(kv.hgetall).toHaveBeenCalledWith('admin:quota');
  });

  it('reads provider error stats through a single pipeline', async () => {
    const kv = installMockKV();
    // getErrorStats walks the live provider list; `openai` is a fixture now.
    await seedLegacyBuiltInProviders();
    const storage = new KVUsageStorage();
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const originalPipeline = kv.pipeline.bind(kv);
    kv.pipeline = vi.fn(() => originalPipeline());

    await kv.hset(kvKeys.errorProviderDaily('openai', date), { 429: '2' });

    await expect(storage.getErrorStats()).resolves.toMatchObject({
      openai: { 429: 2 },
    });
    expect(kv.pipeline).toHaveBeenCalledTimes(1);
  });

  it('increments managed-key versions when keys change', async () => {
    installMockKV();

    await setManagedKeys('openai', ['sk-a']);
    const v1 = await getManagedKeysVersion('openai');
    await setManagedKeys('openai', ['sk-a', 'sk-b']);
    const v2 = await getManagedKeysVersion('openai');

    expect(v1).toBeGreaterThan(0);
    expect(v2).toBe(v1 + 1);
  });

  it('can bypass managed-key cache after another instance changes the version', async () => {
    const kv = installMockKV();

    await setManagedKeys('openai', ['sk-a']);
    await expect(getManagedKeys('openai')).resolves.toEqual(['sk-a']);

    await kv.set('admin:keys:openai', JSON.stringify(['sk-b']));
    await kv.incr('admin:keys:version:openai');

    await expect(getManagedKeys('openai')).resolves.toEqual(['sk-a']);
    await expect(getManagedKeys('openai', true)).resolves.toEqual(['sk-b']);
  });

  it('retains healthy keys in key pool if version check or key fetch fails', async () => {
    const kv = installMockKV();
    const config = { name: 'openai', displayName: 'OpenAI', envKeyField: 'OPENAI_KEYS' } as any;

    // 1. Setup healthy managed keys
    await setManagedKeys('openai', ['sk-healthy-1', 'sk-healthy-2']);
    const pool1 = await getKeyPool(config, true);
    expect(pool1.keys.map(k => k.key)).toEqual(['sk-healthy-1', 'sk-healthy-2']);

    // 2. Mock KV to fail on next check
    const originalGet = kv.get;
    kv.get = async (key: string) => {
      if (key.includes('admin:keys:version:') || key.includes('admin:keys:')) {
        throw new Error('KV Network Error');
      }
      return originalGet.call(kv, key);
    };

    // 3. Fast-forward version check TTL and trigger key pool check
    vi.stubEnv('RELAY_KEY_POOL_VERSION_CHECK_TTL_MS', '1');
    await new Promise(resolve => setTimeout(resolve, 5));

    // Key Pool should gracefully handle the exception and keep the healthy keys pool
    const pool2 = await getKeyPool(config);
    expect(pool2.keys.map(k => k.key)).toEqual(['sk-healthy-1', 'sk-healthy-2']);
  });

  it('clears key errors from storage when clearKeyErrors is called', async () => {
    vi.stubEnv('RELAY_KV_ERROR_DETAIL_SAMPLE_RATE', '1');
    const storage = new KVUsageStorage();

    await storage.recordError({
      provider: 'openai',
      keyHash: 'test-hash-to-delete',
      statusCode: 429,
      reason: 'Rate limit reached',
    });

    const errorsBefore = await storage.getKeyErrors();
    expect(errorsBefore).toContainEqual(
      expect.objectContaining({
        keyHash: 'test-hash-to-delete',
      })
    );

    await storage.clearKeyErrors('test-hash-to-delete');

    const errorsAfter = await storage.getKeyErrors();
    expect(errorsAfter).not.toContainEqual(
      expect.objectContaining({
        keyHash: 'test-hash-to-delete',
      })
    );
  });
});
