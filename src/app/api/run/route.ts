import { runChaosMission } from "@/agent/loop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RunBody = {
  url?: unknown;
  mission?: unknown;
  maxSteps?: unknown;
  headless?: unknown;
};

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: RunBody;
  try {
    body = (await request.json()) as RunBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  const mission = typeof body.mission === "string" ? body.mission.trim() : "";
  const maxSteps =
    typeof body.maxSteps === "number" && Number.isFinite(body.maxSteps)
      ? Math.min(Math.max(Math.floor(body.maxSteps), 1), 25)
      : 10;
  const headless =
    typeof body.headless === "boolean" ? body.headless : true;

  if (!url || !isValidHttpUrl(url)) {
    return Response.json(
      { error: "Provide a valid http(s) url" },
      { status: 400 },
    );
  }
  if (!mission) {
    return Response.json({ error: "Provide a mission string" }, { status: 400 });
  }
  if (!process.env.XAI_API_KEY) {
    return Response.json(
      { error: "XAI_API_KEY is not configured on the server" },
      { status: 500 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: { type: string; data: unknown }) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };

      try {
        send({
          type: "status",
          data: {
            message: "Launching Chaos QA mission",
            url,
            mission,
            maxSteps,
            headless,
          },
        });

        await runChaosMission({
          url,
          mission,
          maxSteps,
          headless,
          onEvent: (event) => {
            send(event);
          },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown mission failure";
        send({ type: "error", data: { message } });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
