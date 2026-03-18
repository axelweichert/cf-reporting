import { NextRequest } from "next/server";
import { validateOrigin, getAuthenticatedSession, requireOperator } from "@/lib/auth-helpers";
import { getDb } from "@/lib/db";
import { detectAvailableProducts } from "@/lib/contract/catalog";

/** POST /api/contract/detect – auto-detect available products (operator only) */
export async function POST(request: NextRequest) {
  const originErr = validateOrigin(request);
  if (originErr) return originErr;

  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const opErr = await requireOperator();
  if (opErr) return opErr;

  const db = getDb();
  if (!db) return Response.json({ error: "Database unavailable" }, { status: 503 });

  const results = detectAvailableProducts(db);

  return Response.json({
    products: results.map((r) => ({
      key: r.key,
      displayName: r.displayName,
      category: r.category,
      unit: r.unit,
      description: r.description,
      detected: r.detected,
    })),
  });
}
