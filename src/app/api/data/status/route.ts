import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-helpers";
import { getHistoricDataStatus } from "@/lib/data-store-readers";

export async function GET() {
  const auth = await requireAuth();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = getHistoricDataStatus();
  return NextResponse.json(status);
}
