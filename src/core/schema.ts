/**
 * Compact structural summary of a JSON document, designed to be pasted into an AI prompt:
 * far smaller than the data itself, and it shows exactly which key names, nesting and array
 * boundaries a JSONata path has to follow.
 */

interface Shape {
  types: Set<string>;
  samples: string[];
  props?: Map<string, Shape>;
  propCount?: Map<string, number>;
  objects: number; // how many object instances were merged
  items?: Shape;
  minLen: number;
  maxLen: number;
}

const newShape = (): Shape => ({ types: new Set(), samples: [], objects: 0, minLen: Infinity, maxLen: 0 });

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'number' : 'number';
  return typeof v;
}

function addSample(shape: Shape, v: unknown): void {
  if (v === null || typeof v === 'object') return;
  let s = JSON.stringify(v);
  if (s.length > 32) s = s.slice(0, 29) + '..."';
  if (shape.samples.length < 3 && !shape.samples.includes(s)) shape.samples.push(s);
}

function merge(shape: Shape, v: unknown, depth: number): void {
  shape.types.add(typeName(v));
  if (Array.isArray(v)) {
    shape.minLen = Math.min(shape.minLen, v.length);
    shape.maxLen = Math.max(shape.maxLen, v.length);
    shape.items ??= newShape();
    for (const el of v.slice(0, 200)) merge(shape.items, el, depth + 1);
  } else if (v && typeof v === 'object') {
    shape.objects++;
    shape.props ??= new Map();
    shape.propCount ??= new Map();
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      let child = shape.props.get(k);
      if (!child) shape.props.set(k, (child = newShape()));
      shape.propCount.set(k, (shape.propCount.get(k) ?? 0) + 1);
      merge(child, val, depth + 1);
    }
  } else {
    addSample(shape, v);
  }
}

function label(shape: Shape): string {
  const parts: string[] = [];
  for (const t of shape.types) {
    if (t === 'array') {
      const inner = shape.items ? [...shape.items.types].join('|') || 'empty' : 'empty';
      const len = shape.minLen === shape.maxLen ? `${shape.maxLen}` : `${shape.minLen}..${shape.maxLen}`;
      parts.push(`array<${inner}> [${len} item${len === '1' ? '' : 's'}]`);
    } else parts.push(t);
  }
  return parts.join(' | ');
}

const MAX_DEPTH = 9;
const MAX_KEYS = 40;

function render(shape: Shape, name: string, indent: number, out: string[], optional: boolean, depth: number): void {
  const pad = '  '.repeat(indent);
  const ex = shape.samples.length ? `   e.g. ${shape.samples.join(', ')}` : '';
  out.push(`${pad}${name}${optional ? '?' : ''}: ${label(shape)}${ex}`);
  if (depth >= MAX_DEPTH) {
    if (shape.props || shape.items) out.push(`${pad}  ...`);
    return;
  }
  // objects directly, or the element shape of arrays (JSONata paths flatten arrays transparently)
  let target: Shape | undefined = shape;
  while (target?.items && !target.props) target = target.items;
  const holder = shape.props ? shape : shape.items?.props ? shape.items : target;
  if (holder?.props) {
    const entries = [...holder.props.entries()];
    for (const [k, child] of entries.slice(0, MAX_KEYS)) {
      const opt = (holder.propCount?.get(k) ?? 0) < holder.objects;
      render(child, /^[A-Za-z_]\w*$/.test(k) ? k : '`' + k + '`', indent + 1, out, opt, depth + 1);
    }
    if (entries.length > MAX_KEYS) out.push(`${pad}  ... ${entries.length - MAX_KEYS} more keys`);
  } else if (shape.items?.items) {
    render(shape.items, '[]', indent + 1, out, false, depth + 1);
  }
}

function leafPaths(shape: Shape, prefix: string, out: string[], depth: number): void {
  if (out.length >= 12 || depth > MAX_DEPTH) return;
  let holder: Shape | undefined = shape;
  while (holder?.items && !holder.props) holder = holder.items;
  if (shape.props) holder = shape;
  else if (shape.items?.props) holder = shape.items;
  if (holder?.props) {
    for (const [k, child] of holder.props) {
      const seg = /^[A-Za-z_]\w*$/.test(k) ? k : '`' + k + '`';
      leafPaths(child, prefix ? `${prefix}.${seg}` : seg, out, depth + 1);
      if (out.length >= 12) return;
    }
  } else if (prefix) out.push(prefix);
}

export interface StructureOptions {
  /** Max characters of output; the summary is cut with a note when exceeded. */
  maxChars?: number;
}

/** Returns a plain-text outline of the document, e.g. for LLM prompts. */
export function describeStructure(value: unknown, opts: StructureOptions = {}): string {
  const root = newShape();
  merge(root, value, 0);
  const lines: string[] = [];
  render(root, '$', 0, lines, false, 0);
  const paths: string[] = [];
  leafPaths(root, '', paths, 0);
  let text = lines.join('\n');
  const max = opts.maxChars ?? 6000;
  if (text.length > max) text = text.slice(0, max) + '\n... (structure truncated)';
  const notes = [
    '',
    'Legend: key? = optional (missing in some objects); array<...> [n items] = array of that element type.',
    'JSONata paths flatten arrays automatically: use the key names exactly as written (case-sensitive), no [] needed to traverse.'
  ];
  if (paths.length) notes.push('Example leaf paths: ' + paths.join(', '));
  return text + '\n' + notes.join('\n');
}
