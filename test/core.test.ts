import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { Evaluator } from '../src/core/evaluator';
import { analyze, errorToRange, sameAst } from '../src/core/analyze';
import { formatJsonata, FormatError } from '../src/core/format';
import { fieldSuggestions, callContextAt } from '../src/core/intel';
import { DEMOS, demoInputText } from '../src/core/demos';
import { FUNCTIONS, paramLabels } from '../src/core/functions';

const workerPath = path.join(__dirname, '..', 'dist', 'worker.js');
const ev = new Evaluator({ workerPath });
after(() => ev.dispose());

describe('evaluator (official jsonata in a worker)', () => {
  test('evaluates a simple expression', async () => {
    const r = await ev.evaluate({ expression: '$sum(a.b)', input: '{"a":[{"b":1},{"b":2}]}' });
    assert.equal(r.status, 'ok');
    assert.equal((r as any).text, '3');
  });

  test('undefined result is reported as empty', async () => {
    const r = await ev.evaluate({ expression: 'nothing', input: '{}' });
    assert.equal(r.status, 'empty');
  });

  test('syntax error carries code and position', async () => {
    const r = await ev.evaluate({ expression: '$sum(', input: '{}' });
    assert.equal(r.status, 'error');
    assert.equal((r as any).phase, 'parse');
    assert.ok((r as any).error.code);
  });

  test('runtime error is flagged as eval phase', async () => {
    const r = await ev.evaluate({ expression: 'a + "x"', input: '{"a":1}' });
    assert.equal(r.status, 'error');
    assert.equal((r as any).phase, 'eval');
    assert.equal((r as any).error.code, 'T2002'); // right side of + is not a number
  });

  test('invalid input JSON is reported separately', async () => {
    const r = await ev.evaluate({ expression: 'a', input: '{oops' });
    assert.equal(r.status, 'error');
    assert.equal((r as any).phase, 'input');
  });

  test('runaway recursion is aborted by the timeout and the evaluator recovers', async () => {
    const r = await ev.evaluate({
      expression: '($f := function($x){ $f($x) }; $f(1))',
      input: '{}',
      timeoutMs: 800
    });
    assert.ok(r.status === 'timeout' || r.status === 'error', `got ${r.status}`);
    const again = await ev.evaluate({ expression: '1+1' });
    assert.equal(again.status, 'ok');
  });

  test('supersede cancels the previous request', async () => {
    const live = new Evaluator({ workerPath, supersede: true });
    const first = live.evaluate({ expression: '($f := function($x){ $f($x) }; $f(1))', timeoutMs: 5000 });
    const second = await live.evaluate({ expression: '2*3' });
    assert.equal(second.status, 'ok');
    assert.equal((await first).status, 'cancelled');
    live.dispose();
  });
});

describe('demos', () => {
  for (const d of DEMOS) {
    test(`demo "${d.label}" ${d.expectError ? 'fails as intended' : 'evaluates cleanly'}`, async () => {
      const r = await ev.evaluate({ expression: d.expression, input: demoInputText(d) });
      if (d.expectError) assert.equal(r.status, 'error');
      else {
        assert.equal(r.status, 'ok', JSON.stringify(r));
        assert.ok((r as any).text.length > 0);
      }
    });
  }
});

describe('analyze', () => {
  test('valid expression has no issues', () => {
    assert.deepEqual(analyze('$sum(a.b)').issues, []);
  });
  test('syntax error is located', () => {
    const { issues } = analyze('a.b +');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'error');
  });
  test('unknown function warns, user-defined does not', () => {
    assert.equal(analyze('$nope(1)').issues[0].severity, 'warning');
    assert.deepEqual(analyze('($f := function($x){$x}; $f(1))').issues, []);
    assert.deepEqual(analyze('$map([1],function($v){$v})').issues, []);
  });
  test('errorToRange never leaves the document', () => {
    const r = errorToRange({ position: 999 }, 'abc');
    assert.ok(r.start >= 0 && r.end <= 3 && r.end > r.start);
  });
});

describe('formatter', () => {
  test('formats and preserves semantics', async () => {
    const src = '$map(xs,function($v,$i){$v+$i})  ~>   $sum()';
    const out = await formatJsonata(src);
    assert.ok(sameAst(src, out));
    assert.notEqual(out, src);
  });
  test('refuses to emit output that changes the AST', async () => {
    // Known printer limitation: predicate after an object constructor is dropped.
    const src = 'Account.Order.Product.{"name":ProductName}[total>10]';
    await assert.rejects(() => formatJsonata(src), FormatError);
  });
  test('syntax errors are rejected with a message', async () => {
    await assert.rejects(() => formatJsonata('a +'), FormatError);
  });
  test('all demo expressions survive formatting or are refused safely', async () => {
    for (const d of DEMOS) {
      try {
        const out = await formatJsonata(d.expression);
        assert.ok(sameAst(d.expression, out), d.label);
      } catch (e) {
        assert.ok(e instanceof FormatError, d.label);
      }
    }
  });
});

