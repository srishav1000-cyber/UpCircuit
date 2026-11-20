// Pure play-state machine for the replay sandbox (kept out of the component so every transition is unit-tested).
export type SandboxPhase = 'idle' | 'playing' | 'paused' | 'done';
export type SandboxAction = 'toggle' | 'finish' | 'reset';
export function sandboxReduce(phase: SandboxPhase, action: SandboxAction): SandboxPhase {
  switch (action) {
    case 'toggle': return phase === 'playing' ? 'paused' : 'playing';       // idle/paused/done → playing (done restarts: the component resets the runner first)
    case 'finish': return phase === 'playing' ? 'done' : phase;
    case 'reset': return 'idle';
  }
}
export const sandboxButtonLabel = (p: SandboxPhase): string => (p === 'idle' ? 'Simulate Live Market Burst' : p === 'playing' ? 'Pause' : p === 'paused' ? 'Resume' : 'Replay again');
