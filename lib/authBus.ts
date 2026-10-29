// Lets non-React code (fetch helpers) attach the signed-in user's access token to same-origin API calls.
let getter: (() => Promise<string | null>) | null = null;
export const installTokenGetter = (g: (() => Promise<string | null>) | null) => { getter = g; };
/** fetch() for our own /api routes: adds Authorization when a Supabase session exists. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const t = await getter?.().catch(() => null);
  const headers = new Headers(init.headers);
  if (t && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${t}`);
  return fetch(input, { ...init, headers });
}
