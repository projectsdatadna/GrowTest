/**
 * Text files (CSV, JSON) from any common encoding: UTF-8 (with or without a BOM), UTF-16 (what Excel's
 * "Unicode Text" / "CSV UTF-16" save as) and, when the bytes are not valid UTF-8, Windows-1252 (older Excel
 * "CSV" exports with a rupee sign or accents).
 */

export const hasUtf16Bom = (buffer) => (buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)

export function decodeText(buffer) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return new TextDecoder('utf-8').decode(buffer.subarray(3))
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2))
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('windows-1252').decode(buffer)
  }
}
