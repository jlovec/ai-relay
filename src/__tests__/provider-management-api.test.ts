import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

function req(body: unknown) {
  return new NextRequest('http://localhost/api/admin/providers', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer admin-test-key',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function adminReq() {
  return new NextRequest('http://localhost/api/admin', {
    method: 'GET',
    headers: {
      Authorization: 'Bearer admin-test-key',
    },
  });
}

describe('admin custom provider management API', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('preserves custom User-Agent when saving a provider', async () => {
    const saveCustomProvider = vi.fn(async () => undefined);
    vi.doMock('@/lib/admin', () => ({
      requireAdminAuth: vi.fn(() => null),
      getCustomProviders: vi.fn(async () => ({})),
      saveCustomProvider,
      deleteCustomProvider: vi.fn(),
    }));
    vi.doMock('@/lib/providers', () => ({
      clearProvidersCache: vi.fn(),
    }));

    const { POST } = await import('../app/api/admin/providers/route');
    const res = await POST(req({
      name: 'custom_newapi',
      displayName: 'Custom NewAPI',
      baseUrl: 'https://example.com/v1',
      headerFormat: 'openai',
      modelPrefixes: ['deepseek-'],
      userAgent: ' Mozilla/5.0 ',
      models: [],
    }));

    expect(res.status).toBe(200);
    expect(saveCustomProvider).toHaveBeenCalledWith(expect.objectContaining({
      name: 'custom_newapi',
      userAgent: 'Mozilla/5.0',
    }));
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      provider: {
        name: 'custom_newapi',
        userAgent: 'Mozilla/5.0',
      },
    });
  });

  it('keeps a stored model mapping and session header when the modal omits them', async () => {
    const saveCustomProvider = vi.fn(async () => undefined);
    vi.doMock('@/lib/admin', () => ({
      requireAdminAuth: vi.fn(() => null),
      getCustomProviders: vi.fn(async () => ({
        opencode_gmail: {
          name: 'opencode_gmail',
          displayName: 'OpenCode Gmail',
          baseUrl: 'https://opencode.ai/zen/go/v1',
          headerFormat: 'openai',
          envKeyField: 'OPENCODE_GMAIL_KEYS',
          modelPrefixes: ['deepseek-'],
          models: [],
          modelMapping: { 'deepseek-flash': 'deepseek-v4.1-flash' },
          sessionHeader: 'opencode-go',
          isCustom: true,
        },
      })),
      saveCustomProvider,
      deleteCustomProvider: vi.fn(),
    }));
    vi.doMock('@/lib/providers', () => ({
      clearProvidersCache: vi.fn(),
    }));

    const { POST } = await import('../app/api/admin/providers/route');
    const res = await POST(req({
      name: 'opencode_gmail',
      displayName: 'OpenCode Gmail',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      headerFormat: 'openai',
      modelPrefixes: ['deepseek-'],
      models: [],
    }));

    expect(res.status).toBe(200);
    expect(saveCustomProvider).toHaveBeenCalledWith(expect.objectContaining({
      name: 'opencode_gmail',
      modelMapping: { 'deepseek-flash': 'deepseek-v4.1-flash' },
      sessionHeader: 'opencode-go',
    }));
  });

  it('accepts a model mapping sent from the provider modal', async () => {
    const saveCustomProvider = vi.fn(async () => undefined);
    vi.doMock('@/lib/admin', () => ({
      requireAdminAuth: vi.fn(() => null),
      getCustomProviders: vi.fn(async () => ({})),
      saveCustomProvider,
      deleteCustomProvider: vi.fn(),
    }));
    vi.doMock('@/lib/providers', () => ({
      clearProvidersCache: vi.fn(),
    }));

    const { POST } = await import('../app/api/admin/providers/route');
    const res = await POST(req({
      name: 'custom_relay',
      displayName: 'Custom Relay',
      baseUrl: 'https://example.com/v1',
      headerFormat: 'openai',
      modelPrefixes: ['deepseek-'],
      models: [],
      modelMapping: { ' deepseek-flash ': 'deepseek-v4.1-flash' },
      sessionHeader: 'opencode-go',
    }));

    expect(res.status).toBe(200);
    expect(saveCustomProvider).toHaveBeenCalledWith(expect.objectContaining({
      modelMapping: { 'deepseek-flash': 'deepseek-v4.1-flash' },
      sessionHeader: 'opencode-go',
    }));
  });

  it('returns custom User-Agent in the admin provider list', async () => {
    vi.doMock('@/lib/admin', () => ({
      requireAdminAuth: vi.fn(() => null),
    }));
    vi.doMock('@/lib/relay', () => ({
      initAllKeyPools: vi.fn(async () => undefined),
      getKeyPoolStats: vi.fn(() => ({
        custom_newapi: { total: 1, available: 1, keyHashes: [] },
      })),
    }));
    vi.doMock('@/lib/usage/factory', () => ({
      createUsageStorage: vi.fn(async () => ({
        getGlobalUsage: vi.fn(async () => ({ requests: 0, tokens: 0, promptTokens: 0, completionTokens: 0, providers: {} })),
        getMonthlyUsage: vi.fn(async () => ({ requests: 0, tokens: 0, promptTokens: 0, completionTokens: 0, providers: {} })),
        checkQuota: vi.fn(async () => ({ dailyLimit: 0, dailyUsed: 0, monthlyLimit: 0, monthlyUsed: 0, allowed: true, isOverride: false })),
        getErrorStats: vi.fn(async () => ({})),
        getKeyErrors: vi.fn(async () => []),
      })),
    }));
    vi.doMock('@/lib/usage/storage/kv-storage', () => ({
      getUsageSamplingInfo: vi.fn(() => ({ enabled: false })),
    }));
    vi.doMock('@/lib/providers', () => ({
      getAllProviders: vi.fn(async () => ({
        custom_newapi: {
          name: 'custom_newapi',
          displayName: 'Custom NewAPI',
          baseUrl: 'https://example.com/v1',
          headerFormat: 'openai',
          envKeyField: 'CUSTOM_NEWAPI_KEYS',
          modelPrefixes: ['deepseek-'],
          models: [],
          isCustom: true,
          userAgent: 'Mozilla/5.0',
          modelMapping: { 'deepseek-flash': 'deepseek-v4.1-flash' },
          sessionHeader: 'opencode-go',
        },
      })),
    }));
    vi.doMock('@/lib/config/env', () => ({
      getApiKeyMinLength: vi.fn(() => 8),
    }));

    const { GET } = await import('../app/api/admin/route');
    const res = await GET(adminReq());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.providers[0]).toMatchObject({
      id: 'custom_newapi',
      userAgent: 'Mozilla/5.0',
      modelMapping: { 'deepseek-flash': 'deepseek-v4.1-flash' },
      sessionHeader: 'opencode-go',
    });
  });
});
