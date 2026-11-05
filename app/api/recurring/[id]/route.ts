import { NextRequest, NextResponse } from "next/server";
import { deleteRecurring, updateRecurring, validateRecurring } from "@/lib/ledger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function parseId(ctx: { params: Promise<{ id: string }> }): Promise<number | null> {
  const { id } = await ctx.params;
  return /^\d+$/.test(id) ? Number(id) : null;
}

// Body: {active} alone pauses/resumes; otherwise the full rule fields
// (optionally with active) rewrite the rule.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = await parseId(ctx);
  if (id == null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const o = (body ?? {}) as Record<string, unknown>;
  const active = typeof o.active === "boolean" ? o.active : null;
  const toggleOnly = active != null && Object.keys(o).every((k) => k === "active");
  let fields = null;
  if (!toggleOnly) {
    const v = validateRecurring(body);
    if (v.errors) return NextResponse.json({ error: v.errors.join("; ") }, { status: 400 });
    fields = v.fields!;
  }
  try {
    const { found, generated } = updateRecurring(id, fields, active);
    if (!found) return NextResponse.json({ error: "recurring rule not found" }, { status: 404 });
    return NextResponse.json({ ok: true, id, generated });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = await parseId(ctx);
  if (id == null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    if (!deleteRecurring(id)) {
      return NextResponse.json({ error: "recurring rule not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
