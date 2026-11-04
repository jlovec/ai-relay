import { describe, it, expect, beforeEach } from 'vitest';
import {
  exportBackupData,
  importBackupData,
  exportStatsData,
  importStatsData,
  saveCustomProvider,
  getCustomProviders,
  setManagedKeys,
  getManagedKeys,
  setFallbackChain,
  getCustomQuota,
  setCustomQuota,
  saveModelAliasConfig,
  getModelAliasConfig,
  savePriorityRules,
  getPriorityRules,
  __adminConfigCacheForTests,
} from '../lib/admin/admin-config';
import { clearProvidersCache } from '../lib/providers/resolver';
import type { ProviderConfig } from '../lib/providers/types';
import { seedLegacyBuiltInProviders } from './fixtures/legacy-builtin-providers';

describe('Vercel KV Backup & Restore Tests', () => {
  beforeEach(() => {
    // Clear caches
    __adminConfigCacheForTests.clear();
    clearProvidersCache();
  });

  it('should export and restore full configuration successfully', async () => {
    // 1. Setup mock data in KV
    const customProvider: ProviderConfig = {
      name: 'backup_test_provider',
      displayName: 'Backup Test Provider',
      baseUrl: 'https://example.com/v1',
      headerFormat: 'openai',
      envKeyField: 'BACKUP_TEST_PROVIDER_KEYS',
      modelPrefixes: ['backup-test-'],
      models: [],
      isCustom: true,
    };
    await saveCustomProvider(customProvider);

    await setManagedKeys('backup_test_provider', ['key1', 'key2']);
    await setFallbackChain('backup_test_provider', ['openai', 'anthropic']);
    
    await setCustomQuota({
      dailyLimit: 100,
      monthlyLimit: 1000,
    });

    await saveModelAliasConfig({
      aliases: { 'gpt-alias': 'gpt-5.4' },
      hidden: ['gpt-5.4-nano'],
    });

    await savePriorityRules([
      {
        id: 'rule-1',
        modelPattern: 'gpt-5*',
        providerOrder: ['openai'],
        active: true,
      },
    ]);

    // 2. Export Backup
    const backup = await exportBackupData();

    expect(backup.version).toBe(1);
    expect(backup.exportedAt).toBeTruthy();
    expect(backup.customProviders['backup_test_provider']).toEqual({
      ...customProvider,
      isCustom: true,
    });
    expect(backup.keys['backup_test_provider']).toEqual(['key1', 'key2']);
    expect(backup.fallbacks['backup_test_provider']).toEqual(['openai', 'anthropic']);
    expect(backup.quota).toEqual({ dailyLimit: 100, monthlyLimit: 1000 });
    expect(backup.modelAliases).toEqual({
      aliases: { 'gpt-alias': 'gpt-5.4' },
      hidden: ['gpt-5.4-nano'],
    });
    expect(backup.priorityRules[0].id).toBe('rule-1');
    expect(backup.priorityRules[0].modelPattern).toBe('gpt-5*');
    expect(backup.priorityRules[0].providerOrder).toEqual(['openai']);
    expect(backup.priorityRules[0].enabled).toBe(true);

    // 3. Clear KV configuration (simulating empty database)
    // We import an empty/default backup but with version 1
    const emptyBackup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      customProviders: {},
      keys: {},
      fallbacks: {},
      quota: null,
      modelAliases: null,
      priorityRules: [],
      webhooks: null,
    };
    await importBackupData(emptyBackup);

    // Verify everything is cleared
    const customProvidersEmpty = await getCustomProviders(true);
    expect(customProvidersEmpty['backup_test_provider']).toBeUndefined();

    const keysEmpty = await getManagedKeys('backup_test_provider', true);
    expect(keysEmpty).toBeNull();

    const quotaEmpty = await getCustomQuota();
    expect(quotaEmpty).toBeNull();

    // 4. Restore original configuration from backup
    await importBackupData(backup);

    // Verify all configurations are back
    const customProvidersRestored = await getCustomProviders(true);
    expect(customProvidersRestored['backup_test_provider']).toEqual({
      ...customProvider,
      isCustom: true,
    });

    const keysRestored = await getManagedKeys('backup_test_provider', true);
    expect(keysRestored).toEqual(['key1', 'key2']);

    const quotaRestored = await getCustomQuota();
    expect(quotaRestored).toEqual({ dailyLimit: 100, monthlyLimit: 1000 });

    const modelAliasesRestored = await getModelAliasConfig(true);
    expect(modelAliasesRestored.aliases['gpt-alias']).toBe('gpt-5.4');
    expect(modelAliasesRestored.hidden).toContain('gpt-5.4-nano');

    const rulesRestored = await getPriorityRules(true);
    expect(rulesRestored[0].id).toBe('rule-1');
  });

  it('should reject importing backup with invalid version', async () => {
    const invalidBackup = {
      version: 2, // invalid
      exportedAt: new Date().toISOString(),
      customProviders: {},
      keys: {},
      fallbacks: {},
    };

    await expect(importBackupData(invalidBackup)).rejects.toThrow('Invalid backup version or format');
  });

  it('should validate customProviders schema during import and skip invalid ones', async () => {
    const backupWithInvalidProviders = {
      version: 1,
      exportedAt: new Date().toISOString(),
      customProviders: {
        valid_provider: {
          name: 'valid_provider',
          displayName: 'Valid Provider',
          baseUrl: 'https://example.com/v1',
          headerFormat: 'openai',
          modelPrefixes: ['valid-'],
        },
        invalid_provider_no_prefix: {
          name: 'invalid_provider_no_prefix',
          displayName: 'Invalid Provider',
          baseUrl: 'https://example.com/v1',
          headerFormat: 'openai',
          modelPrefixes: [], // Empty prefix should fail validation
        },
        invalid_provider_not_array: {
          name: 'invalid_provider_not_array',
          displayName: 'Invalid Provider',
          baseUrl: 'https://example.com/v1',
          headerFormat: 'openai',
          modelPrefixes: 'not-an-array', // String should fail validation
        },
        invalid_provider_bad_url: {
          name: 'invalid_provider_bad_url',
          displayName: 'Invalid Provider',
          baseUrl: 'http://insecure.com/v1', // http instead of https should fail
          headerFormat: 'openai',
          modelPrefixes: ['bad-'],
        }
      }
    };

    await importBackupData(backupWithInvalidProviders);

    const restoredProviders = await getCustomProviders(true);
    expect(restoredProviders['valid_provider']).toBeDefined();
    expect(restoredProviders['invalid_provider_no_prefix']).toBeUndefined();
    expect(restoredProviders['invalid_provider_not_array']).toBeUndefined();
    expect(restoredProviders['invalid_provider_bad_url']).toBeUndefined();
  });

  it('should prevent destructive overwrites when properties are missing in backup (partial restore)', async () => {
    // 1. Seed some priority rules and model aliases first
    await saveModelAliasConfig({
      aliases: { 'preserve-alias': 'gpt-5.4' },
      hidden: [],
    });
    await savePriorityRules([
      {
        id: 'preserve-rule',
        modelPattern: 'gpt-5*',
        providerOrder: ['openai'],
        active: true,
      },
    ]);

    // 2. Perform a partial import that doesn't contain priorityRules or modelAliases keys at all
    const partialBackup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      customProviders: {},
      // priorityRules and modelAliases are NOT present in this payload
    };
    
    await importBackupData(partialBackup);

    // 3. Verify that the seeded rules and aliases are preserved (not cleared!)
    const restoredAliases = await getModelAliasConfig(true);
    expect(restoredAliases.aliases['preserve-alias']).toBe('gpt-5.4');

    const restoredRules = await getPriorityRules(true);
    expect(restoredRules[0].id).toBe('preserve-rule');
  });
});

