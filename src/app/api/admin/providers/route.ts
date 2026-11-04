// ============================================================
// AI API Relay — Admin: Custom Provider Management API
// POST/DELETE /api/admin/providers
// ============================================================

import { NextRequest } from 'next/server';
import { requireAdminAuth, getCustomProviders, saveCustomProvider, deleteCustomProvider } from '@/lib/admin';
import { clearProvidersCache } from '@/lib/providers';

export const runtime = 'nodejs';

/**
 * Normalize the optional per-provider fields carried over from the existing
 * config. These are not editable in every form path (deep links, templates), so
 * an absent value must mean "keep what is stored" — never "erase it".
 */
function readModelMapping(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([from, to]) => from.trim() && typeof to === 'string' && (to as string).trim())
    .map(([from, to]) => [from.trim(), (to as string).trim()] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readSessionHeader(value: unknown): 'opencode-go' | undefined {
  // Only the `opencode-go` convention exists today; an unrecognized value means
  // the caller did not send one.
  return value === 'opencode-go' ? 'opencode-go' : undefined;
}

/**
 * POST /api/admin/providers
 * Create or update a custom provider.
 */
export async function POST(request: NextRequest) {
  const authErr = requireAdminAuth(request);
  if (authErr) return authErr;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { message: 'Invalid JSON body', code: 400 } },
      { status: 400 }
    );
  }

  // Validate ProviderConfig
  const { name, displayName, baseUrl, headerFormat, modelPrefixes, models } = body;
  if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9_]+$/.test(name)) {
    return Response.json(
      { error: { message: 'Invalid provider ID/name. Alphanumeric and underscore only.', code: 400 } },
      { status: 400 }
    );
  }
  if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
    return Response.json(
      { error: { message: 'Display name is required', code: 400 } },
      { status: 400 }
    );
  }
  if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.startsWith('https://')) {
    return Response.json(
      { error: { message: 'Base URL is required and must start with https://', code: 400 } },
      { status: 400 }
    );
  }
  if (!headerFormat || !['openai', 'anthropic', 'azure'].includes(headerFormat)) {
    return Response.json(
      { error: { message: 'Invalid header format. Must be openai, anthropic, or azure.', code: 400 } },
      { status: 400 }
    );
  }
  if (!Array.isArray(modelPrefixes) || modelPrefixes.length === 0) {
    return Response.json(
      { error: { message: 'At least one model prefix is required', code: 400 } },
      { status: 400 }
    );
  }

  const existing = (await getCustomProviders(true))[name];

  const providerConfig = {
    name,
    displayName,
    baseUrl,
    headerFormat,
    modelPrefixes: modelPrefixes.map(p => p.trim()).filter(Boolean),
    envKeyField: body.envKeyField || existing?.envKeyField || `${name.toUpperCase()}_KEYS`,
    envBaseUrlField: body.envBaseUrlField || existing?.envBaseUrlField || undefined,
    userAgent: typeof body.userAgent === 'string' && body.userAgent.trim() ? body.userAgent.trim() : undefined,
    sessionHeader: readSessionHeader(body.sessionHeader) ?? readSessionHeader(existing?.sessionHeader),
    models: Array.isArray(models) ? models : [],
    // Saving through the provider modal must not silently drop a rewrite table
    // authored elsewhere (backup restore, KV, deep-link import).
    modelMapping: readModelMapping(body.modelMapping) ?? readModelMapping(existing?.modelMapping),
    isCustom: true,
  };

  try {
    await saveCustomProvider(providerConfig);
    clearProvidersCache();
    return Response.json({ success: true, provider: providerConfig });
  } catch (err: any) {
    return Response.json(
      { error: { message: err.message, code: 500 } },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/providers
 * Delete a custom provider.
 */
export async function DELETE(request: NextRequest) {
  const authErr = requireAdminAuth(request);
  if (authErr) return authErr;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { message: 'Invalid JSON body', code: 400 } },
      { status: 400 }
    );
  }

  const { name } = body;
  if (!name || typeof name !== 'string') {
    return Response.json(
      { error: { message: 'Provider name is required', code: 400 } },
      { status: 400 }
    );
  }

  try {
    await deleteCustomProvider(name);
    clearProvidersCache();
    return Response.json({ success: true });
  } catch (err: any) {
    return Response.json(
      { error: { message: err.message, code: 500 } },
      { status: 500 }
    );
  }
}
