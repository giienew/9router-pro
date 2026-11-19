import { NextResponse } from "next/server";
import { apiErrorBody } from "@/lib/apiError";
import { clearConsoleLogs, getConsoleLogs, initConsoleLogCapture } from "@/lib/consoleLogBuffer";

initConsoleLogCapture();

export async function GET() {
  try {
    const logs = getConsoleLogs();
    return NextResponse.json({ success: true, logs });
  } catch (error) {
    console.error("Error getting console logs:", error);
    return NextResponse.json({ success: false, ...apiErrorBody(error, { code: "translator_logs_failed", message: "Failed to fetch console logs" }) }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    clearConsoleLogs();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error clearing console logs:", error);
    return NextResponse.json({ success: false, ...apiErrorBody(error, { code: "translator_logs_failed", message: "Failed to clear console logs" }) }, { status: 500 });
  }
}
