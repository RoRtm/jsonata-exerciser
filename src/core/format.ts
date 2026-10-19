import { format } from 'prettier/standalone';
// The plugin builds on the official `jsonata` parser and provides the printer.
import * as plugin from '@stedi/prettier-plugin-jsonata';
import { sameAst } from './analyze';
import jsonata from 'jsonata';

export interface FormatOptions {
  printWidth?: number;
  tabWidth?: number;
  useTabs?: boolean;
}

export class FormatError extends Error {}

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
      plugins: [plugin as any],
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
