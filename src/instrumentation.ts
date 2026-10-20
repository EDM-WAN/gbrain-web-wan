/** Start server-side SDK scheduling once when the Node Web process boots. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { startSourceScheduler } = await import("@/lib/source-scheduler")
  await startSourceScheduler()
}
