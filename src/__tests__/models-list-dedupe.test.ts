import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  __adminConfigCacheForTests,
  createMemoryMockKV,
  getPriorityRules,
  savePriorityRules,
} from '../lib/admin/admin-config';
import { GET as modelsGET } from '../app/v1/models/route';
import { GET as modelGET } from '../app/v1/models/[model]/route';
import { seedLegacyBuiltInProviders } from './fixtures/legacy-builtin-providers';

function installMockKV() {
  const mock = createMemoryMockKV();
  (global as any)._mockKVInstance = mock;
  (global as any)._mockKVInstance._isMock = true;
  return mock;
}

async function listModels(): Promise<Array<{ id: string; owned_by: string; context_window?: number }>> {
  const res = await modelsGET(new NextRequest('http://localhost/v1/models'));
  const body = await res.json();
  return body.data;
}

async function getModel(id: string): Promise<{ id: string; owned_by: string } | null> {
  const res = await modelGET(new NextRequest(`http://localhost/v1/models/${encodeURIComponent(id)}`), {
    params: Promise.resolve({ model: encodeURIComponent(id) }),
  });
  if (res.status === 404) return null;
  return res.json();
}

describe('/v1/models dedupe and routing attribution', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    __adminConfigCacheForTests.clear();
    installMockKV();
    await seedLegacyBuiltInProviders();
  });

  it('lists a model declared by several providers exactly once', async () => {
    const models = await listModels();
    const ids = models.map((m) => m.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  it('reports the provider a priority rule routes to, not the one that declared the model', async () => {
    // `gpt-5.5` is declared by the openai fixture alone; the rule sends it to anthropic.
    await savePriorityRules([
      {
        id: 'rule-gpt55',
        name: 'Rule gpt-5.5',
        priority: 1,
        enabled: true,
        provider: 'openai',
        modelPattern: 'gpt-5.5',
        providerOrder: ['anthropic', 'openai'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const models = await listModels();
    const entry = models.find((m) => m.id === 'gpt-5.5');
    expect(entry?.owned_by).toBe('anthropic');
    // The declaring provider's metadata is still what gets reported.
    expect(entry?.context_window).toBe(1000000);
  });

  it('collapses the rows a rule made redundant and keeps one entry per id', async () => {
    await savePriorityRules([
      {
        id: 'rule-gpt55',
        name: 'Rule gpt-5.5',
        priority: 1,
        enabled: true,
        provider: 'openai',
        modelPattern: 'gpt-5.5',
        providerOrder: ['anthropic', 'openai'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const models = await listModels();
    const gpt55 = models.filter((m) => m.id === 'gpt-5.5');
    expect(gpt55).toHaveLength(1);
    expect(gpt55[0].owned_by).toBe('anthropic');
  });

  it('keeps the declaring provider when no rule matches', async () => {
    const models = await listModels();
    expect(models.find((m) => m.id === 'gpt-5.4')?.owned_by).toBe('openai');
  });

  it('applies the same attribution on the single-model endpoint', async () => {
    await savePriorityRules([
      {
        id: 'rule-gpt55',
        name: 'Rule gpt-5.5',
        priority: 1,
        enabled: true,
        provider: 'openai',
        modelPattern: 'gpt-5.5',
        providerOrder: ['anthropic', 'openai'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const single = await getModel('gpt-5.5');
    expect(single?.owned_by).toBe('anthropic');
  });

  it('falls back to the declaring provider when the rule names no known provider', async () => {
    await savePriorityRules([
      {
        id: 'rule-ghost',
        name: 'Rule ghost',
        priority: 1,
        enabled: true,
        provider: 'openai',
        modelPattern: 'gpt-5.4',
        providerOrder: ['provider_that_does_not_exist'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    // normalizePriorityRules keeps the rule, but no provider in the order exists.
    const rules = await getPriorityRules();
    const models = await listModels();
    const entry = models.find((m) => m.id === 'gpt-5.4');
    expect(rules.length).toBeGreaterThan(0);
    expect(entry?.owned_by).toBe('openai');
  });
});
