import { NextRequest } from "next/server"
import { getGBrainServerToken, hasGBrainServerAuthForRequest } from "@/lib/gbrain-server"

const BASE = process.env.GBRAIN_URL || "http://localhost:8787"

async function proxy(request: NextRequest, jobId: string, suffix = "", method: "GET" | "POST" = "GET") {
  if (!await hasGBrainServerAuthForRequest(request)) return Response.json({ error: "请先登录，或配置 GBrain token" }, { status: 401 })
  const token = await getGBrainServerToken()
  const response = await fetch(`${BASE}/think/stream/${encodeURIComponent(jobId)}${suffix}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
    ...(method === "POST" ? { body: "{}" } : {}),
    cache: "no-store",
  })
  return new Response(await response.text(), {
    status: response.status,
    headers: { "Content-Type": response.headers.get("Content-Type") || "application/json" },
  })
}

export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params
  return proxy(request, jobId)
}

export async function POST(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params
  return proxy(request, jobId, "/cancel", "POST")
}
