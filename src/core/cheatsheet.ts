/** JSONata guidance shared by the chat participant, the LM tools, the MCP server and the generated instruction files. */

export const CHEATSHEET = `# JSONata cheat sheet (JSONata 2.x, not JavaScript)

Paths and navigation
- \`Account.Order.Product.Name\`: dotted path; arrays are traversed and flattened automatically (no loops). Keys are case-sensitive. Quote odd keys with backticks: \`\`first name\`\`.
- \`orders[0]\` first item, \`orders[-1]\` last, \`orders[price > 10]\` filter by predicate, \`orders[status = "open"].id\`.
- \`$\` = current context item (inside a predicate or a step), \`$$\` = root document, \`*\` any key, \`**\` any depth, \`%\` parent.
- \`a.b[]\` forces an array result even for a single value. A path that matches nothing yields no result (undefined), not null.

Building results
- Object per element: \`orders.{ "id": id, "total": $sum(items.(price * qty)) }\` returns an array of objects.
- Group by key: \`items{ category: $sum(price) }\` returns ONE object keyed by category.
- Array: \`[a, b]\`; range \`[1..5]\`; concatenation of strings uses \`&\` (not +).
- Sorting: \`items^(price)\` ascending, \`items^(>price)\` descending; or \`$sort(arr, function($l,$r){ $l.x > $r.x })\`.

Operators and syntax
- Equality is \`=\` and \`!=\` (never == or ===). Logic: \`and\`, \`or\`, \`$not(x)\`. Membership: \`x in [1,2]\`.
- Conditional: \`cond ? a : b\` (no if/else, no return, no for/while, no arrow functions, no .map()/.filter() methods).
- Variables and blocks: \`( $x := price * qty; $x * 2 )\`; functions: \`function($a, $b) { $a + $b }\`; chain: \`value ~> $uppercase()\`.
- Comments: \`/* ... */\`. Regex literal: \`/pattern/i\` used with $match, $contains, $replace, $split.

Frequently used functions
$sum $count $average $max $min | $map(arr, function($v,$i,$a){..}) $filter $reduce(arr, function($prev,$curr){..}, init) $sort $distinct $reverse $zip $append
$keys $lookup $merge $spread $each(obj, function($v,$k){..}) $sift | $string $number $boolean $exists $type
$substring $substringBefore $substringAfter $uppercase $lowercase $trim $pad $contains $split $join $match $replace $length
$round $floor $ceil $abs $power $sqrt $formatNumber | $now $millis $fromMillis $toMillis | $eval

Common mistakes
- Using JavaScript syntax (==, +, .map, =>, return). Wrong key case. Forgetting that an empty path result is undefined.
- A predicate/index binds to each step: \`a.b[0]\` is the first b of EACH a; use \`(a.b)[0]\` for the first overall.
- Using \`$\` where the root is meant inside a nested predicate (use \`$$\`).
- Expecting \`items{key: value}\` to return an array (it returns one object; use \`items.{...}\` for an array).
- Inventing functions that do not exist; check the list above or the docs at https://docs.jsonata.org.
`;

export const DIRECTIVES = `Workflow for writing JSONata with the JSONata Exerciser tools:
1. Read the user's data first: call #jsonataExerciserState (current expression, input, result) and/or #jsonataInputStructure (compact outline of the input JSON). Use the exact key names and nesting you see.
2. Write the expression, then run it against the real input with #jsonataEvaluate. If it returns an error or an empty result, find the failing part with #jsonataInspect (it shows the value of any sub-expression, per item, in context) instead of guessing, fix it and run again. Do not present an expression you have not evaluated.
3. Only after it produces the intended output, give the final expression in ONE \`\`\`jsonata code block and show a short sample of the output.
4. If the target output shape is unclear, ask the user for an example of the desired output instead of guessing.
5. Use #jsonataExerciserUpdate only when the user asks you to apply the expression to their Exerciser.
6. If the user says an expression is slow, use #jsonataProfile (optionally with scaleArrays to simulate larger data) to find the hot spot before changing anything.`;
