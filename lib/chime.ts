// AudioContext lifecycle (lazy creation, autoplay-policy unlock, state events). The sounds themselves live in lib/audioAlerts.ts.
export type AudioStateName = 'running' | 'suspended' | 'unsupported';

let ctx: AudioContext | null = null;
const listeners = new Set<() => void>();

export function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    try {
      ctx = new C();
      ctx.addEventListener?.('statechange', () => listeners.forEach((l) => l()));
    } catch {
      return null;
    }
  }
  return ctx;
}

/** Current AudioContext state (creates the context lazily; it starts `suspended` until a user gesture). */
export function audioState(): AudioStateName {
  const c = getAudioContext();
  return !c ? 'unsupported' : c.state === 'running' ? 'running' : 'suspended';
}
export function onAudioStateChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resume the AudioContext — call from any click / tap / key handler (browser autoplay policy). Resolves with the new state. */
export async function unlockAudioContext(): Promise<AudioStateName> {
  const c = getAudioContext();
  if (!c) return 'unsupported';
  if (c.state !== 'running') await c.resume().catch(() => undefined);
  listeners.forEach((l) => l());
  return audioState();
}
/** @deprecated kept for existing callers — same as unlockAudioContext() */
export const unlockAudio = (): void => void unlockAudioContext();
