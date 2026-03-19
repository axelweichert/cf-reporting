import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { getDb } from "@/lib/db";

/** GET /api/contract/accounts – list accounts with their zone counts (from zone_accounts table) */
export async function GET() {
  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = getDb();
  if (!db) return Response.json({ error: "Database unavailable" }, { status: 503 });

  try {
    const accounts = db.prepare(
      `SELECT account_id, MIN(zone_name) as sample_zone,
              COUNT(*) as total_zones,
              SUM(CASE WHEN plan_name = 'Enterprise' THEN 1 ELSE 0 END) as enterprise_zones
       FROM zone_accounts
       GROUP BY account_id
       ORDER BY enterprise_zones DESC`,
    ).all() as Array<{
      account_id: string;
      sample_zone: string;
      total_zones: number;
      enterprise_zones: number;
    }>;

    return Response.json({ accounts });
  } catch {
    return Response.json({ accounts: [] });
  }
}
