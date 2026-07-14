import { toBlob } from "html-to-image"

export type ShareImageStatus = "shared" | "downloaded" | "cancelled" | "failed"

/**
 * Capture a DOM node (the off-screen <DuelShareCard>) to a PNG and hand it
 * off — via the native share sheet where file-sharing is supported (this
 * is what actually posts an image to X, not just a link), falling back to
 * a browser download otherwise. `cacheBust` matters here: avatar
 * gradients/images are re-rendered fresh per share, and a stale cached
 * capture would show an outdated card.
 */
export async function shareCardImage(
  node: HTMLElement,
  opts: { text: string; url: string; filename: string }
): Promise<ShareImageStatus> {
  let blob: Blob | null
  try {
    blob = await toBlob(node, {
      pixelRatio: 2,
      backgroundColor: "#0b1228",
      cacheBust: true,
    })
  } catch {
    blob = null
  }
  if (!blob) return "failed"

  const file = new File([blob], opts.filename, { type: "image/png" })
  const nav = typeof navigator !== "undefined" ? navigator : null
  const canShareFile =
    nav && "canShare" in nav && nav.canShare({ files: [file] })

  if (canShareFile) {
    try {
      // Fold the url into text rather than passing a separate `url` field —
      // some browsers reject combining `files` with `url` in one share.
      await nav.share({ files: [file], text: `${opts.text} ${opts.url}` })
      return "shared"
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "cancelled"
      /* fall through to the download fallback below */
    }
  }

  try {
    downloadBlob(blob, opts.filename)
    return "downloaded"
  } catch {
    return "failed"
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
