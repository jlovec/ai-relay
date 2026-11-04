'use client';

import React, { useEffect, useMemo, useState } from 'react';
import type { AdminData } from '../types';
import HelpIcon from './HelpIcon';

interface ProviderConfigEditorProps {
  data: AdminData;
  lang: 'zh' | 'en';
  t: any;
  selectedProvider: string | null;
  setSelectedProvider: (provider: string | null) => void;
  providerKeys: Array<{ hash: string; masked: string; source: string }> | null;
  providerFallbacks: {
    current: string[];
    staticDefault: string | null;
    staticDefaults: string[];
    isOverride: boolean;
    availableModels: Record<string, { id: string; displayName: string }[]>;
  } | null;
  newKeyInput: string;
  setNewKeyInput: (val: string) => void;
  operationLoading: boolean;
  configMessage: { text: string; type: 'success' | 'error' } | null;
  setConfigMessage: (msg: { text: string; type: 'success' | 'error' } | null) => void;
  testingHash: string | null;
  testingInput: boolean;
  activeFallbacks: string[];
  setActiveFallbacks: (fallbacks: string[]) => void;
  selectedFallbackToAdd: string;
  setSelectedFallbackToAdd: (val: string) => void;
  onAddKey: () => Promise<void>;
  onDeleteKey: (providerId: string, hash: string) => Promise<void>;
  onTestKey: (providerId: string, hash: string, modelId?: string) => Promise<void>;
  onTestInputKey: (modelId?: string) => Promise<void>;
  onTestAndAddKey: (modelId?: string) => Promise<void>;
  onSaveFallbacks: (newChain: string[]) => Promise<void>;
  onResetFallbacks: () => Promise<void>;
  setEditingCustomProvider: (val: any) => void;
  setCustomProviderModalOpen: (val: boolean) => void;
  onDeleteCustomProvider: (name: string) => Promise<void>;
}

