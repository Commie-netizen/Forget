import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

// Ticker partagé : une seule minuterie de 1500 ms, active seulement s'il y a un abonné.
export const POLL_MS = 1500;
const listeners = new Set();
let timer = null;
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
const tick = () => { if (!hidden()) listeners.forEach((f) => f()); };
// Fenêtre réduite ou masquée : aucune requête ; rafraîchissement immédiat au retour.
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', tick);
function subscribe(fn) {
  listeners.add(fn);
  if (!timer) timer = setInterval(tick, POLL_MS);
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/**
 * Charge des données au montage et quand `deps` change.
 * `poll` (bool ou fonction des données) : recharge toutes les 1500 ms.
 * `enabled=false` : ne charge pas.
 */
export function useLoad(fetcher, { deps = [], poll = false, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(enabled);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const seq = useRef(0);
  const alive = useRef(true);
  const last = useRef(undefined); // empreinte JSON des dernières données : évite les rendus inutiles du polling

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async (silent = false) => {
    const id = ++seq.current;
    if (!silent) setLoading(true);
    try {
      const d = await fetchRef.current();
      if (alive.current && id === seq.current) {
        let key;
        try { key = JSON.stringify(d); } catch { key = undefined; }
        if (key === undefined || key !== last.current) {
          last.current = key;
          setData(d);
        }
        setError('');
      }
    } catch (e) {
      if (alive.current && id === seq.current) setError(e.message || 'API indisponible');
    } finally {
      if (alive.current && id === seq.current) setLoading(false);
    }
  }, []);

  const depKey = JSON.stringify(deps);
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    reload();
  }, [enabled, depKey, reload]);

  const polling = enabled && (typeof poll === 'function' ? !!poll(data) : !!poll);
  useEffect(() => {
    if (!polling) return undefined;
    return subscribe(() => reload(true));
  }, [polling, reload]);

  const setDataExternal = useCallback((v) => { last.current = undefined; setData(v); }, []);
  return { data, error, loading, reload, setData: setDataExternal };
}
