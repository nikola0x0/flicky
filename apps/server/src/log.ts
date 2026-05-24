/**
 * Tiny tagged logger. Each subsystem (`ws`, `keeper`, `indexer`, ...)
 * uses a short prefix so multi-service stdout is grep-able.
 */
type Level = "info" | "warn" | "error"

function fmt(level: Level, tag: string, msg: string): string {
  const ts = new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
  return `${ts} [${tag}] ${msg}`
}

export function makeLogger(tag: string) {
  return {
    info: (msg: string, ...rest: unknown[]) =>
      console.log(fmt("info", tag, msg), ...rest),
    warn: (msg: string, ...rest: unknown[]) =>
      console.warn(fmt("warn", tag, msg), ...rest),
    error: (msg: string, ...rest: unknown[]) =>
      console.error(fmt("error", tag, msg), ...rest),
  }
}

export type Logger = ReturnType<typeof makeLogger>

export function shortId(id: string, len = 6): string {
  if (!id) return ""
  return id.length > len * 2 + 2 ? `${id.slice(0, len)}…${id.slice(-len)}` : id
}
