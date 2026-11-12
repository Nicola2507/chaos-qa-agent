import { readFile } from "fs/promises";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  if (!id || !/^run-\d+$/.test(id)) {
    return Response.json({ error: "Invalid report id" }, { status: 400 });
  }

  const reportPath = path.join(
    process.cwd(),
    "public",
    "runs",
    id,
    "report.json",
  );

  try {
    const raw = await readFile(reportPath, "utf8");
    return new Response(raw, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "Report not found" }, { status: 404 });
  }
}
