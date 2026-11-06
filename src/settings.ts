import { useSyncExternalStore } from 'react';
import { DEFAULT_SETTINGS, type Settings } from './config';
import { readLocal, writeLocal } from './lib/util';

const KEY = 'cheekbook.settings';
const listeners = new Set<() => void>();

// Saved values win over defaults; keys no longer in Settings are dropped.
function load(): Settings {
  const saved = readLocal<Record<string, unknown>>(KEY, {});
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(out)) if (typeof saved[k] === typeof out[k]) out[k] = saved[k];
  return out as unknown as Settings;
}

let current = load();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  writeLocal(KEY, current);
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