describe('Statistics Backup & Restore Tests', () => {
  it('should export and restore stats correctly for a date range', async () => {
    const { createMemoryMockKV } = await import('../lib/admin/admin-config');
    const mockKV = createMemoryMockKV();
    
    // Setup mock data directly in mock KV store
    await mockKV.hset('usage:daily:2026-05-25', { requests: '100', tokens: '2000' });
    await mockKV.hset('usage:provider:openai:daily:2026-05-25', { requests: '80', tokens: '1500' });
    await mockKV.hset('error:openai:2026-05-25', { '429': '3', '500': '1' });
    await mockKV.set('quota:daily:2026-05-25', '100');
    await mockKV.set('quota:monthly:2026-05', '1200');
    await mockKV.sadd('error:keys:2026-05-25', 'hash-xyz');
    
    // Setup a mock daily report document
    const mockReport = {
      date: '2026-05-25',
      summary: { totalRequests: 100, totalTokens: 2000, errorRate: 0.04, p95LatencyMs: 350 },
      byProvider: { openai: { requests: 80, tokens: 1500, promptTokens: 1000, completionTokens: 500 } },
      topModels: []
    };
    await mockKV.set('relay:report:daily:2026-05-25', JSON.stringify(mockReport));

    // Overwrite getKV temporarily in global context for testing
    const globalObj = global as any;
    const originalMockKV = globalObj._mockKVInstance;
    globalObj._mockKVInstance = mockKV;
    // exportStatsData walks the live provider list, so `openai` must still be a
    // registered provider name even though the registry no longer ships it.
    await seedLegacyBuiltInProviders();

    try {
      // 1. Export statistics backup
      const backup = await exportStatsData('2026-05-25', '2026-05-25');
      
      expect(backup.type).toBe('ai-relay-stats-backup');
      expect(backup.startDate).toBe('2026-05-25');
      expect(backup.endDate).toBe('2026-05-25');
      expect(backup.data.usageDaily['2026-05-25']).toEqual({ requests: '100', tokens: '2000' });
      expect(backup.data.usageProviderDaily['openai']['2026-05-25']).toEqual({ requests: '80', tokens: '1500' });
      expect(backup.data.errorProviderDaily['openai']['2026-05-25']).toEqual({ '429': '3', '500': '1' });
      expect(backup.data.quotaDaily['2026-05-25']).toBe('100');
      expect(backup.data.quotaMonthly['2026-05']).toBe('1200');
      expect(backup.data.errorKeys['2026-05-25']).toContain('hash-xyz');
      expect(backup.data.dailyReports['2026-05-25']).toEqual(mockReport);

      // 2. Clear KV stats (using empty database mock)
      const cleanKV = createMemoryMockKV();
      globalObj._mockKVInstance = cleanKV;

      // 3. Restore stats from backup
      await importStatsData(backup);

      // Verify that all keys are restored with correct types and values
      expect(await cleanKV.hgetall('usage:daily:2026-05-25')).toEqual({ requests: '100', tokens: '2000' });
      expect(await cleanKV.hgetall('usage:provider:openai:daily:2026-05-25')).toEqual({ requests: '80', tokens: '1500' });
      expect(await cleanKV.hgetall('error:openai:2026-05-25')).toEqual({ '429': '3', '500': '1' });
      expect(await cleanKV.get('quota:daily:2026-05-25')).toBe('100');
      expect(await cleanKV.get('quota:monthly:2026-05')).toBe('1200');
      expect(await cleanKV.smembers('error:keys:2026-05-25')).toContain('hash-xyz');
      expect(JSON.parse(await cleanKV.get('relay:report:daily:2026-05-25'))).toEqual(mockReport);
    } finally {
      // Revert KV global mock
      globalObj._mockKVInstance = originalMockKV;
    }
  });

  it('should reject importing stats backup with invalid type', async () => {
    const invalidBackup = {
      type: 'invalid-type',
      version: 1,
      data: {}
    };

    await expect(importStatsData(invalidBackup)).rejects.toThrow('Invalid statistics backup format or version');
  });
});

