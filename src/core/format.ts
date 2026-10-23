import { format } from 'prettier/standalone';
// The plugin builds on the official `jsonata` parser and provides the printer.
import * as plugin from '@stedi/prettier-plugin-jsonata';
import { sameAst } from './analyze';
import jsonata from 'jsonata';

/**
 * How object constructors `{ ... }` are laid out:
 * - preserve: stay multi-line if you wrote a line break after `{` (like Prettier does for JavaScript objects)
 * - expanded: always one key per line
 * - auto: the plugin default; objects that fit into printWidth are collapsed onto one line
 */
export type ObjectLayout = 'auto' | 'preserve' | 'expanded';

export interface FormatOptions {
  printWidth?: number;
  tabWidth?: number;
  useTabs?: boolean;
  objectLayout?: ObjectLayout;
}

export class FormatError extends Error {}

/** Finds the `{ ... }` group inside a printed doc (shallow search) and forces it to break. */
function breakBraceGroup(doc: any, from: 'first' | 'last'): void {
  const isBrace = (d: any) => d && d.type === 'group' && Array.isArray(d.contents) && d.contents[0] === '{';
  const search = (d: any, depth: number): any => {
    if (!d || depth > 3) return undefined;
    if (isBrace(d)) return d;
    const kids: any[] = Array.isArray(d) ? d : Array.isArray(d.contents) ? d.contents : d.contents ? [d.contents] : [];
    const ordered = from === 'last' ? [...kids].reverse() : kids;
    for (const k of ordered) {
      const hit = search(k, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  };
  const group = search(doc, 0);
  if (group) group.break = true;
}

/** Wraps the Stedi printer to honor the object layout option. */
function pluginFor(mode: ObjectLayout): any {
  if (mode === 'auto') return plugin;
  const base = (plugin as any).printers.JSONataASTNode;
  const wantBreak = (text: string, afterBrace: number | undefined) =>
    mode === 'expanded' || (typeof afterBrace === 'number' && /^[ \t]*\r?\n/.test(text.slice(afterBrace)));
  return {
    ...plugin,
    printers: {
      JSONataASTNode: {
        ...base,
        print(path: any, options: any, printChildren: any) {
          const doc = base.print(path, options, printChildren);
          const node = path.getValue();
          const text: string = options.originalText ?? '';
          if (node?.type === 'unary' && node.value === '{' && node.lhs?.length && wantBreak(text, node.position)) {
            breakBraceGroup(doc, 'first');
          }
          if (node?.group?.lhs?.length && wantBreak(text, node.group.position)) {
            breakBraceGroup(doc, 'last');
          }
          return doc;
        }
      }
    }
  };
}

/**
 * Formats a JSONata expression.
 *
 * Safety net: the formatted text is re-parsed with the official parser and its AST must be
 * identical to the original. If not, nothing is changed and a FormatError is thrown. This
 * guards against printer bugs silently altering the meaning of an expression.
 */
export async function formatJsonata(text: string, opts: FormatOptions = {}): Promise<string> {
  if (text.trim().length === 0) return text;
  try {
    jsonata(text);
  } catch (err: any) {
    throw new FormatError(`Cannot format: ${err?.code ?? ''} ${err?.message ?? err}`.trim());
  }
  let out: string;
  try {
    out = await format(text, {
      parser: 'JSONata',
      plugins: [pluginFor(opts.objectLayout ?? 'preserve')],
      printWidth: opts.printWidth ?? 80,
      tabWidth: opts.tabWidth ?? 2,
      useTabs: opts.useTabs ?? false
    });
  } catch (err: any) {
    throw new FormatError(`Formatter failed: ${err?.message ?? err}`);
  }
  out = out.replace(/\s+$/, '');
  if (!sameAst(text, out)) {
    throw new FormatError(
      'Formatting skipped: the formatter output would not parse to the same expression (formatter limitation). Your text was left unchanged.'
    );
  }
  return out;
}
