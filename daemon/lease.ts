// Leader election for the alert daemon, on a PostgreSQL lease row (public.daemon_leases, docs/WEEK10_SCHEMA.sql).
//   • every `renewMs` (10 s) the daemon calls acquire_daemon_lease(name, holder, ttl): it either becomes / stays leader or learns who is
//   • only the leader opens the SmartAPI feed and dispatches alerts; everyone else is on standby (rule index stays warm via Realtime)
//   • all expiry decisions are made by the database clock; the local side uses only ELAPSED time since it last sent a successful request,
//     so a stalled event loop or a network partition makes a leader step down on its own before the lease can have expired
//   • stop() releases the lease so a standby takes over on its next poll instead of waiting out the TTL
export type LeaseRole = 'standby' | 'leader';
export interface LeaseInfo { role: LeaseRole; holder: string | null; epoch: number; expiresAt: string | null; reason: string }
export interface LeaseRow { acquired: boolean; holder_id: string | null; expires_at: string | null; epoch: number | string | null }

export interface LeaseOptions {
  name: string;
  holderId: string;
  /** lease length; must exceed renewMs by a safe margin (default 30 s = 3 renewals) */
  ttlSeconds?: number;
  /** acquire / renew interval (default 10 s) */
  renewMs?: number;
  /** calls rpc/acquire_daemon_lease; resolves with the row, rejects on any transport / HTTP error */
  acquire: (name: string, holderId: string, ttlSeconds: number) => Promise<LeaseRow>;
  /** calls rpc/release_daemon_lease (best effort) */
  release?: (name: string, holderId: string) => Promise<unknown>;
  onChange?: (info: LeaseInfo, previous: LeaseRole) => void;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /** step down this long BEFORE the lease can expire when the database cannot be reached (default 3 s) */
  safetyMs?: number;
}

export interface Lease {
  start(): Promise<void>;
  /** one acquire / renew round (exposed for tests; start() schedules it) */
  tick(): Promise<LeaseInfo>;
  /** synchronous and conservative: true only while a successful acquire is recent enough that the lease cannot have expired */
  isLeader(): boolean;
  info(): LeaseInfo;
  stop(): Promise<void>;
}

/** a holder id unique per process start: host + pid + random, so a restarted daemon never mistakes itself for its previous incarnation */
export const newHolderId = (host = process.env.FLY_MACHINE_ID || process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || 'daemon'): string =>
  `${host}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`.slice(0, 100);

export function createLease(o: LeaseOptions): Lease {
  const ttl = o.ttlSeconds ?? 30, renewMs = o.renewMs ?? 10_000, safety = o.safetyMs ?? 3000;
  if (ttl * 1000 < renewMs * 2) throw new Error('lease ttl must be at least twice the renewal interval');
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  let role: LeaseRole = 'standby';
  let validUntil = 0;                          // local-clock instant before which our lease cannot have expired (request start + ttl − safety)
  let last: LeaseInfo = { role: 'standby', holder: null, epoch: 0, expiresAt: null, reason: 'not started' };
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false, busy: Promise<LeaseInfo> | null = null;

  const set = (next: LeaseInfo) => {
    const prev = role; role = next.role; last = next;
    if (prev !== next.role) { log('info', next.role === 'leader' ? 'lease acquired — this instance is the LEADER' : 'lease lost — this instance is on STANDBY', { holder: next.holder, epoch: next.epoch, reason: next.reason }); o.onChange?.(next, prev); }
  };

  async function round(): Promise<LeaseInfo> {
    const sentAt = now();
    try {
      const row = await o.acquire(o.name, o.holderId, ttl);
      if (stopped) return last;
      const epoch = Number(row.epoch ?? 0) || 0;
      if (row.acquired) {
        validUntil = sentAt + ttl * 1000 - safety;
        set({ role: 'leader', holder: o.holderId, epoch, expiresAt: row.expires_at, reason: 'acquired' });
      } else {
        validUntil = 0;
        set({ role: 'standby', holder: row.holder_id, epoch, expiresAt: row.expires_at, reason: `held by ${row.holder_id ?? 'another instance'}` });
      }
    } catch (e) {
      // database unreachable: a leader keeps leading only while its last successful acquire still guarantees the lease; a standby stays standby
      const msg = e instanceof Error ? e.message : String(e);
      if (role === 'leader' && now() >= validUntil) set({ role: 'standby', holder: last.holder, epoch: last.epoch, expiresAt: last.expiresAt, reason: `cannot renew (${msg})` });
      else log('warn', 'lease round failed', { role, error: msg });
    }
    return last;
  }
  // a slow database call must never overlap the next round
  const tick = (): Promise<LeaseInfo> => (busy ??= round().finally(() => { busy = null; }));

  return {
    tick,
    async start() { stopped = false; await tick(); timer = setInterval(() => void tick(), renewMs); },
    // checked on every tick / dispatch: if the event loop stalled past the guaranteed window, we are not the leader any more
    isLeader() {
      if (role !== 'leader') return false;
      if (now() >= validUntil) { set({ role: 'standby', holder: last.holder, epoch: last.epoch, expiresAt: last.expiresAt, reason: 'lease window elapsed locally' }); return false; }
      return true;
    },
    info() { return last; },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      const wasLeader = role === 'leader';
      if (busy) await busy.catch(() => undefined);
      role = 'standby';
      if (wasLeader) { try { await o.release?.(o.name, o.holderId); log('info', 'lease released'); } catch (e) { log('warn', 'lease release failed (a standby takes over after the TTL)', { error: String(e) }); } }
    },
  };
}
