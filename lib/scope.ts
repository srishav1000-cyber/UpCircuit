// Per-user storage namespace. AuthProvider sets the scope synchronously before the terminal mounts (it is keyed on the user id),
// so every hook reads/writes `upcircuit:…:<userId>` and two accounts in one browser never share watchlists, portfolio, alerts or chats.
import { userKey } from './auth';

let uid: string | null = null;
export const setScope = (id: string | null) => {
  uid = id;
};
export const scoped = (base: string) => userKey(base, uid);
