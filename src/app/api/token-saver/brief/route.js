import { NextResponse } from "next/server";
import {
  getBriefModes, setBriefGlobal, setBriefForKey, setBriefForModel,
} from "@/lib/localDb";

// Brief Mode (9Router Pro) — per-scope Caveman levels.
// GET    /api/token-saver/brief            → { global, byKey, byModel }
// PUT    /api/token-saver/brief            → { global: level|null }
//                                          | { keyId, level|null }
//                                          | { model, level|null }
// DELETE /api/token-saver/brief?model=<n>  | ?keyId=<id> | ?global=1

export async function GET() {
  try {
    return NextResponse.json(await getBriefModes());
  } catch (error) {
    console.log("Error fetching brief modes:", error);
    return NextResponse.json({ error: "Failed to fetch brief modes" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = (await request.json()) || {};
    if ("global" in body) {
      await setBriefGlobal(body.global ?? null);
      return NextResponse.json(await getBriefModes());
    }
    if (typeof body.keyId === "string" && body.keyId) {
      await setBriefForKey(body.keyId, body.level ?? null);
      return NextResponse.json(await getBriefModes());
    }
    if (typeof body.model === "string" && body.model) {
      await setBriefForModel(body.model, body.level ?? null);
      return NextResponse.json(await getBriefModes());
    }
    return NextResponse.json({ error: "Provide global, keyId, or model" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to save brief mode" }, { status: 400 });
  }
}

export async function DELETE(request) {
  try {
    const params = new URL(request.url).searchParams;
    if (params.get("global")) await setBriefGlobal(null);
    else if (params.get("keyId")) await setBriefForKey(params.get("keyId"), null);
    else if (params.get("model")) await setBriefForModel(params.get("model"), null);
    else return NextResponse.json({ error: "Provide global, keyId, or model" }, { status: 400 });
    return NextResponse.json(await getBriefModes());
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to delete brief mode" }, { status: 400 });
  }
}
