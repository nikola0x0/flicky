/**
 * Tiny static file server for the built SPA — Bun-native, zero deps.
 *
 * Serves `dist/` produced by `vite build`, with:
 *   - SPA fallback: any unknown path (no file + no extension) returns
 *     index.html so react-router client routes work on hard refresh.
 *   - `/health` → 200 so Railway's healthcheck (railway.json) passes the
 *     same way the backend's does.
 *   - long-lived immutable caching for Vite's content-hashed /assets/,
 *     no-cache for index.html so deploys take effect immediately.
 *
 * Listens on $PORT (Railway injects it; defaults to 8080 locally).
 */
const DIST = new URL("./dist/", import.meta.url)
const INDEX = new URL("./dist/index.html", import.meta.url)
const port = Number(process.env.PORT ?? 8080)

function notFoundIsSafe(pathname: string): boolean {
  // Reject path traversal; everything else falls back to the SPA shell.
  return !pathname.includes("..")
}

const server = Bun.serve({
  port,
  idleTimeout: 30,
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === "/health") return new Response("ok")

    if (notFoundIsSafe(pathname)) {
      const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
      const file = Bun.file(new URL(rel, DIST))
      if (await file.exists()) {
        const headers: Record<string, string> = {}
        // Vite emits content-hashed filenames under /assets — safe to
        // cache forever. index.html must never be cached.
        if (pathname.startsWith("/assets/")) {
          headers["Cache-Control"] = "public, max-age=31536000, immutable"
        }
        return new Response(file, { headers })
      }
    }

    // SPA fallback — serve the app shell so the client router can route.
    return new Response(Bun.file(INDEX), {
      headers: { "Cache-Control": "no-cache" },
    })
  },
})

console.log(`[web] serving dist/ on http://0.0.0.0:${server.port}`)
