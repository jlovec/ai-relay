import { describe, it, expect } from 'vitest';
import { buildHeaders } from '../lib/relay/transform';

describe('Upstream session header injection', () => {
  it('adds no session header when the provider does not declare one', () => {
    const headers = buildHeaders('openai', 'sk-test', false);

    expect(headers['X-Opencode-Session']).toBeUndefined();
  });

  it('reuses the client session header for opencode-go providers', () => {
    const headers = buildHeaders(
      'openai',
      'sk-test',
      false,
      undefined,
      undefined,
      { 'x-opencode-session': 'client-session-123' },
      'opencode-go'
    );

    expect(headers['X-Opencode-Session']).toBe('client-session-123');
  });

  it('falls back to the legacy session affinity header', () => {
    const headers = buildHeaders(
      'openai',
      'sk-test',
      false,
      undefined,
      undefined,
      { 'x-session-affinity': 'affinity-456' },
      'opencode-go'
    );

    expect(headers['X-Opencode-Session']).toBe('affinity-456');
  });

  it('generates a session id when the client sends none', () => {
    const headers = buildHeaders(
      'openai',
      'sk-test',
      false,
      undefined,
      undefined,
      undefined,
      'opencode-go'
    );

    expect(headers['X-Opencode-Session']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('generates a different id per request rather than reusing state', () => {
    const first = buildHeaders('openai', 'sk-test', false, undefined, undefined, undefined, 'opencode-go');
    const second = buildHeaders('openai', 'sk-test', false, undefined, undefined, undefined, 'opencode-go');

    expect(first['X-Opencode-Session']).not.toBe(second['X-Opencode-Session']);
  });

  it('prefers the opencode header over the session id header', () => {
    const headers = buildHeaders(
      'openai',
      'sk-test',
      false,
      undefined,
      undefined,
      { 'x-session-id': 'lower-priority', 'x-opencode-session': 'higher-priority' },
      'opencode-go'
    );

    expect(headers['X-Opencode-Session']).toBe('higher-priority');
  });

  it('does not leave a duplicate header from passthrough', () => {
    const headers = buildHeaders(
      'anthropic',
      'sk-test',
      true,
      undefined,
      undefined,
      { 'X-OpenCode-Session': 'mixed-case-value' },
      'opencode-go'
    );

    const matching = Object.keys(headers).filter(
      (name) => name.toLowerCase() === 'x-opencode-session'
    );

    expect(matching).toHaveLength(1);
    expect(headers['X-Opencode-Session']).toBe('mixed-case-value');
  });

  it('ignores blank client session values', () => {
    const headers = buildHeaders(
      'openai',
      'sk-test',
      false,
      undefined,
      undefined,
      { 'x-opencode-session': '   ' },
      'opencode-go'
    );

    expect(headers['X-Opencode-Session'].trim()).not.toBe('');
  });
});
