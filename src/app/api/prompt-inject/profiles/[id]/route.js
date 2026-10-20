import { NextResponse } from "next/server";
import { getPromptProfileById, updatePromptProfile, deletePromptProfile } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const POSITIONS = new Set(["append", "prepend"]);

// PUT /api/prompt-inject/profiles/[id] - Update a prompt profile
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getPromptProfileById(id);
    if (!existing) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    }
    const body = await request.json();
    const patch = {};
    if (body?.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
      patch.name = name;
    }
    if (body?.content !== undefined) {
      if (typeof body.content !== "string" || !body.content.trim()) {
        return NextResponse.json({ error: "Content cannot be empty" }, { status: 400 });
      }
      patch.content = body.content;
    }
    if (body?.position !== undefined) {
      if (!POSITIONS.has(body.position)) {
        return NextResponse.json({ error: "Position must be 'append' or 'prepend'" }, { status: 400 });
      }
      patch.position = body.position;
    }
    if (body?.enabled !== undefined) patch.enabled = !!body.enabled;
    const profile = await updatePromptProfile(id, patch);
    return NextResponse.json({ profile });
  } catch (error) {
    console.log("Error updating prompt profile:", error);
    return NextResponse.json({ error: "Failed to update prompt profile" }, { status: 500 });
  }
}

// DELETE /api/prompt-inject/profiles/[id] - Delete a prompt profile (bindings scrubbed)
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getPromptProfileById(id);
    if (!existing) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    }
    await deletePromptProfile(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.log("Error deleting prompt profile:", error);
    return NextResponse.json({ error: "Failed to delete prompt profile" }, { status: 500 });
  }
}
