import { getNews } from '@/lib/news';

// Edge-compatible: fetch + regex only.
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

/** GET /api/news → { items, mode: 'live' | 'sample', errors, fetchedAt }. Cached 5 min server-side. */
export async function GET() {
  const data = await getNews();
  return Response.json(data, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } });
}
