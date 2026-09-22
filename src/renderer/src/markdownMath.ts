import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { PluggableList } from 'unified'

/**
 * Markdown plugins for the notes surfaces — the lesson preview and the notes
 * Q&A. Lessons carry equations, so `$x^2$` and `$$…$$` are parsed as maths and
 * rendered by KaTeX rather than shown as literal dollar signs.
 *
 * KaTeX's stylesheet is imported once in `styles.css`, and its version is
 * pinned to the copy `rehype-katex` renders with: the two ship together, and a
 * newer stylesheet over older markup mis-sizes every symbol.
 *
 * Money is the cost. `$5 to $12` on one line is a valid maths span to
 * `remark-math`, so it renders in italics instead of as text; escaping the
 * first dollar (`\$5`) is the way out.
 */
export const MD_NOTES_REMARK: PluggableList = [remarkGfm, remarkMath]
export const MD_NOTES_REHYPE: PluggableList = [rehypeKatex]
