import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-helpers";
import { getCollectorStatus } from "@/lib/collector";
import { getRecentCollectionRuns, getSnapshotCount } from "@/lib/snapshots";

export async function GET() {
  const auth = await requireAuth();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = getCollectorStatus();
  const recentRuns = getRecentCollectionRuns(10);
  const snapshotCount = getSnapshotCount();

  return NextResponse.json({
    ...status,
    snapshotCount,
    recentRuns,
  });
}