describe('intellisense helpers', () => {
  const doc = { Account: { Order: [{ Product: [{ Name: 'x', Price: 1 }], id: 'o1' }] }, other: 1 };
  test('suggests children after a dotted path', () => {
    const names = fieldSuggestions(doc, 'Account.Order.').map((f) => f.name).sort();
    assert.deepEqual(names, ['Product', 'id']);
  });
  test('resolves relative paths anywhere in the document', () => {
    const names = fieldSuggestions(doc, 'Product.').map((f) => f.name).sort();
    assert.deepEqual(names, ['Name', 'Price']);
  });
  test('falls back to all keys without a path', () => {
    assert.ok(fieldSuggestions(doc, 'x + ').length >= 5);
  });
  test('signature help context', () => {
    assert.deepEqual(callContextAt('$substring(a, '), { name: 'substring', argIndex: 1 });
    assert.deepEqual(callContextAt('$map(xs, function($v) { $v + '), { name: 'map', argIndex: 1 });
    assert.equal(callContextAt('$sum(a) + '), undefined);
    assert.equal(callContextAt('$join("a,'), undefined); // inside a string
  });
  test('every function has a valid parameter range list', () => {
    for (const f of FUNCTIONS) {
      for (const [a, b] of paramLabels(f)) {
        assert.ok(a >= 0 && b > a && b <= f.signature.length, f.signature);
      }
    }
  });
});

import { parseInputComment, withInputComment } from '../src/core/bindings';
describe('input bindings', () => {
  test('parses the header comment', () => {
    assert.equal(parseInputComment('/* input: ./data/order.json */\na.b'), './data/order.json');
    assert.equal(parseInputComment('/* INPUT : "C:/x/y.json" */ a'), 'C:/x/y.json');
    assert.equal(parseInputComment('a.b /* just a comment */'), undefined);
  });
  test('writes and replaces the header comment', () => {
    const once = withInputComment('a.b', './x.json');
    assert.equal(once, '/* input: ./x.json */\na.b');
    assert.equal(withInputComment(once, './y.json'), '/* input: ./y.json */\na.b');
    assert.ok(sameAst('a.b', once)); // comment does not change the expression
  });
});

import { describeStructure } from '../src/core/schema';
import { CHEATSHEET } from '../src/core/cheatsheet';
describe('structure summary for AI prompts', () => {
  const data = {
    customer: { name: 'A' },
    orders: [
      { id: 'x', items: [{ price: 1, qty: 2 }], note: 'n' },
      { id: 'y', items: [{ price: 3 }] }
    ]
  };
  const out = describeStructure(data);
  test('shows nesting, arrays, optional keys and sample paths', () => {
    assert.match(out, /orders: array<object> \[2 items\]/);
    assert.match(out, /items: array<object>/);
    assert.match(out, /qty\?: number/); // missing in one element
    assert.match(out, /note\?: string/);
    assert.match(out, /Example leaf paths: .*orders\.items\.price/);
  });
  test('handles scalars, empty arrays and odd keys', () => {
    assert.match(describeStructure(5), /\$: number/);
    assert.match(describeStructure({ a: [] }), /a: array<empty> \[0 items\]/);
    assert.match(describeStructure({ 'first name': 1 }), /`first name`: number/);
  });
  test('is much smaller than large data', () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: 'n' + i })) };
    assert.ok(describeStructure(big).length < 1200);
  });
  test('cheat sheet examples are valid JSONata', async () => {
    const samples = ['orders[-1].id', 'items^(>price)', 'items{category: $sum(price)}', 'a.b[]', '$not(1=2)'];
    for (const s of samples) assert.deepEqual(analyze(s).issues, [], s);
    assert.ok(CHEATSHEET.length > 500);
  });
});

describe('formatter object layout', () => {
  const src = `(
  $factorial := function($x) { $x <= 1 ? 1 : $x * $factorial($x - 1) };
  {
    "n": n,
     "factorial": $factorial(n),
    "fibonacci": $map([0..n], $fib)
  }
)`;
  const small = '{ "a": 1 }';
  test('auto collapses objects that fit (plugin default)', async () => {
    const out = await formatJsonata(src, { objectLayout: 'auto' });
    assert.match(out, /\{ "n": n, "factorial": \$factorial\(n\), "fibonacci": \$map\(\[0\.\.n\], \$fib\) \}/);
  });
  test('preserve keeps a multi-line object multi-line, but collapses single-line ones', async () => {
    const out = await formatJsonata(src, { objectLayout: 'preserve' });
    assert.match(out, /\{\n\s+"n": n,\n\s+"factorial": \$factorial\(n\),\n\s+"fibonacci": \$map\(\[0\.\.n\], \$fib\)\n\s+\}/);
    assert.ok(sameAst(src, out));
    assert.equal(await formatJsonata(small, { objectLayout: 'preserve' }), small);
  });
  test('expanded always breaks every key onto its own line', async () => {
    const out = await formatJsonata(small, { objectLayout: 'expanded' });
    assert.equal(out, '{\n  "a": 1\n}');
    assert.ok(sameAst(small, out));
  });
  test('group-by objects follow the same rules', async () => {
    const g = 'items{\n  k: $sum(v)\n}';
    const out = await formatJsonata(g, { objectLayout: 'preserve' });
    assert.match(out, /\{\n\s+k: \$sum\(v\)\n\}/);
    assert.equal(await formatJsonata('items{ k: $sum(v) }', { objectLayout: 'preserve' }), 'items{ k: $sum(v) }');
  });
});

