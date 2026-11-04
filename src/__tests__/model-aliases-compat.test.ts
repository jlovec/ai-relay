import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  __adminConfigCacheForTests,
  createMemoryMockKV,
  getModelAliasConfig,
  saveModelAliasConfig,
} from '../lib/admin/admin-config';
import { GET, POST } from '../app/api/admin/model-aliases/route';
import { POST as importPOST } from '../app/api/admin/model-aliases/import/route';
import { GET as exportGET } from '../app/api/admin/model-aliases/export/route';
import { seedLegacyBuiltInProviders } from './fixtures/legacy-builtin-providers';

function installMockKV() {
  const mock = createMemoryMockKV();
  (global as any)._mockKVInstance = mock;
  (global as any)._mockKVInstance._isMock = true;
  return mock;
}

function jsonReq(method: string, body?: unknown, url = 'http://localhost/api/admin/model-aliases') {
  return new NextRequest(url, {
    method,
    headers: {
      Authorization: 'Bearer admin-test-key',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function csvReq(csv: string, mode = 'append', preview = false) {
  const form = new FormData();
  form.set('mode', mode);
  if (preview) form.set('preview', 'true');
  form.set('file', new File([csv], 'aliases.csv', { type: 'text/csv' }));
  return new NextRequest('http://localhost/api/admin/model-aliases/import', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-test-key' },
    body: form,
  });
}

describe('model-aliases compatibility API', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('RELAY_ADMIN_KEY', 'admin-test-key');
    __adminConfigCacheForTests.clear();
    installMockKV();
    await seedLegacyBuiltInProviders();
  });

  it('serves CRUD at /api/admin/model-aliases while preserving /api/admin/aliases shape', async () => {
    let res = await POST(jsonReq('POST', { alias: 'BossFast', target: 'gpt-5.4-mini' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      alias: { alias: 'bossfast', target: 'gpt-5.4-mini', source: 'user' },
    });

    res = await GET(jsonReq('GET'));
    const body = await res.json();
    expect(body.aliases.bossfast).toMatchObject({ target: 'gpt-5.4-mini', source: 'user' });
    // No built-in aliases are seeded into the list any more.
    expect(body.aliases['gpt-fast']).toBeUndefined();
  });

  it('previews CSV import without persisting and reports duplicate/append conflicts', async () => {
    await saveModelAliasConfig({ aliases: { fast: 'gpt-5.4-mini' }, hidden: [] });
    const csv = 'alias,target_model,hidden,note\nfast,gpt-5.4,false,exists\nsmart,claude-sonnet-4-6,false,new\nsmart,gpt-5.4-mini,false,duplicate\nbad alias,gpt-5.4,false,bad\n';

    const res = await importPOST(csvReq(csv, 'append', true));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.preview).toBe(true);
    expect(body.stats).toMatchObject({ added: 1, updated: 0, skipped: 3, errors: 3 });
    expect(body.rows.slice(0, 4).map((row: { status: string }) => row.status)).toEqual(['skipped', 'added', 'error', 'error']);
    expect(body.errors.map((item: { error: string }) => item.error)).toContain('已存在');
    await expect(getModelAliasConfig()).resolves.toMatchObject({ aliases: { fast: 'gpt-5.4-mini' } });
  });

  it('exports user aliases from the model-aliases endpoint for round-trip backup', async () => {
    await saveModelAliasConfig({ aliases: { fast: 'gpt-5.4-mini' }, hidden: ['gpt-5.4'] });

    const res = await exportGET(jsonReq('GET', undefined, 'http://localhost/api/admin/model-aliases/export'));
    expect(res.headers.get('content-type')).toContain('text/csv');
    const csv = await res.text();
    expect(csv).toContain('alias,target_model,hidden,note');
    expect(csv).toContain('fast,gpt-5.4-mini,false,用户自定义');
    // Built-in rows are gone, so the export carries only what the user authored.
    expect(csv).not.toContain('系统默认');
  });
});
