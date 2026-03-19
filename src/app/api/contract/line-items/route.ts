import { NextRequest } from "next/server";
import { validateOrigin, getAuthenticatedSession, requireOperator } from "@/lib/auth-helpers";
import {
  getContractLineItems,
  addContractLineItem,
  updateContractLineItem,
  deleteContractLineItem,
} from "@/lib/data-store";
import type { CreateLineItemRequest, UpdateLineItemRequest } from "@/lib/contract/types";
import { CATALOG_BY_KEY } from "@/lib/contract/catalog";

/** GET /api/contract/line-items – list all line items (operator + viewer) */
export async function GET() {
  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const items = getContractLineItems();
  return Response.json({ items });
}

/** POST /api/contract/line-items – add one or more line items (operator only) */
export async function POST(request: NextRequest) {
  const originErr = validateOrigin(request);
  if (originErr) return originErr;

  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const opErr = await requireOperator();
  if (opErr) return opErr;

  const body = await request.json() as { items?: CreateLineItemRequest[]; item?: CreateLineItemRequest };

  // Support both single item and batch
  const requests = body.items ?? (body.item ? [body.item] : []);
  if (requests.length === 0) {
    return Response.json({ error: "No items provided" }, { status: 400 });
  }

  const created = [];
  const errors = [];

  for (const req of requests) {
    if (!req.productKey || typeof req.committedAmount !== "number" || req.committedAmount <= 0) {
      errors.push({ productKey: req.productKey, error: "Invalid productKey or committedAmount" });
      continue;
    }
    if (!CATALOG_BY_KEY.has(req.productKey)) {
      errors.push({ productKey: req.productKey, error: "Unknown product key" });
      continue;
    }
    if (req.warningThreshold !== undefined && (req.warningThreshold < 0.01 || req.warningThreshold > 1)) {
      errors.push({ productKey: req.productKey, error: "warningThreshold must be between 0.01 and 1" });
      continue;
    }

    try {
      const item = addContractLineItem(req);
      if (item) created.push(item);
      else errors.push({ productKey: req.productKey, error: "Failed to add (possibly duplicate)" });
    } catch (err) {
      errors.push({ productKey: req.productKey, error: (err as Error).message });
    }
  }

  // Back-calculate historical months for newly added items
  if (created.length > 0) {
    try {
      const { getDb } = await import("@/lib/db");
      const { backCalculateHistory } = await import("@/lib/contract/usage-calculator");
      const db = getDb();
      if (db) backCalculateHistory(db);
    } catch {
      // Non-critical – current month data is still available
    }
  }

  return Response.json({ created, errors }, { status: created.length > 0 ? 201 : 400 });
}

/** PATCH /api/contract/line-items – update a line item (operator only) */
export async function PATCH(request: NextRequest) {
  const originErr = validateOrigin(request);
  if (originErr) return originErr;

  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const opErr = await requireOperator();
  if (opErr) return opErr;

  const body = await request.json() as UpdateLineItemRequest;
  if (!body.id || typeof body.id !== "number") {
    return Response.json({ error: "Missing or invalid id" }, { status: 400 });
  }

  if (body.warningThreshold !== undefined && (body.warningThreshold < 0.01 || body.warningThreshold > 1)) {
    return Response.json({ error: "warningThreshold must be between 0.01 and 1" }, { status: 400 });
  }
  if (body.committedAmount !== undefined && body.committedAmount <= 0) {
    return Response.json({ error: "committedAmount must be positive" }, { status: 400 });
  }

  const ok = updateContractLineItem(body);
  if (!ok) return Response.json({ error: "Not found or no changes" }, { status: 404 });
  return Response.json({ ok: true });
}

/** DELETE /api/contract/line-items – delete a line item (operator only) */
export async function DELETE(request: NextRequest) {
  const originErr = validateOrigin(request);
  if (originErr) return originErr;

  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const opErr = await requireOperator();
  if (opErr) return opErr;

  const { searchParams } = new URL(request.url);
  const id = Number(searchParams.get("id"));
  if (!id || isNaN(id)) {
    return Response.json({ error: "Missing or invalid id" }, { status: 400 });
  }

  const ok = deleteContractLineItem(id);
  if (!ok) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}
