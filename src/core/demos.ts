export interface Demo {
  id: string;
  label: string;
  description: string;
  input: unknown;
  expression: string;
  /** The demo intentionally ends in an error so users can see the diagnostics. */
  expectError?: boolean;
}

const orders = {
  customer: { name: 'Alice Example', country: 'CH' },
  orders: [
    {
      id: 'A-1001',
      status: 'open',
      items: [
        { name: 'Notebook', price: 4.5, qty: 10 },
        { name: 'Monitor', price: 199, qty: 2 }
      ]
    },
    {
      id: 'A-1002',
      status: 'shipped',
      items: [
        { name: 'Keyboard', price: 59.9, qty: 1 },
        { name: 'Cable', price: 7.25, qty: 4 }
      ]
    }
  ]
};

export const DEMOS: Demo[] = [
  {
    id: 'hello',
    label: '1 · Hello, JSONata',
    description: 'Path navigation and string concatenation.',
    input: { greeting: 'Hello', name: 'World' },
    expression: 'greeting & ", " & name & "!"'
  },
  {
    id: 'paths',
    label: '2 · Paths, predicates & aggregation',
    description: 'Navigate nested arrays, filter with predicates, sum computed values.',
    input: orders,
    expression: `{
  "customer": customer.name,
  "orderCount": $count(orders),
  "revenue": $sum(orders.items.(price * qty)),
  "bigItems": orders.items[price > 50].name,
  "openOrders": orders[status = "open"].id
}`
  },
  {
    id: 'reshape',
    label: '3 · Reshape into a new structure',
    description: 'Build a new object for every element of an array.',
    input: orders,
    expression: `orders.{
  "id": id,
  "status": $uppercase(status),
  "lines": $count(items),
  "total": $round($sum(items.(price * qty)), 2)
}`
  },
  {
    id: 'group',
    label: '4 · Group by & aggregate',
    description: 'Object constructor on a path groups by key.',
    input: {
      employees: [
        { name: 'Ada', department: 'Engineering', salary: 120000 },
        { name: 'Linus', department: 'Engineering', salary: 110000 },
        { name: 'Grace', department: 'Research', salary: 130000 },
        { name: 'Alan', department: 'Research', salary: 125000 },
        { name: 'Margaret', department: 'Operations', salary: 90000 }
      ]
    },
    expression: `employees{
  department: {
    "headcount": $count($),
    "avgSalary": $round($average(salary), 2),
    "people": $join(name, ", ")
  }
}`
  },
  {
    id: 'hof',
    label: '5 · Higher-order functions',
    description: '$map, $filter, $reduce and $sort with lambda functions.',
    input: { numbers: [5, 3, 8, 1, 9, 2] },
    expression: `{
  "squares": $map(numbers, function($v) { $v * $v }),
  "evens": $filter(numbers, function($v) { $v % 2 = 0 }),
  "sum": $reduce(numbers, function($acc, $v) { $acc + $v }),
  "sortedDesc": $sort(numbers, function($l, $r) { $l < $r })
}`
  },
  {
    id: 'strings',
    label: '6 · Strings, regex & dates',
    description: 'String functions, regular expressions, date formatting.',
    input: {
      email: 'Jane.Doe@Example.com',
      log: '2026-10-19T08:30:00.000Z ERROR disk full'
    },
    expression: `{
  "user": $substringBefore(email, "@") ~> $lowercase(),
  "domain": $substringAfter(email, "@") ~> $lowercase(),
  "level": $match(log, /(INFO|WARN|ERROR)/).match,
  "message": $trim($substringAfter(log, "ERROR")),
  "day": $fromMillis($toMillis($substringBefore(log, " ")), "[FNn], [D1o] [MNn] [Y]")
}`
  },
  {
    id: 'functions',
    label: '7 · Variables, blocks & recursion',
    description: 'User-defined functions inside a block expression.',
    input: { n: 6 },
    expression: `(
  $factorial := function($x) { $x <= 1 ? 1 : $x * $factorial($x - 1) };
  $fib := function($x) { $x < 2 ? $x : $fib($x - 1) + $fib($x - 2) };
  {
    "n": n,
    "factorial": $factorial(n),
    "fibonacci": $map([0..n], $fib)
  }
)`
  },
  {
    id: 'error',
    label: '8 · Debug an error',
    description: 'Intentionally broken: shows how runtime errors are displayed. Fix it to see the result.',
    input: { price: 10, qty: 3, label: 'abc' },
    expression: 'price * qty + label',
    expectError: true
  }
];

export function demoById(id: string): Demo | undefined {
  return DEMOS.find((d) => d.id === id);
}

export function demoInputText(d: Demo): string {
  return JSON.stringify(d.input, null, 2);
}
