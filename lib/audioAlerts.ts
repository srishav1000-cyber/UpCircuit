// Circuit alarm synthesiser (Web Audio API — no audio files). Two distinct signatures at a loud master level:
//   LOWER  → "red alert" klaxon: two sawtooth voices swept 350↔750 Hz by a 4 Hz LFO, 3 pulses of 0.4 s ON / 0.1 s OFF
//   UPPER  → surge arpeggio C5→E5→G5→C6 (sine + triangle blend) ending in a sustained high ring
import { getAudioContext, unlockAudioContext } from './chime';

export type ChimeKind = 'upper' | 'lower';
/** master output level (≈ −1.4 dBFS before the voices' own headroom) */
export const MASTER_GAIN = 0.85;

export const SIREN = { low: 350, high: 750, lfoHz: 4, pulses: 3, onSec: 0.4, offSec: 0.1, voiceGain: 0.34, detune: 1.006 } as const;
export const SIREN_CENTER = (SIREN.low + SIREN.high) / 2; // 550 Hz
export const SIREN_DEPTH = (SIREN.high - SIREN.low) / 2; // ±200 Hz
export const SIREN_SEC = SIREN.pulses * (SIREN.onSec + SIREN.offSec) - SIREN.offSec; // 1.4 s

export const ARPEGGIO_HZ = [523.25, 659.25, 783.99, 1046.5] as const; // C5 E5 G5 C6
export const ARP_STEP_SEC = 0.13;
export const ARP_NOTE_SEC = 0.22;
export const RING_HZ = 2093; // C7 shimmer over the sustained C6
export const RING_SEC = 1.1;
export const ARP_SEC = (ARPEGGIO_HZ.length - 1) * ARP_STEP_SEC + RING_SEC;

/** total length (s) of an alarm — lets the overlay / tests know how long the sound runs */
export const alarmSeconds = (kind: ChimeKind): number => (kind === 'lower' ? SIREN_SEC : ARP_SEC);

/** `level` scales the master gain (1 = full alarm; the audio-ON confirmation uses ~0.2). */
export function playChime(kind: ChimeKind, level = 1): boolean {
  const c = getAudioContext();
  if (!c || c.state !== 'running') return false;
  const t0 = c.currentTime + 0.03;
  const master = c.createGain();
  master.gain.setValueAtTime(MASTER_GAIN * Math.max(0, Math.min(1, level)), c.currentTime);
  master.connect(c.destination);

  const tone = (type: OscillatorType, hz: number, start: number, dur: number, peak: number, attack = 0.01, release = 0.06): OscillatorNode => {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(hz, start);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + attack);
    g.gain.setValueAtTime(peak, Math.max(start + attack, start + dur - release));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(start);
    osc.stop(start + dur + 0.02);
    return osc;
  };

  if (kind === 'lower') {
    for (let p = 0; p < SIREN.pulses; p++) {
      const s = t0 + p * (SIREN.onSec + SIREN.offSec);
      for (const mul of [1, SIREN.detune]) {
        const carrier = tone('sawtooth', SIREN_CENTER * mul, s, SIREN.onSec, SIREN.voiceGain, 0.008, 0.03);
        const lfo = c.createOscillator();
        const depth = c.createGain();
        lfo.type = 'sine';
        lfo.frequency.setValueAtTime(SIREN.lfoHz, s);
        depth.gain.setValueAtTime(SIREN_DEPTH * mul, s);
        lfo.connect(depth);
        depth.connect(carrier.frequency); // 550 ± 200 Hz → 350…750 Hz
        lfo.start(s);
        lfo.stop(s + SIREN.onSec + 0.02);
      }
    }
    return true;
  }
  ARPEGGIO_HZ.forEach((hz, i) => {
    const s = t0 + i * ARP_STEP_SEC;
    const last = i === ARPEGGIO_HZ.length - 1;
    const dur = last ? RING_SEC : ARP_NOTE_SEC;
    tone('sine', hz, s, dur, 0.42, 0.008, last ? 0.9 : 0.08);
    tone('triangle', hz, s, dur, 0.26, 0.008, last ? 0.9 : 0.08);
  });
  tone('sine', RING_HZ, t0 + (ARPEGGIO_HZ.length - 1) * ARP_STEP_SEC, RING_SEC, 0.12, 0.02, 0.9); // sustained ring
  return true;
}

/** Sound-test button: unlock first (this runs inside a click), then play at full alarm level. */
export async function testChime(kind: ChimeKind, level = 1): Promise<boolean> {
  await unlockAudioContext();
  return playChime(kind, level);
}
