import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// opt46 (M1-translator): never persist authorization material, even if a
// stale client posts unmasked headers — scrub auth header values out of
// JSON log content before writing. Non-JSON content passes through.
function scrubAuthMaterial(content) {
  if (typeof content !== "string") return content;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  const scrub = (node) => {
    if (Array.isArray(node)) {
      node.forEach(scrub);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (/^(authorization|x-api-key|api-key|x-goog-api-key)$/i.test(key)) {
          node[key] = /^authorization$/i.test(key) ? "Bearer ***" : "***";
        } else {
          scrub(value);
        }
      }
    }
  };
  scrub(parsed);
  return JSON.stringify(parsed, null, 2);
}

export async function POST(request) {
  try {
    const { file, content } = await request.json();

    if (!file || content === undefined) {
      return NextResponse.json({ success: false, error: "File and content required" }, { status: 400 });
    }

    // Security: only allow specific filenames
    const allowedFiles = [
      "1_req_client.json",
      "2_req_source.json",
      "3_req_openai.json",
      "4_req_target.json",
      "5_res_provider.txt",
      "6_res_openai.txt",
      "7_res_client.txt",
      "7_res_client.json",
    ];

    if (!allowedFiles.includes(file)) {
      return NextResponse.json({ success: false, error: "Invalid file name" }, { status: 400 });
    }

    const logsDir = path.join(process.cwd(), "logs", "translator");
    
    // Create directory if not exists
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const filePath = path.join(logsDir, file);
    fs.writeFileSync(filePath, scrubAuthMaterial(content), "utf-8");

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error saving file:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
