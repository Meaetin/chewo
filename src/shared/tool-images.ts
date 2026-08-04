/**
 * Pictures a tool handed back — a `Read` of a PNG, an MCP screenshot server —
 * and the text beside them.
 *
 * A `tool_result`'s content is either a string or an array of parts, and an
 * image part is `{type:'image',source:{type:'base64',media_type,data}}`.
 * Verified 2026-08-04 against CLI 2.1.220 on both routes: the live wire and the
 * stored session file carry the *same* shape, which is why one splitter serves
 * `claude-chat.ts` and `adapter/claude.ts` — the same reason `parseToolPatch`
 * is shared. Chewo used to flatten every non-text part to the literal string
 * `[image]`, so a screenshot read as a tool that returned nothing.
 */

export interface ToolImage {
  /** `image/png`, … — whitelisted, since this lands in an `<img src="data:…">` */
  mediaType: string
  /** base64 payload, no data-URL prefix */
  data: string
}

/** Enough for a Read of a directory of screenshots without seeding a wall. */
export const MAX_RESULT_IMAGES = 4

/**
 * A base64 payload above this is refused rather than pushed through IPC and
 * parked in renderer state. The CLI already downscales to the API's 5 MB limit,
 * so this is a guard against a malformed or hostile payload, not a normal path.
 */
export const MAX_IMAGE_BASE64 = 8_000_000

/** A data URL is only as safe as its media type — `<img>` will not run HTML,
 *  but nothing here needs to accept a type the tag cannot paint either. */
const PAINTABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const BASE64 = /^[A-Za-z0-9+/=\s]+$/

interface ResultPart {
  type?: string
  text?: string
  source?: { type?: string; media_type?: string; data?: unknown }
}

function toImage(part: ResultPart): ToolImage | null {
  const source = part.source
  if (!source || source.type !== 'base64') return null
  const mediaType = String(source.media_type ?? '')
  if (!PAINTABLE.has(mediaType)) return null
  const data = source.data
  if (typeof data !== 'string' || !data || data.length > MAX_IMAGE_BASE64) return null
  if (!BASE64.test(data)) return null
  return { mediaType, data }
}

const cap = (text: string, limit?: number): string => (limit ? text.slice(0, limit) : text)

/**
 * Split a `tool_result`'s content into the prose the chip prints and the images
 * it paints. An image that cannot be shown still leaves a line saying so: a
 * result that renders nothing where a picture was is indistinguishable from a
 * tool that produced nothing.
 */
export function splitToolResult(
  content: unknown,
  opts: { textCap?: number } = {}
): { text: string; images: ToolImage[] } {
  if (typeof content === 'string') return { text: cap(content, opts.textCap), images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }

  const images: ToolImage[] = []
  const lines: string[] = []

  for (const part of content as ResultPart[]) {
    if (part.type === 'text' && typeof part.text === 'string') {
      lines.push(part.text)
      continue
    }
    if (part.type === 'image') {
      const image = toImage(part)
      if (image && images.length < MAX_RESULT_IMAGES) images.push(image)
      else lines.push(image ? '[image — not shown]' : '[image — could not be read]')
      continue
    }
    if (part.type) lines.push(`[${part.type}]`)
  }

  return { text: cap(lines.filter(Boolean).join('\n'), opts.textCap), images }
}

export const imageDataUrl = (image: ToolImage): string =>
  `data:${image.mediaType};base64,${image.data}`
