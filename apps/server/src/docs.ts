/**
 * API docs — `/openapi.json` serves the hand-written spec at the repo
 * root (`apps/server/openapi.json`); `/docs` serves a tiny HTML page
 * that embeds Scalar via CDN, pointed at `/openapi.json`.
 *
 * Why hand-written: the surface is small (~7 endpoints), the schema
 * doesn't change shape often, and zero extra deps. If the API grows
 * past ~15 endpoints, switch to a generator (zod-to-openapi or similar).
 */
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CORS_HEADERS } from "./lib/http"

const SPEC_PATH = resolve(import.meta.dir, "../openapi.json")

let _specCache: string | null = null

async function loadSpec(): Promise<string> {
  if (_specCache) return _specCache
  _specCache = await readFile(SPEC_PATH, "utf-8")
  return _specCache
}

const SCALAR_HTML = `<!doctype html>
<html>
  <head>
    <title>Flicky API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script>
      // Light tweaks — dark by default, slimmer sidebar.
      var cfg = { theme: "purple", darkMode: true, hideDownloadButton: false };
      document.getElementById("api-reference").dataset.configuration = JSON.stringify(cfg);
    </script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>
`

export async function handleDocsRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/openapi.json" && req.method === "GET") {
    const spec = await loadSpec()
    return new Response(spec, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-cache",
        ...CORS_HEADERS,
      },
    })
  }
  if ((url.pathname === "/docs" || url.pathname === "/docs/") && req.method === "GET") {
    return new Response(SCALAR_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  }
  return null
}
