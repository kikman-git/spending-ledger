import { NextRequest, NextResponse } from "next/server";
import { monthPayload, runRecurringDue } from "@/lib/ledger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: NextRequest) {
  try {
    // Write any recurring entries that have come due; a failure here must
    // not take the month view down with it.
    runRecurringDue();
  } catch (e) {
    console.error("recurring materialization failed:", e);
  }
  try {
    const m = req.nextUrl.searchParams.get("m");
    return NextResponse.json(monthPayload(m), {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `ledger database unavailable: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
