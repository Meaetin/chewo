import type { Components } from 'react-markdown'

/**
 * Link handling shared by every `ReactMarkdown` surface — the chat thread, the
 * notes editor and its Q&A, the file editor's preview, capabilities.
 *
 * Markdown emits a plain `<a href>`, and a plain `<a href>` inside a frameless
 * Electron window navigates the app away with no chrome to come back from.
 * Main pins the frame as a backstop (`will-navigate` in `src/main/index.ts`),
 * but the click is answered here so the URL never starts a navigation at all.
 *
 * `openExternal` refuses anything that isn't http(s), so a `javascript:` or
 * `file:` href is dropped rather than opened; the anchor is still cancelled,
 * which is the point — it must not navigate either.
 */
export const MD_LINKS: Components = {
  a: ({ href, children, ...rest }) => (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href) void window.api.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}
