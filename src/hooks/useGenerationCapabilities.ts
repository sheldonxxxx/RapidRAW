import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAuth } from '@clerk/react';
import { Invokes } from '../components/ui/AppProperties';
import { scopedCapabilities, type CapabilityState, type GenerationCapabilities } from '../utils/generationOptions';

export function useGenerationCapabilities(provider: string, address: string, connected: boolean) {
  const { getToken } = useAuth();
  const scope = JSON.stringify([provider, address]);
  const enabled = provider === 'ai-connector' && !!address.trim() && connected;
  const [state, setState] = useState<CapabilityState>({ scope: '', status: 'inactive' });
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('focus', retry);
    return () => window.removeEventListener('focus', retry);
  }, [enabled, retry]);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setState({ scope, status: 'loading' });
    async function load() {
      try {
        const token = await getToken();
        const data = await invoke<GenerationCapabilities | null>(Invokes.GetAiConnectorCapabilities, {
          address,
          token: token || null,
        });
        if (current) setState(data ? { scope, status: 'ready', data } : { scope, status: 'legacy' });
      } catch (error) {
        if (current) setState({ scope, status: 'error', message: String(error) });
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, [scope, address, enabled, revision, getToken]);

  return { state: scopedCapabilities(state, scope, enabled), retry };
}
