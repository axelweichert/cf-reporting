import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { PRODUCT_CATALOG } from "@/lib/contract/catalog";

/** GET /api/contract/catalog – list all available product catalog entries */
export async function GET() {
  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const catalog = PRODUCT_CATALOG.map((entry) => ({
    key: entry.key,
    displayName: entry.displayName,
    category: entry.category,
    unit: entry.unit,
    description: entry.description,
  }));

  return Response.json({ catalog });
}