import { candidateSpans, pathPrefixes, wrapSpan, isValidSpan } from '../src/core/probe';
describe('step-through probes', () => {
  const expr = '$sum(orders.items.(price * qty))';
  const data = JSON.stringify({ orders: [{ items: [{ price: 2, qty: 3 }, { price: 4, qty: 1 }] }, { items: [{ price: 5, qty: 2 }] }] });
  const at = (needle: string, delta = 1) => expr.indexOf(needle) + delta;
  const texts = (offset: number) => candidateSpans(expr, offset).map((s) => expr.slice(s.start, s.end));

  test('candidates grow from the token to the whole expression', () => {
    const t = texts(at('price'));
    assert.equal(t[0], 'price');
    assert.ok(t.includes('price * qty'));
    assert.ok(t.includes('orders.items.(price * qty)'));
    assert.equal(t[t.length - 1], expr);
    for (let i = 1; i < t.length; i++) assert.ok(t[i].length >= t[i - 1].length);
  });
  test('call and path chains around a name are found', () => {
    assert.ok(texts(at('orders')).includes('orders.items'));
    assert.ok(texts(at('$sum', 2)).includes(expr));
  });
  test('wrapped expression is still valid and only valid spans are offered', () => {
    for (const s of candidateSpans(expr, at('qty'))) assert.ok(isValidSpan(expr, s));
    assert.equal(wrapSpan('a.b', { start: 2, end: 3 }), 'a.$__probe(b)');
  });
  test('values are captured in context, once per evaluation', async () => {
    const span = candidateSpans(expr, at('price'))[0];
    const r: any = await ev.evaluate({ expression: expr, input: data, probes: [span] });
    assert.equal(r.status, 'probe');
    assert.equal(r.results[0].calls, 3);
    assert.deepEqual(r.results[0].values.map((v: string) => JSON.parse(v)), [2, 4, 5]);
  });
  test('a part that is never reached reports zero calls', async () => {
    const e = 'missing ? price : 0';
    const s = candidateSpans(e, e.indexOf('price') + 1)[0];
    const r: any = await ev.evaluate({ expression: e, input: '{"price":1}', probes: [s] });
    assert.equal(r.results[0].calls, 0);
  });
  test('probing does not change what the surrounding expression computes', async () => {
    const e = 'a.b + 1';
    const s = candidateSpans(e, 2)[0];
    const r: any = await ev.evaluate({ expression: e, input: '{"a":{"b":41}}', probes: [s] });
    assert.equal(r.results[0].values[0], '41');
    assert.equal(r.results[0].error, undefined);
  });
  test('path prefixes give one probe per step', () => {
    const p = pathPrefixes('orders.items.price');
    assert.deepEqual(p.map((x) => x.label), ['orders', 'orders.items', 'orders.items.price']);
    assert.deepEqual(pathPrefixes('a[0].b'), []);
  });
});

describe('probes on the demo expressions', () => {
  test('every demo: spans at many cursor positions are valid and probing never crashes', async () => {
    let probed = 0;
    for (const d of DEMOS) {
      const text = d.expression;
      for (let off = 0; off <= text.length; off += 13) {
        const spans = candidateSpans(text, off);
        for (const s of spans) assert.ok(isValidSpan(text, s), `${d.id}@${off}`);
        if (spans[0]) {
          const r: any = await ev.evaluate({ expression: text, input: demoInputText(d), probes: [spans[0]] });
          assert.equal(r.status, 'probe', `${d.id}@${off}: ${JSON.stringify(r).slice(0, 200)}`);
          assert.equal(r.results[0].parseError, undefined, `${d.id}@${off}`);
          probed++;
        }
      }
    }
    assert.ok(probed > 50);
  });
});

import { inspectPart } from '../src/core/inspectpart';
describe('inspectPart (AI tool)', () => {
  const data = JSON.stringify({ orders: [{ items: [{ price: 2, qty: 3 }] }, { items: [{ price: 5, qty: 2 }] }] });
  test('reports per-item values and a step breakdown', async () => {
    const r = await inspectPart(ev, { expression: '$sum(orders.items.(price * qty))', part: 'orders.items', input: data });
    assert.equal(r.isError, false);
    assert.match(r.text, /evaluated once/);
    assert.match(r.text, /Step by step/);
  });
  test('says when a part is not reached and rejects non-expressions', async () => {
    const miss = await inspectPart(ev, { expression: 'nothing.x + 1', part: 'x', input: '{}' });
    assert.match(miss.text, /not reached/);
    const bad = await inspectPart(ev, { expression: 'a.b', part: '.b', input: '{}' });
    assert.equal(bad.isError, true);
  });
});
