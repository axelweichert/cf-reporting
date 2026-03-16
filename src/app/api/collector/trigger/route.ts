import { NextRequest, NextResponse } from "next/server";
import { requireAuth, validateOrigin, requireOperator } from "@/lib/auth-helpers";
import { runCollection, getCollectorStatus } from "@/lib/collector";

export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const auth = await requireAuth();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const operatorError = await requireOperator();
  if (operatorError) return operatorError;

  const status = getCollectorStatus();
  if (!status.enabled) {
    return NextResponse.json(
      { error: "Data collection is not enabled (requires CF_API_TOKEN and writable data volume)" },
      { status: 400 },
    );
  }

  if (status.running) {
    return NextResponse.json(
      { error: "Collection already in progress" },
      { status: 409 },
    );
  }

  // Fire-and-forget
  runCollection().catch((err) => {
    console.error("[collector] Manual trigger failed:", err);
  });

  return NextResponse.json({ message: "Collection started" });
}
