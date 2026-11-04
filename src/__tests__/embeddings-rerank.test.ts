import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

function req(path: string, body: unknown, key = 'relay-test-key') {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Point the siliconflow provider at a fake upstream so `fetch` is asserted, not
 * performed. The provider is registered by the shared test KV store, mirroring
 * the other provider tests.
 */
async function withSiliconflow(handler: () => Promise<Response>): Promise<Response> {
  return handler();
}

describe('/v1/embeddings', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('RELAY_API_KEY', 'relay-test-key');
    vi.stubEnv('SILICONFLOW_KEYS', 'sf-upstream-key');
    vi.stubEnv('RELAY_DAILY_LIMIT', '0');
    vi.stubEnv('RELAY_MONTHLY_LIMIT', '0');
  });

  it('forwards to the provider /embeddings path and returns the upstream body verbatim', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      object: 'list',
      model: 'BAAI/bge-m3',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: 8, total_tokens: 8 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('../app/v1/embeddings/route');
    const { saveCustomProvider } = await import('../lib/admin/admin-config');
    await saveCustomProvider({
      name: 'siliconflow',
      displayName: 'SiliconFlow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      modelPrefixes: ['BAAI/'],
      headerFormat: 'openai',
      envKeyField: 'SILICONFLOW_KEYS',
      models: [
        { id: 'BAAI/bge-m3', displayName: 'BGE M3', contextWindow: 8192 },
      ],
    } as never);

    const res = await POST(req('/v1/embeddings', { model: 'BAAI/bge-m3', input: '你好' }));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://api.siliconflow.cn/v1/embeddings');
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe('BAAI/bge-m3');
    expect(sent.input).toBe('你好');

    const json = await res.json();
    expect(json.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(res.headers.get('X-Relay-Provider')).toBe('siliconflow');
  });

  it('rejects a missing input with 400 and never calls upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('../app/v1/embeddings/route');
    const res = await POST(req('/v1/embeddings', { model: 'BAAI/bge-m3' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.message).toContain('input');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty input array with 400', async () => {
    const { POST } = await import('../app/v1/embeddings/route');
    const res = await POST(req('/v1/embeddings', { model: 'BAAI/bge-m3', input: [] }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing relay API key with 401', async () => {
    const { POST } = await import('../app/v1/embeddings/route');
    const res = await POST(new NextRequest('http://localhost/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'BAAI/bge-m3', input: 'x' }),
    }));
    expect(res.status).toBe(401);
  });

  it('returns 400 (not 502) for an unknown model', async () => {
    const { POST } = await import('../app/v1/embeddings/route');
    const res = await POST(req('/v1/embeddings', { model: 'Qwen/NotExist', input: 'x' }));
    expect(res.status).toBe(400);
  });
});

describe('/v1/rerank', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('RELAY_API_KEY', 'relay-test-key');
    vi.stubEnv('SILICONFLOW_KEYS', 'sf-upstream-key');
    vi.stubEnv('RELAY_DAILY_LIMIT', '0');
    vi.stubEnv('RELAY_MONTHLY_LIMIT', '0');
  });

  it('forwards query + documents to /rerank and passes results through', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      id: 'rerank-1',
      results: [
        { index: 0, relevance_score: 0.887 },
        { index: 1, relevance_score: 0.11 },
      ],
      meta: { tokens: { input_tokens: 20, output_tokens: 0 } },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { saveCustomProvider } = await import('../lib/admin/admin-config');
    await saveCustomProvider({
      name: 'siliconflow',
      displayName: 'SiliconFlow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      modelPrefixes: ['BAAI/'],
      headerFormat: 'openai',
      envKeyField: 'SILICONFLOW_KEYS',
      models: [
        { id: 'BAAI/bge-reranker-v2-m3', displayName: 'BGE Reranker', contextWindow: 8192 },
      ],
    } as never);

    const { POST } = await import('../app/v1/rerank/route');
    const res = await POST(req('/v1/rerank', {
      model: 'BAAI/bge-reranker-v2-m3',
      query: '猫',
      documents: ['猫很可爱', '狗也不错'],
    }));

    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://api.siliconflow.cn/v1/rerank');
    const sent = JSON.parse(String(init.body));
    expect(sent.query).toBe('猫');
    expect(sent.documents).toEqual(['猫很可爱', '狗也不错']);

    const json = await res.json();
    expect(json.results[0].relevance_score).toBeCloseTo(0.887);
  });

  it('rejects a missing documents field with 400', async () => {
    const { POST } = await import('../app/v1/rerank/route');
    const res = await POST(req('/v1/rerank', { model: 'BAAI/bge-reranker-v2-m3', query: '猫' }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing query field with 400', async () => {
    const { POST } = await import('../app/v1/rerank/route');
    const res = await POST(req('/v1/rerank', {
      model: 'BAAI/bge-reranker-v2-m3',
      documents: ['a'],
    }));
    expect(res.status).toBe(400);
  });
});
