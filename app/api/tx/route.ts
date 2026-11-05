import { NextRequest, NextResponse } from "next/server";
import { createTx, validateTx } from "@/lib/ledger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const v = validateTx(body);
  if (v.errors) return NextResponse.json({ error: v.errors.join("; ") }, { status: 400 });
  try {
    const id = createTx(v.fields!);
    return NextResponse.json({ ok: true, id }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
