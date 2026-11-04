import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  __adminConfigCacheForTests,
  createMemoryMockKV,
  getModelAliasConfig,
  saveModelAliasConfig,
} from '../lib/admin/admin-config';
import { resolveModelAlias } from '../lib/providers/resolver';
import { GET as modelsGET } from '../app/v1/models/route';
import { GET, PUT, POST, DELETE } from '../app/api/admin/aliases/route';
import { POST as importPOST } from '../app/api/admin/aliases/import/route';
import { GET as exportGET } from '../app/api/admin/aliases/export/route';
import { seedLegacyBuiltInProviders } from './fixtures/legacy-builtin-providers';

function installMockKV() {
  const mock = createMemoryMockKV();
  (global as any)._mockKVInstance = mock;
  (global as any)._mockKVInstance._isMock = true;
  return mock;
}

function req(method: string, body?: unknown, url = 'http://localhost/api/admin/aliases') {
  return new NextRequest(url, {
    method,
    headers: {
      Authorization: 'Bearer admin-test-key',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function csvReq(csv: string, mode = 'append') {
  const form = new FormData();
  form.set('mode', mode);
  form.set('file', new File([csv], 'aliases.csv', { type: 'text/csv' }));
  return new NextRequest('http://localhost/api/admin/aliases/import', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-test-key' },
    body: form,
  });
}

describe('model aliases admin config', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('RELAY_ADMIN_KEY', 'admin-test-key');
    __adminConfigCacheForTests.clear();
    installMockKV();
    // Alias targets are validated against registered model ids; the built-ins
    // that used to supply `gpt-5.4-mini` / `claude-sonnet-4-6` are now fixtures.
    await seedLegacyBuiltInProviders();
  });

  it('persists aliases and hidden models at relay:models:aliases with a 5 minute read cache', async () => {
    const kv = installMockKV();
    const originalGet = kv.get.bind(kv);
    kv.get = vi.fn((key: string) => originalGet(key));

    await saveModelAliasConfig({ aliases: { fast: 'gpt-5.4-mini' }, hidden: ['gpt-5.4-nano'] });

    await expect(kv.get('relay:models:aliases')).resolves.toBeTruthy();
    vi.mocked(kv.get).mockClear();
    await expect(getModelAliasConfig()).resolves.toMatchObject({ aliases: { fast: 'gpt-5.4-mini' }, hidden: ['gpt-5.4-nano'] });
    await expect(getModelAliasConfig()).resolves.toMatchObject({ aliases: { fast: 'gpt-5.4-mini' } });
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it('resolves user aliases from KV and leaves un-aliased names untouched', async () => {
    await saveModelAliasConfig({ aliases: { fast: 'gpt-5.4-mini', flagship: 'gpt-5.5' }, hidden: [] });

    await expect(resolveModelAlias('FAST')).resolves.toBe('gpt-5.4-mini');
    await expect(resolveModelAlias('flagship')).resolves.toBe('gpt-5.5');
    // Built-in aliases no longer exist; only user-authored ones rewrite.
    await expect(resolveModelAlias('claude-sonnet')).resolves.toBe('claude-sonnet');
  });

  it('rejects aliases whose target model is not registered in any provider', async () => {
    const res = await POST(req('POST', { alias: 'ghost', target: 'not-a-real-model' }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { message: 'Target model does not exist' } });
  });

  it('resolves alias chains and stops cyclic aliases at a safe depth', async () => {
    await saveModelAliasConfig({
      aliases: {
        fast: 'smart',
        smart: 'gpt-5.4-mini',
        loop_a: 'loop_b',
        loop_b: 'loop_a',
      },
      hidden: [],
    });

    await expect(resolveModelAlias('fast')).resolves.toBe('gpt-5.4-mini');
    await expect(resolveModelAlias('loop_a')).resolves.toBe('loop_a');
  });

  it('exposes CRUD API for model aliases and rejects invalid aliases', async () => {
    let res = await POST(req('POST', { alias: 'Fast_Model', target: 'gpt-5.4-mini', hidden: false }));
    await expect(res.json()).resolves.toMatchObject({ success: true, alias: { alias: 'fast_model', target: 'gpt-5.4-mini', source: 'user' } });

    res = await POST(req('POST', { alias: 'bad alias', target: 'gpt-5.4-mini' }));
    expect(res.status).toBe(400);

    res = await PUT(req('PUT', { aliases: { smart: 'claude-sonnet-4-6' }, hidden: ['gpt-5.4-nano'] }));
    await expect(res.json()).resolves.toMatchObject({ success: true, hidden: ['gpt-5.4-nano'] });

    res = await GET(req('GET'));
    const body = await res.json();
    expect(body.aliases.smart).toMatchObject({ target: 'claude-sonnet-4-6', source: 'user' });
    expect(body.total).toBeGreaterThan(0);

    res = await DELETE(req('DELETE', undefined, 'http://localhost/api/admin/aliases?alias=smart'));
    await expect(res.json()).resolves.toMatchObject({ success: true });
    await expect(getModelAliasConfig()).resolves.toMatchObject({ aliases: {} });
  });

  it('imports and exports CSV with alias targets and hidden flags', async () => {
    const csv = 'alias,target_model,hidden,note\nfast,gpt-5.4-mini,false,team\ncheap,gpt-5.4-nano,true,cost\n';

    const importRes = await importPOST(csvReq(csv));
    await expect(importRes.json()).resolves.toMatchObject({ success: true, stats: { added: 2, errors: 0 } });

    const exportRes = await exportGET(req('GET', undefined, 'http://localhost/api/admin/aliases/export'));
    expect(exportRes.headers.get('content-type')).toContain('text/csv');
    const exported = await exportRes.text();
    expect(exported).toContain('alias,target_model,hidden,note');
    expect(exported).toContain('fast,gpt-5.4-mini,false,');
    expect(exported).toContain('cheap,gpt-5.4-nano,true,');
  });

  it('filters hidden models from /v1/models without disabling direct alias resolution', async () => {
    await saveModelAliasConfig({ aliases: { cheap: 'gpt-5.4-nano' }, hidden: ['gpt-5.4-nano'] });

    const res = await modelsGET(new NextRequest('http://localhost/v1/models'));
    const body = await res.json();
    expect(body.data.some((model: { id: string }) => model.id === 'gpt-5.4-nano')).toBe(false);
    await expect(resolveModelAlias('cheap')).resolves.toBe('gpt-5.4-nano');
  });
});
