// Synthesised alert tones (Web Audio API — no audio files).
//   upper circuit: bright ascending sweep  880 Hz → 1760 Hz over 0.35 s (+ a quieter fifth above for a dual tone)
//   lower circuit: low descending sweep     440 Hz → 220 Hz over 0.35 s (+ a quieter fifth above)
export type ChimeKind = 'upper' | 'lower';
export const CHIME_FREQ: Record<ChimeKind, [number, number]> = { upper: [880, 1760], lower: [440, 220] };
export const SWEEP_SEC = 0.35;
/** the second voice of the dual tone sits a perfect fifth above the main sweep */
export const FIFTH = 1.5;

export type AudioStateName = 'running' | 'suspended' | 'unsupported';

let ctx: AudioContext | null = null;
const listeners = new Set<() => void>();

function getCtx(): AudioContext | null {
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
  const c = getCtx();
  return !c ? 'unsupported' : c.state === 'running' ? 'running' : 'suspended';
}
export function onAudioStateChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resume the AudioContext — call from any click / tap / key handler (browser autoplay policy). Resolves with the new state. */
export async function unlockAudioContext(): Promise<AudioStateName> {
  const c = getCtx();
  if (!c) return 'unsupported';
  if (c.state !== 'running') await c.resume().catch(() => undefined);
  listeners.forEach((l) => l());
  return audioState();
}
/** @deprecated kept for existing callers — same as unlockAudioContext() */
export const unlockAudio = (): void => void unlockAudioContext();

/** Play the sweep. Returns false if audio is unavailable or still locked. */
export function playChime(kind: ChimeKind, volume = 0.18): boolean {
  const c = getCtx();
  if (!c || c.state !== 'running') return false;
  const [f1, f2] = CHIME_FREQ[kind];
  const now = c.currentTime + 0.02;
  const voice = (mul: number, type: OscillatorType, vol: number) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f1 * mul, now);
    osc.frequency.exponentialRampToValueAtTime(f2 * mul, now + SWEEP_SEC);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(vol, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + SWEEP_SEC + 0.1);
    osc.connect(gain).connect(c.destination);
    osc.start(now);
    osc.stop(now + SWEEP_SEC + 0.12);
  };
  voice(1, kind === 'upper' ? 'sine' : 'triangle', volume);
  voice(FIFTH, 'sine', volume * 0.45);
  return true;
}

/** Sound-test button: unlock first (this runs inside a click), then play. */
export async function testChime(kind: ChimeKind, volume = 0.18): Promise<boolean> {
  await unlockAudioContext();
  return playChime(kind, volume);
}
