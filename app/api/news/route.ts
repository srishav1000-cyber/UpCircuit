import { getNews } from '@/lib/news';

// Edge-compatible: fetch + regex only.
export const runtime = 'edge';
export const dynamic = 'force-dynamic'; // live headlines: the 5-minute window is enforced by the in-memory cache + the Cache-Control header below
export const revalidate = 300;

/** GET /api/news → { items, mode: 'live' | 'sample', errors, fetchedAt }. Cached 5 min server-side. */
export async function GET() {
  const data = await getNews();
  return Response.json(data, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } });
}
