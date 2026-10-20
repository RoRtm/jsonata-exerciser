// Expression files can name their input JSON in a leading JSONata comment of the form
//   input: ./samples/order.json   (wrapped in a block comment)
// which makes the binding portable: it lives in the file (e.g. under git).
const RE = /\/\*\s*input\s*:\s*([^\r\n*]+?)\s*\*\//i;

/** Returns the path written in the `input:` comment near the top of the file, if any. */
export function parseInputComment(text: string): string | undefined {
  const m = RE.exec(text.slice(0, 1000));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
}

/** Inserts or replaces the `input:` comment at the top of an expression. */
export function withInputComment(text: string, relPath: string): string {
  const comment = `/* input: ${relPath} */`;
  const head = text.slice(0, 1000);
  const m = RE.exec(head);
  if (m) return text.slice(0, m.index) + comment + text.slice(m.index + m[0].length);
  return `${comment}\n${text}`;
}