export default function ProviderConfigEditor({
  data,
  lang,
  t,
  selectedProvider,
  setSelectedProvider,
  providerKeys,
  providerFallbacks,
  newKeyInput,
  setNewKeyInput,
  operationLoading,
  configMessage,
  setConfigMessage,
  testingHash,
  testingInput,
  activeFallbacks,
  setActiveFallbacks,
  selectedFallbackToAdd,
  setSelectedFallbackToAdd,
  onAddKey,
  onDeleteKey,
  onTestKey,
  onTestInputKey,
  onTestAndAddKey,
  onSaveFallbacks,
  onResetFallbacks,
  setEditingCustomProvider,
  setCustomProviderModalOpen,
  onDeleteCustomProvider,
}: ProviderConfigEditorProps) {
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [selectedInputModel, setSelectedInputModel] = useState('');

  const currentProviderObj = selectedProvider ? data.providers.find(p => p.id === selectedProvider) : undefined;
  const providerModels = useMemo(() => currentProviderObj?.models || [], [currentProviderObj]);
  const inputKeyCount = newKeyInput.split(/\r?\n/).map((key) => key.trim()).filter(Boolean).length;
  const canTestInputKey = inputKeyCount === 1;

  useEffect(() => {
    if (selectedInputModel && !providerModels.some((m) => m.id === selectedInputModel)) {
      setSelectedInputModel('');
    }
  }, [providerModels, selectedInputModel]);

  if (!selectedProvider) return null;

  return (
    <section
      className="config-card glass-panel"
      style={{
        border: '1px solid rgba(59, 130, 246, 0.3)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), 0 0 15px rgba(59, 130, 246, 0.1)',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        paddingBottom: '1rem',
        marginBottom: '1.5rem',
      }}>
        <div>
          <h2 style={{ fontSize: '1.3rem', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#fff', fontWeight: 600 }}>
            {t.configureTitle.replace('{name}', currentProviderObj?.name || selectedProvider)}
          </h2>
          <span style={{ fontSize: '0.85rem', color: '#9ca3af' }}>
            {t.providerIdLabel} <code style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{selectedProvider}</code>
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {currentProviderObj?.isCustom && (
            <>
              <button
                onClick={() => {
                  if (currentProviderObj) {
                    setEditingCustomProvider({
                      id: currentProviderObj.id,
                      name: currentProviderObj.name,
                      baseUrl: currentProviderObj.baseUrl,
                      headerFormat: currentProviderObj.headerFormat || 'openai',
                      modelPrefixes: currentProviderObj.modelPrefixes || [],
                      models: currentProviderObj.models || [],
                      modelMapping: currentProviderObj.modelMapping,
                      sessionHeader: currentProviderObj.sessionHeader,
                      keyCount: currentProviderObj.keyCount || 0,
                      userAgent: currentProviderObj.userAgent,
                    });
                    setCustomProviderModalOpen(true);
                  }
                }}
                style={{
                  padding: '0.4rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid rgba(245, 158, 11, 0.4)',
                  backgroundColor: 'rgba(245, 158, 11, 0.1)',
                  color: '#fbbf24',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(245, 158, 11, 0.2)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'rgba(245, 158, 11, 0.1)'; }}
              >
                {t.editCustomProvider}
              </button>
              <button
                onClick={() => {
                  if (currentProviderObj) {
                    onDeleteCustomProvider(currentProviderObj.id);
                  }
                }}
                style={{
                  padding: '0.4rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                  color: '#f87171',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.2)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.1)'; }}
              >
                🗑️ {lang === 'zh' ? '删除' : 'Delete'}
              </button>
            </>
          )}
          <button
            onClick={() => setSelectedProvider(null)}
            style={{
              padding: '0.4rem 0.8rem',
              borderRadius: '6px',
              border: '1px solid rgba(255,255,255,0.08)',
              backgroundColor: 'rgba(255,255,255,0.04)',
              color: '#d1d5db',
              cursor: 'pointer',
              fontSize: '0.85rem',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#d1d5db'; }}
          >
            {t.btnClose}
          </button>
        </div>
      </div>

      {/* Config Loading / Message */}
      {operationLoading && !providerKeys && !providerFallbacks && (
        <div style={{ color: '#9ca3af', textAlign: 'center', padding: '2rem' }}>
          {t.loadingConfig}
        </div>
      )}

      {configMessage && (
        <div style={{
          padding: '0.75rem 1rem',
          borderRadius: '8px',
          marginBottom: '1.5rem',
          fontSize: '0.9rem',
          border: configMessage.type === 'success' ? '1px solid rgba(16, 185, 129, 0.2)' : '1px solid rgba(239, 68, 68, 0.2)',
          backgroundColor: configMessage.type === 'success' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
          color: configMessage.type === 'success' ? '#34d399' : '#fca5a5',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '0.75rem',
        }}>
          <span style={{
            minWidth: 0,
            maxHeight: '8rem',
            overflowY: 'auto',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
            lineHeight: 1.45,
          }}>{configMessage.text}</span>
          <button
            onClick={() => setConfigMessage(null)}
            style={{
              background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '1.2rem', padding: '0 0.5rem', flexShrink: 0
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Core Configuration Content */}
      {(providerKeys || providerFallbacks) && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '2rem',
        }}>

          {/* Column 1: API Key Pool */}
          <div>
            <h3 style={{ fontSize: '1.1rem', marginTop: 0, marginBottom: '0.75rem', color: '#e5e7eb', fontWeight: 600 }}>
              {t.apiKeyPoolTitle}
            </h3>

            {/* Overriding Info Warning */}
            <div style={{
              padding: '0.75rem',
              borderRadius: '8px',
              backgroundColor: providerKeys && providerKeys.length > 0 && providerKeys[0].source === 'managed'
                ? 'rgba(245, 158, 11, 0.08)'
                : 'rgba(59, 130, 246, 0.08)',
              border: providerKeys && providerKeys.length > 0 && providerKeys[0].source === 'managed'
                ? '1px solid rgba(245, 158, 11, 0.15)'
                : '1px solid rgba(59, 130, 246, 0.15)',
              color: providerKeys && providerKeys.length > 0 && providerKeys[0].source === 'managed' ? '#fbbf24' : '#60a5fa',
              fontSize: '0.85rem',
              lineHeight: '1.4',
              marginBottom: '1rem',
            }}>
              {providerKeys && providerKeys.length > 0 && providerKeys[0].source === 'managed' ? (
                <span>{t.kvWarningManaged}</span>
              ) : (
                <span>{t.kvWarningEnv}</span>
              )}
            </div>

            {/* Add Key Form */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
              <textarea
                placeholder={t.addKeyPlaceholder}
                value={newKeyInput}
                onChange={(e) => setNewKeyInput(e.target.value)}
                disabled={operationLoading}
                rows={3}
                style={{
                  flex: 1,
                  padding: '0.6rem 0.8rem',
                  minWidth: '220px',
                  minHeight: '86px',
                  resize: 'vertical',
                  borderRadius: '6px',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  backgroundColor: 'rgba(0, 0, 0, 0.25)',
                  color: '#fff',
                  fontSize: '0.9rem',
                  lineHeight: 1.45,
                  outline: 'none',
                  transition: 'border-color 0.2s',
                }}
                onFocus={(e) => e.target.style.borderColor = 'rgba(59, 130, 246, 0.5)'}
                onBlur={(e) => e.target.style.borderColor = 'rgba(255, 255, 255, 0.08)'}
              />
              <select
                value={selectedInputModel}
                onChange={(e) => setSelectedInputModel(e.target.value)}
                disabled={operationLoading || testingInput}
                title={t.testModelLabel}
                aria-label={t.testModelLabel}
                style={{
                  width: '170px',
                  padding: '0.6rem 2rem 0.6rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  backgroundColor: 'rgba(0, 0, 0, 0.25)',
                  color: '#d1d5db',
                  fontSize: '0.85rem',
                  outline: 'none',
                  cursor: operationLoading || testingInput ? 'not-allowed' : 'pointer',
                  appearance: 'none',
                  backgroundImage: `url("data:image/svg+xml;utf8,<svg fill='none' height='12' stroke='%239ca3af' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' viewBox='0 0 24 24' width='12' xmlns='http://www.w3.org/2000/svg'><polyline points='6 9 12 15 18 9'/></svg>")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 0.65rem center',
                  backgroundSize: '0.75rem',
                }}
              >
                <option value="">{t.modelSelectorAuto}</option>
                {providerModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName || m.id}
                  </option>
                ))}
              </select>
              <button
                onClick={() => onTestInputKey(selectedInputModel)}
                disabled={operationLoading || testingInput || !newKeyInput.trim() || !canTestInputKey}
                style={{
                  padding: '0.6rem 1rem',
                  borderRadius: '6px',
                  border: '1px solid rgba(59, 130, 246, 0.3)',
                  backgroundColor: 'rgba(59, 130, 246, 0.1)',
                  color: '#60a5fa',
                  fontWeight: '500',
                  fontSize: '0.9rem',
                  cursor: operationLoading || testingInput || !newKeyInput.trim() || !canTestInputKey ? 'not-allowed' : 'pointer',
                  opacity: operationLoading || testingInput || !newKeyInput.trim() || !canTestInputKey ? 0.5 : 1,
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.2)'; }}
                onMouseLeave={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.1)'; }}
              >
                {testingInput ? t.btnTestingKey : t.btnTestKey}
              </button>
              <button
                onClick={() => onTestAndAddKey(selectedInputModel)}
                disabled={operationLoading || testingInput || !newKeyInput.trim() || !canTestInputKey}
                style={{
                  padding: '0.6rem 1rem',
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: '#7c3aed',
                  color: 'white',
                  fontWeight: 'bold',
                  fontSize: '0.9rem',
                  cursor: operationLoading || testingInput || !newKeyInput.trim() || !canTestInputKey ? 'not-allowed' : 'pointer',
                  opacity: operationLoading || testingInput || !newKeyInput.trim() || !canTestInputKey ? 0.5 : 1,
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = '#6d28d9'; }}
                onMouseLeave={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = '#7c3aed'; }}
              >
                {testingInput ? t.btnTestingKey : t.btnTestAndAddKey}
              </button>
              <button
                onClick={onAddKey}
                disabled={operationLoading || !newKeyInput.trim()}
                style={{
                  padding: '0.6rem 1rem',
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: '#2563eb',
                  color: 'white',
                  fontWeight: 'bold',
                  fontSize: '0.9rem',
                  cursor: operationLoading || !newKeyInput.trim() ? 'not-allowed' : 'pointer',
                  opacity: operationLoading || !newKeyInput.trim() ? 0.5 : 1,
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = '#1d4ed8'; }}
                onMouseLeave={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = '#2563eb'; }}
              >
                {t.btnAddKey}
              </button>
              <div style={{
                flexBasis: '100%',
                color: '#9ca3af',
                fontSize: '0.78rem',
                lineHeight: 1.4,
              }}>
                {t.addKeyHelp}
              </div>
            </div>

            {/* Keys list */}
            <div style={{
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: '8px',
              backgroundColor: 'rgba(0, 0, 0, 0.15)',
              maxHeight: '280px',
              overflowY: 'auto',
            }}>
              {(() => {
                const models = currentProviderObj?.models || [];
                return providerKeys && providerKeys.length > 0 ? (
                  providerKeys.map((key) => {
                    const isEnv = key.source === 'env';
                    return (
                      <div
                        key={key.hash}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '0.75rem 0.8rem',
                          borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                          <code style={{ fontSize: '0.85rem', color: '#e5e7eb', fontFamily: 'monospace' }}>
                            {key.masked}
                          </code>
                          <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
                            {t.keyHashLabel} <code style={{ fontFamily: 'monospace', color: '#d1d5db' }}>{key.hash.slice(0, 8)}</code>
                          </span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{
                            fontSize: '0.75rem',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '4px',
                            backgroundColor: isEnv ? 'rgba(59, 130, 246, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                            color: isEnv ? '#60a5fa' : '#34d399',
                            border: isEnv ? '1px solid rgba(59, 130, 246, 0.2)' : '1px solid rgba(16, 185, 129, 0.2)',
                          }}>
                            {isEnv ? t.keySourceEnv : t.keySourceKv}
                          </span>

                          <select
                            value={selectedModels[key.hash] || ''}
                            onChange={(e) => setSelectedModels(prev => ({ ...prev, [key.hash]: e.target.value }))}
                            disabled={operationLoading || testingHash !== null}
                            style={{
                              padding: '0.15rem 1.8rem 0.15rem 0.4rem',
                              borderRadius: '4px',
                              border: '1px solid rgba(255, 255, 255, 0.08)',
                              backgroundColor: 'rgba(0, 0, 0, 0.25)',
                              color: '#d1d5db',
                              fontSize: '0.75rem',
                              outline: 'none',
                              cursor: 'pointer',
                              appearance: 'none',
                              backgroundImage: `url("data:image/svg+xml;utf8,<svg fill='none' height='12' stroke='%239ca3af' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' viewBox='0 0 24 24' width='12' xmlns='http://www.w3.org/2000/svg'><polyline points='6 9 12 15 18 9'/></svg>")`,
                              backgroundRepeat: 'no-repeat',
                              backgroundPosition: 'right 0.4rem center',
                              backgroundSize: '0.6rem',
                            }}
                          >
                            <option value="">{lang === 'zh' ? '自动 (默认)' : 'Auto (Default)'}</option>
                            {models.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.displayName || m.id}
                              </option>
                            ))}
                          </select>

                          <button
                            onClick={() => onTestKey(selectedProvider, key.hash, selectedModels[key.hash])}
                            disabled={operationLoading || testingHash !== null}
                            style={{
                              padding: '0.25rem 0.5rem',
                              borderRadius: '4px',
                              border: '1px solid rgba(59, 130, 246, 0.3)',
                              backgroundColor: 'rgba(59, 130, 246, 0.1)',
                              color: '#60a5fa',
                              fontSize: '0.75rem',
                              cursor: operationLoading || testingHash !== null ? 'not-allowed' : 'pointer',
                              opacity: operationLoading || testingHash !== null ? 0.5 : 1,
                              transition: 'all 0.2s',
                            }}
                            onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.2)'; }}
                            onMouseLeave={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.1)'; }}
                          >
                            {testingHash === key.hash ? t.btnTestingKey : t.btnTestKey}
                          </button>

                          <button
                            onClick={() => onDeleteKey(selectedProvider, key.hash)}
                            disabled={operationLoading}
                            style={{
                              padding: '0.25rem 0.5rem',
                              borderRadius: '4px',
                              border: '1px solid rgba(239, 68, 68, 0.3)',
                              backgroundColor: 'rgba(239, 68, 68, 0.1)',
                              color: '#ef4444',
                              fontSize: '0.75rem',
                              cursor: operationLoading ? 'not-allowed' : 'pointer',
                              opacity: operationLoading ? 0.5 : 1,
                              transition: 'all 0.2s',
                            }}
                            onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.2)'; }}
                            onMouseLeave={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.1)'; }}
                            title={isEnv ? t.deleteEnvKeyTitle : t.deleteKvKeyTitle}
                          >
                            {t.btnDeleteKey}
                          </button>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ color: '#9ca3af', fontSize: '0.9rem', padding: '1.5rem', textAlign: 'center' }}>
                    {t.noKeysConfigured}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Column 2 (Fallback Chain) was moved to the Routing Policy tab.
              See FallbackChainEditor.tsx for the standalone component. */}

        </div>
      )}
    </section>
  );
}
