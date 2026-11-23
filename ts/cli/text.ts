/**
 * Annotation text: KNIME stores node labels as plain text (usually) and workflow annotations as HTML (always, once
 * the modern UI or a gateway command has written them). These helpers convert between that and plain lines.
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** HTML to plain lines: block ends and `<br>` become newlines, tags go, entities are decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|div|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\n+$/, "");
}

/** Plain lines to HTML paragraphs, the shape the KNIME UI's editor writes. */
export function textToHtml(text: string): string {
  return text.split("\n").map((l) => `<p>${escapeHtml(l)}</p>`).join("");
}

/** The text of a `{value, contentType}` pair, as plain lines. */
export function plainText(t: { value?: string; contentType?: string } | undefined): string {
  if (!t?.value) return "";
  return t.contentType === "text/html" ? htmlToText(t.value) : t.value;
}

/**
 * A node annotation is one text field. The CLI reads its first line as the node's machine label (what `--prefix`,
 * `apply` and node lookup match) and any further lines as a human note.
 */
export function splitLabel(text: string): { label?: string; note?: string } {
  const nl = text.indexOf("\n");
  const first = (nl < 0 ? text : text.slice(0, nl)).trim();
  const rest = nl < 0 ? "" : text.slice(nl + 1).replace(/^\s*\n|\s+$/g, "");
  return { label: first || undefined, note: rest || undefined };
}

/** The inverse of {@link splitLabel}. An unlabelled node with a note gets an empty first line, so the note isn't read as a label. */
export function joinLabel(label: string | undefined, note: string | undefined): string {
  if (!note) return label ?? "";
  return `${label ?? ""}\n${note}`;
}
