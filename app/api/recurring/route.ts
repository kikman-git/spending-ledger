import { NextRequest, NextResponse } from "next/server";
import { createRecurring, listRecurring, validateRecurring } from "@/lib/ledger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  try {
    return NextResponse.json({ rules: listRecurring() }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const v = validateRecurring(body);
  if (v.errors) return NextResponse.json({ error: v.errors.join("; ") }, { status: 400 });
  try {
    const { id, generated } = createRecurring(v.fields!);
    return NextResponse.json({ ok: true, id, generated }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
