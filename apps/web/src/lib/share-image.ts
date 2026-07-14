import { toBlob } from "html-to-image"

export type ShareImageStatus = "shared" | "downloaded" | "cancelled" | "failed"

/**
 * Capture a DOM node (the off-screen <DuelShareCard>) to a PNG and hand it
 * off — via the native share sheet where file-sharing is supported (this
 * is what actually posts an image to X, not just a link), falling back to
 * a browser download otherwise. `cacheBust` matters here: avatar
 * gradients/images are re-rendered fresh per share, and a stale cached
 * capture would show an outdated card.
 *
 * Deliberately does NOT include the duel URL in the shared text: several
 * share targets (macOS's system share sheet among them) auto-generate a
 * rendered link-preview thumbnail for any URL in the text, which then
 * pastes as a second image alongside the actual PNG. The URL has its own
 * dedicated path — the "copy link" button.
 */
export async function shareCardImage(
  node: HTMLElement,
  opts: { text: string; filename: string }
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
      await nav.share({ files: [file], text: opts.text })
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
