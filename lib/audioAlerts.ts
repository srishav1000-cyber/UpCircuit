// Circuit alarm synthesiser (Web Audio API — no audio files, no third-party samples, so nothing to license). Two signatures at a loud master level:
//   LOWER  → air-raid siren "spin-up" (3 s): a rotary-siren-style tone whose pitch climbs 260 → 560 Hz while it swells from silence,
//            built from detuned sawtooth voices + an octave triangle, a light 5 Hz vibrato and a lowpass for the horn-like body
//   UPPER  → surge arpeggio C5→E5→G5→C6 (sine + triangle blend) ending in a sustained high ring
import { getAudioContext, unlockAudioContext } from './chime';

export type ChimeKind = 'upper' | 'lower';
/** Settings → alarm sound: 'default' = siren for lower circuits + chime for upper; 'arpeggio' = the arpeggio for both */
export const soundFor = (dir: ChimeKind, sound: 'default' | 'arpeggio'): ChimeKind => (sound === 'arpeggio' ? 'upper' : dir);
/** master output level */
export const MASTER_GAIN = 0.85;

export const WAIL = { startHz: 260, endHz: 560, sec: 3, swellSec: 1.2, fadeSec: 0.3, vibratoHz: 5, vibratoDepth: 0.015, detune: 1.005, sawGain: 0.3, octaveGain: 0.14, cutoffStart: 900, cutoffEnd: 3200 } as const;
export const WAIL_SEC = WAIL.sec;

export const ARPEGGIO_HZ = [523.25, 659.25, 783.99, 1046.5] as const; // C5 E5 G5 C6
export const ARP_STEP_SEC = 0.13;
export const ARP_NOTE_SEC = 0.22;
export const RING_HZ = 2093; // C7 shimmer over the sustained C6
export const RING_SEC = 1.1;
export const ARP_SEC = (ARPEGGIO_HZ.length - 1) * ARP_STEP_SEC + RING_SEC;

/** total length (s) of an alarm — lets the overlay / tests know how long the sound runs */
export const alarmSeconds = (kind: ChimeKind): number => (kind === 'lower' ? WAIL_SEC : ARP_SEC);

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
    const end = t0 + WAIL.sec;
    const body = c.createBiquadFilter();
    body.type = 'lowpass';
    body.Q.setValueAtTime(0.8, t0);
    body.frequency.setValueAtTime(WAIL.cutoffStart, t0);
    body.frequency.exponentialRampToValueAtTime(WAIL.cutoffEnd, end - WAIL.fadeSec);
    body.connect(master);
    const env = c.createGain(); // spin-up swell, hold, short fade
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(1, t0 + WAIL.swellSec);
    env.gain.setValueAtTime(1, end - WAIL.fadeSec);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    env.connect(body);
    const lfo = c.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(WAIL.vibratoHz, t0);
    const voice = (type: OscillatorType, mul: number, peak: number) => {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(WAIL.startHz * mul, t0);
      osc.frequency.exponentialRampToValueAtTime(WAIL.endHz * mul, end - WAIL.fadeSec); // pitch climbs as the rotor spins up
      g.gain.setValueAtTime(peak, t0);
      osc.connect(g);
      g.connect(env);
      const vib = c.createGain(); // ±1.5 % vibrato
      vib.gain.setValueAtTime(WAIL.startHz * mul * WAIL.vibratoDepth, t0);
      lfo.connect(vib);
      vib.connect(osc.frequency);
      osc.start(t0);
      osc.stop(end + 0.02);
    };
    voice('sawtooth', 1, WAIL.sawGain);
    voice('sawtooth', WAIL.detune, WAIL.sawGain);
    voice('triangle', 2, WAIL.octaveGain);
    lfo.start(t0);
    lfo.stop(end + 0.02);
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
