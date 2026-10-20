import { NextResponse } from "next/server";
import { createPromptProfile } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const POSITIONS = new Set(["append", "prepend"]);

// POST /api/prompt-inject/profiles - Create a prompt profile
export async function POST(request) {
  try {
    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const content = typeof body?.content === "string" ? body.content : "";
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (!content.trim()) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }
    if (body?.position !== undefined && !POSITIONS.has(body.position)) {
      return NextResponse.json({ error: "Position must be 'append' or 'prepend'" }, { status: 400 });
    }
    const profile = await createPromptProfile({
      name,
      content,
      position: body?.position || "append",
      enabled: body?.enabled !== false,
    });
    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    console.log("Error creating prompt profile:", error);
    return NextResponse.json({ error: "Failed to create prompt profile" }, { status: 500 });
  }
}
