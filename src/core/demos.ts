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
    id: 'analytics',
    label: '8 · Sales report: ranking, best seller, tiers',
    description: 'Helper functions, grouping, sorting by a computed value, ranking and a derived tier in one report.',
    input: {
      currency: 'EUR',
      orders: [
        { id: 'O-1', customer: 'Acme', date: '2026-09-03', lines: [{ name: 'Widget', qty: 10, unit: 2.5 }, { name: 'Gadget', qty: 2, unit: 19.99 }] },
        { id: 'O-2', customer: 'Globex', date: '2026-09-05', lines: [{ name: 'Widget', qty: 40, unit: 2.4 }] },
        { id: 'O-3', customer: 'Acme', date: '2026-09-11', lines: [{ name: 'Gizmo', qty: 3, unit: 45 }, { name: 'Widget', qty: 5, unit: 2.5 }] },
        { id: 'O-4', customer: 'Initech', date: '2026-09-14', lines: [{ name: 'Gadget', qty: 1, unit: 19.99 }] },
        { id: 'O-5', customer: 'Globex', date: '2026-09-21', lines: [{ name: 'Gizmo', qty: 2, unit: 45 }, { name: 'Gadget', qty: 4, unit: 19.99 }] }
      ]
    },
    expression: `(
  $lineTotal := function($l) { $l.qty * $l.unit };
  $orderTotal := function($o) { $sum($o.lines.$lineTotal($)) };

  /* one entry per customer: order count + revenue */
  $perCustomer := orders{
    customer: {
      "orders": $count($),
      "revenue": $round($sum($map($, $orderTotal)), 2)
    }
  };

  /* object -> array, sorted by revenue (descending), then add rank and tier */
  $sorted := ($each($perCustomer, function($v, $k) {
    { "customer": $k, "orders": $v.orders, "revenue": $v.revenue }
  }))^(>revenue);
  $ranking := $map($sorted, function($c, $i) {
    $merge([$c, { "rank": $i + 1, "tier": $c.revenue >= 200 ? "gold" : "standard" }])
  });

  /* best selling product by quantity */
  $units := orders.lines{ name: $sum($.qty) };
  $best := ($each($units, function($v, $k) { { "product": $k, "units": $v } }))^(>units)[0];

  {
    "currency": currency,
    "totalRevenue": $round($sum(orders.$orderTotal($)), 2),
    "ranking": $ranking,
    "bestSeller": $best
  }
)`
  },
  {
    id: 'join',
    label: '9 · Join two datasets (lookup, orphans, group by)',
    description: 'Look up customers for orders like a SQL left join, flag orphans, then aggregate revenue by country.',
    input: {
      customers: [
        { id: 'C1', name: 'Acme AG', country: 'CH' },
        { id: 'C2', name: 'Globex GmbH', country: 'DE' },
        { id: 'C3', name: 'Initech SA', country: 'CH' }
      ],
      countries: { CH: 'Switzerland', DE: 'Germany' },
      orders: [
        { id: 'O-1', customerId: 'C1', total: 120 },
        { id: 'O-2', customerId: 'C2', total: 80.5 },
        { id: 'O-3', customerId: 'C9', total: 50 },
        { id: 'O-4', customerId: 'C1', total: 30 },
        { id: 'O-5', customerId: 'C3', total: 220 }
      ]
    },
    expression: `(
  /* index customers by id: { "C1": {...}, "C2": {...} } */
  $byId := customers{ id: $ };

  $joined := orders.(
    $c := $lookup($byId, customerId);
    {
      "order": id,
      "total": total,
      "customer": $exists($c) ? $c.name : "(unknown customer)",
      "country": $exists($c) ? $lookup($$.countries, $c.country) : null,
      "status": $exists($c) ? "matched" : "orphan"
    }
  );

  {
    "joined": $joined,
    "orphans": $joined[status = "orphan"].order[],
    "revenueByCountry": $joined[status = "matched"]{ country: $sum(total) }
  }
)`
  },
  {
    id: 'tree',
    label: '10 · Tree: recursion, paths and descendants',
    description: 'Walk a nested category tree with a recursive function, build breadcrumb paths, and use the ** descendant operator.',
    input: {
      root: {
        id: 1,
        name: 'Store',
        children: [
          {
            id: 2,
            name: 'Clothing',
            children: [
              { id: 4, name: 'Shoes', children: [{ id: 7, name: 'Sneakers' }, { id: 8, name: 'Boots' }] },
              { id: 5, name: 'Shirts' }
            ]
          },
          { id: 3, name: 'Electronics', children: [{ id: 6, name: 'Phones' }] }
        ]
      }
    },
    expression: `(
  $walk := function($node, $path) {(
    $p := $append($path, $node.name);
    $append(
      [{
        "id": $node.id,
        "depth": $count($p),
        "path": $join($p, " > "),
        "leaf": $not($exists($node.children))
      }],
      $node.children.$walk($, $p)
    )
  )};

  $rows := root.$walk($, []);

  {
    "nodes": $count($rows),
    "maxDepth": $max($rows.depth),
    "leafPaths": $rows[leaf].path,
    "perDepth": $rows{ $string(depth): $count($) },
    "allIds (using **)": root.**.id
  }
)`
  },
  {
    id: 'timeseries',
    label: '11 · Event log: per-day stats, busiest hour, running total',
    description: 'Group events by day, compute error rate and busiest hour, format weekdays and accumulate with $reduce.',
    input: {
      events: [
        { ts: '2026-10-19T08:15:00Z', service: 'api', level: 'INFO', ms: 120 },
        { ts: '2026-10-19T08:40:00Z', service: 'api', level: 'ERROR', ms: 950 },
        { ts: '2026-10-19T09:05:00Z', service: 'db', level: 'INFO', ms: 35 },
        { ts: '2026-10-19T08:55:00Z', service: 'api', level: 'INFO', ms: 140 },
        { ts: '2026-10-20T13:10:00Z', service: 'api', level: 'ERROR', ms: 1200 },
        { ts: '2026-10-20T13:12:00Z', service: 'db', level: 'ERROR', ms: 800 },
        { ts: '2026-10-20T14:01:00Z', service: 'api', level: 'INFO', ms: 110 },
        { ts: '2026-10-21T07:30:00Z', service: 'db', level: 'INFO', ms: 40 },
        { ts: '2026-10-21T07:45:00Z', service: 'api', level: 'INFO', ms: 95 }
      ]
    },
    expression: `(
  $day := function($e) { $substring($e.ts, 0, 10) };
  $hour := function($e) { $number($substring($e.ts, 11, 2)) };

  $perDay := events{
    $day($): (
      $errors := $count($[level = "ERROR"]);
      $hours := $map($, $hour);
      $perHour := $hours{ $string($): $count($) };
      {
        "events": $count($),
        "errors": $errors,
        "errorRate": $round($errors / $count($) * 100, 1) & " %",
        "avgMs": $round($average(ms), 1),
        "slowest": $max(ms),
        "busiestHour": ($each($perHour, function($v, $k) { { "hour": $number($k), "n": $v } }))^(>n)[0].hour
      }
    )
  };

  $days := $sort($keys($perDay));

  {
    "perDay": $perDay,
    "timeline": $reduce($days, function($acc, $d) {
      $append($acc, {
        "day": $d,
        "weekday": $fromMillis($toMillis($d & "T00:00:00Z"), "[FNn]"),
        "cumulativeErrors": ($acc[-1].cumulativeErrors ? $acc[-1].cumulativeErrors : 0) + $lookup($perDay, $d).errors
      })
    }, [])
  }
)`
  },
  {
    id: 'cleansing',
    label: '12 · Data cleansing: normalize, validate, de-duplicate',
    description: 'Fix messy records (names, e-mails, phone numbers, ages), collect validation issues, drop duplicates and split valid from invalid.',
    input: {
      records: [
        { name: '  alice  smith ', email: 'Alice@Example.COM ', phone: '+41 79 123 45 67', age: '34' },
        { name: 'BOB JONES', email: 'bob.jones@@example.com', phone: '079/555-12-12', age: 'x' },
        { name: 'alice smith', email: 'alice@example.com', phone: '', age: '34' },
        { name: 'Carla', email: 'carla@example.org', phone: '0041 44 555 66 77', age: '29' }
      ]
    },
    expression: `(
  $title := function($s) {
    $join($split($lowercase($trim($s)), " ").(($substring($, 0, 1) ~> $uppercase()) & $substring($, 1)), " ")
  };
  $phone := function($p) {
    $replace($p, /[^0-9+]/, "") ~> $replace(/^00/, "+") ~> $replace(/^0/, "+41")
  };

  $clean := records.(
    $email := $lowercase($trim(email));
    $ageOk := $contains(age, /^[0-9]+$/);
    $tel := $phone(phone);
    {
      "name": $title(name),
      "email": $email,
      "phone": $tel,
      "age": $ageOk ? $number(age) : null,
      "issues": [
        $contains($email, /^[^@ ]+@[^@ ]+[.][a-z]+$/) ? undefined : "invalid email",
        $tel = "" ? "missing phone",
        $ageOk ? undefined : "age is not a number"
      ]
    }
  );

  /* keep the first record per e-mail address */
  $byEmail := $clean{ email: $[0] };
  $unique := $map($keys($byEmail), function($k) { $lookup($byEmail, $k) });

  {
    "valid": $unique[$count(issues) = 0][],
    "needsReview": $unique[$count(issues) > 0][],
    "duplicatesRemoved": $count($clean) - $count($unique)
  }
)`
  },
  {
    id: 'error',
    label: '13 · Debug an error',
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
