// Circuit alarm synthesiser (Web Audio API — no audio files). Two distinct signatures at a loud master level:
//   LOWER  → cinematic danger horn: sawtooth 110 Hz + square 116 Hz (A2, beating ~6 Hz) through a resonant lowpass (Q 6) swept
//            300 → 1200 → 400 Hz over 0.5 s, plus a 55 Hz sine sub-bass; 3 blasts of 0.45 s, 0.1 s apart
//   UPPER  → surge arpeggio C5→E5→G5→C6 (sine + triangle blend) ending in a sustained C6 with a C7 shimmer ring
// Everything runs through a master gain (0.85) and a fast limiter, so the resonant peaks cannot clip.
import { getAudioContext, unlockAudioContext } from './chime';

export type ChimeKind = 'upper' | 'lower';
/** master output level */
export const MASTER_GAIN = 0.85;

export const HORN = { sawHz: 110, squareHz: 116, subHz: 55, q: 6, cutStart: 300, cutPeak: 1200, cutEnd: 400, sweepSec: 0.5, peakAt: 0.25, blasts: 3, blastSec: 0.45, gapSec: 0.1, sawGain: 0.3, squareGain: 0.17, subGain: 0.32 } as const;
export const HORN_SEC = HORN.blasts * HORN.blastSec + (HORN.blasts - 1) * HORN.gapSec; // 1.55 s

export const ARPEGGIO_HZ = [523.25, 659.25, 783.99, 1046.5] as const; // C5 E5 G5 C6
export const ARP_STEP_SEC = 0.13;
export const ARP_NOTE_SEC = 0.22;
export const RING_HZ = 2093; // C7 shimmer over the sustained C6
export const RING_SEC = 1.1;
export const ARP_SEC = (ARPEGGIO_HZ.length - 1) * ARP_STEP_SEC + RING_SEC;

/** total length (s) of an alarm — lets the overlay / tests know how long the sound runs */
export const alarmSeconds = (kind: ChimeKind): number => (kind === 'lower' ? HORN_SEC : ARP_SEC);

/** `level` scales the master gain (1 = full alarm; the audio-ON confirmation uses ~0.2). */
export function playChime(kind: ChimeKind, level = 1): boolean {
  const c = getAudioContext();
  if (!c || c.state !== 'running') return false;
  const t0 = c.currentTime + 0.03;
  const master = c.createGain();
  master.gain.setValueAtTime(MASTER_GAIN * Math.max(0, Math.min(1, level)), c.currentTime);
  const limiter = c.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-8, c.currentTime);
  limiter.knee.setValueAtTime(6, c.currentTime);
  limiter.ratio.setValueAtTime(14, c.currentTime);
  limiter.attack.setValueAtTime(0.002, c.currentTime);
  limiter.release.setValueAtTime(0.12, c.currentTime);
  master.connect(limiter);
  limiter.connect(c.destination);

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
    for (let p = 0; p < HORN.blasts; p++) {
      const st = t0 + p * (HORN.blastSec + HORN.gapSec);
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.setValueAtTime(HORN.q, st);
      filter.frequency.setValueAtTime(HORN.cutStart, st);
      filter.frequency.exponentialRampToValueAtTime(HORN.cutPeak, st + HORN.peakAt);
      filter.frequency.exponentialRampToValueAtTime(HORN.cutEnd, st + HORN.sweepSec);
      filter.connect(master);
      const voice = (type: OscillatorType, hz: number, peak: number, viaFilter: boolean) => {
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(hz, st);
        g.gain.setValueAtTime(0.0001, st);
        g.gain.exponentialRampToValueAtTime(peak, st + 0.02);
        g.gain.setValueAtTime(peak, st + HORN.blastSec - 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, st + HORN.blastSec);
        osc.connect(g);
        g.connect(viaFilter ? filter : master);
        osc.start(st);
        osc.stop(st + HORN.blastSec + 0.02);
      };
      voice('sawtooth', HORN.sawHz, HORN.sawGain, true);
      voice('square', HORN.squareHz, HORN.squareGain, true);
      voice('sine', HORN.subHz, HORN.subGain, false); // sub-bass bypasses the filter
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
