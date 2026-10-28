/**
 * Test cases that ship with the demos. Each demo has one case for its own data and a few edge cases;
 * several of them show JSONata behavior that surprises people, for example that a single-item array
 * is returned as the item itself. Expected values were reviewed by hand against the expressions.
 * Opening a demo shows its results next to the expression ("3/3 tests passing"); change the
 * expression and watch which cases fail. "Export Demo with Tests" writes them as files.
 */
import type { Demo } from './demos';
import type { TestCase } from './testing';

type Case = Omit<TestCase, 'input'> & { input: unknown };

const EXTRA: Record<string, Case[]> = {
  hello: [
    {
      name: 'other names',
      input: {
        greeting: 'Hi',
        name: 'Ada',
      },
      expected: 'Hi, Ada!',
    },
    {
      name: 'a missing name leaves an empty string',
      input: {
        greeting: 'Hi',
      },
      expected: 'Hi, !',
    },
  ],
  paths: [
    {
      name: 'no orders: revenue and lists are left out',
      input: {
        customer: {
          name: 'Bo',
        },
        orders: [],
      },
      expected: {
        customer: 'Bo',
        orderCount: 0,
      },
    },
    {
      name: 'one order: single values lose their array',
      description: 'JSONata returns a single item without the array brackets.',
      input: {
        customer: {
          name: 'Bo',
        },
        orders: [
          {
            id: 'X-1',
            status: 'open',
            items: [
              {
                name: 'TV',
                price: 300,
                qty: 1,
              },
            ],
          },
        ],
      },
      expected: {
        customer: 'Bo',
        orderCount: 1,
        revenue: 300,
        bigItems: 'TV',
        openOrders: 'X-1',
      },
    },
  ],
  reshape: [
    {
      name: 'no orders gives no result',
      input: {
        orders: [],
      },
      expectUndefined: true,
    },
    {
      name: 'one order gives an object, not an array',
      description: 'JSONata returns a single item without the array brackets.',
      input: {
        orders: [
          {
            id: 'X-1',
            status: 'paid',
            items: [
              {
                name: 'Pen',
                price: 1.25,
                qty: 3,
              },
            ],
          },
        ],
      },
      expected: {
        id: 'X-1',
        status: 'PAID',
        lines: 1,
        total: 3.75,
      },
    },
  ],
  group: [
    {
      name: 'single employee',
      input: {
        employees: [
          {
            name: 'Ada',
            department: 'Research',
            salary: 100000,
          },
        ],
      },
      expected: {
        Research: {
          headcount: 1,
          avgSalary: 100000,
          people: 'Ada',
        },
      },
    },
  ],
  hof: [
    {
      name: 'three numbers: a single even number is not wrapped',
      description: 'JSONata returns a single item without the array brackets.',
      input: {
        numbers: [3, 2, 1],
      },
      expected: {
        squares: [9, 4, 1],
        evens: 2,
        sum: 6,
        sortedDesc: [3, 2, 1],
      },
    },
  ],
  strings: [
    {
      name: 'upper-case address and an error line',
      input: {
        email: 'BOB@Example.COM',
        log: '2026-01-02T00:00:00Z ERROR timeout',
      },
      expected: {
        user: 'bob',
        domain: 'example.com',
        level: 'ERROR',
        message: 'timeout',
        day: 'Friday, 2nd January 2026',
      },
    },
  ],
  functions: [
    {
      name: 'n = 0',
      input: {
        n: 0,
      },
      expected: {
        n: 0,
        factorial: 1,
        fibonacci: 0,
      },
    },
    {
      name: 'n = 10',
      input: {
        n: 10,
      },
      expected: {
        n: 10,
        factorial: 3628800,
        fibonacci: [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55],
      },
    },
  ],
  analytics: [
    {
      name: 'a single order: ranking is one object',
      description: 'JSONata returns a single item without the array brackets.',
      input: {
        currency: 'CHF',
        orders: [
          {
            id: 'O-1',
            customer: 'Acme',
            date: '2026-09-03',
            lines: [
              {
                name: 'Widget',
                qty: 10,
                unit: 2.5,
              },
            ],
          },
        ],
      },
      expected: {
        currency: 'CHF',
        totalRevenue: 25,
        ranking: {
          customer: 'Acme',
          orders: 1,
          revenue: 25,
          rank: 1,
          tier: 'standard',
        },
        bestSeller: {
          product: 'Widget',
          units: 10,
        },
      },
    },
  ],
  join: [
    {
      name: 'only an orphan order',
      input: {
        customers: [
          {
            id: 'C1',
            name: 'Acme AG',
            country: 'CH',
          },
        ],
        countries: {
          CH: 'Switzerland',
        },
        orders: [
          {
            id: 'O-1',
            customerId: 'C9',
            total: 10,
          },
        ],
      },
      expected: {
        joined: {
          order: 'O-1',
          total: 10,
          customer: '(unknown customer)',
          country: null,
          status: 'orphan',
        },
        orphans: ['O-1'],
        revenueByCountry: {},
      },
    },
    {
      name: 'every order matches: no orphans key',
      input: {
        customers: [
          {
            id: 'C1',
            name: 'Acme AG',
            country: 'CH',
          },
        ],
        countries: {
          CH: 'Switzerland',
        },
        orders: [
          {
            id: 'O-1',
            customerId: 'C1',
            total: 10,
          },
          {
            id: 'O-2',
            customerId: 'C1',
            total: 5,
          },
        ],
      },
      expected: {
        joined: [
          {
            order: 'O-1',
            total: 10,
            customer: 'Acme AG',
            country: 'Switzerland',
            status: 'matched',
          },
          {
            order: 'O-2',
            total: 5,
            customer: 'Acme AG',
            country: 'Switzerland',
            status: 'matched',
          },
        ],
        revenueByCountry: {
          Switzerland: 15,
        },
      },
    },
  ],
  tree: [
    {
      name: 'a single node',
      description: 'JSONata returns a single item without the array brackets.',
      input: {
        root: {
          id: 1,
          name: 'Solo',
        },
      },
      expected: {
        nodes: 1,
        maxDepth: 1,
        leafPaths: 'Solo',
        perDepth: {
          '1': 1,
        },
        'allIds (using **)': 1,
      },
    },
  ],
  timeseries: [
    {
      name: 'one event',
      input: {
        events: [
          {
            ts: '2026-10-19T08:15:00Z',
            level: 'INFO',
            ms: 120,
          },
        ],
      },
      expected: {
        perDay: {
          '2026-10-19': {
            events: 1,
            errors: 0,
            errorRate: '0 %',
            avgMs: 120,
            slowest: 120,
            busiestHour: 8,
          },
        },
        timeline: [
          {
            day: '2026-10-19',
            weekday: 'Monday',
            cumulativeErrors: 0,
          },
        ],
      },
    },
  ],
  cleansing: [
    {
      name: 'one clean record is normalized',
      input: {
        records: [
          {
            name: '  dave  ',
            email: 'Dave@Example.com ',
            phone: '0041 79 111 22 33',
            age: '41',
          },
        ],
      },
      expected: {
        valid: [
          {
            name: 'Dave',
            email: 'dave@example.com',
            phone: '+41791112233',
            age: 41,
            issues: [],
          },
        ],
        duplicatesRemoved: 0,
      },
    },
  ],
  error: [
    {
      name: 'fixed input: label is a number',
      input: {
        price: 10,
        qty: 3,
        label: 4,
      },
      expected: 34,
    },
  ],
};

/** Outcome of each demo on its own data. */
const OWN: Record<string, Pick<TestCase, 'expected' | 'expectError'>> = {
  hello: { expected: 'Hello, World!' },
  paths: {
    expected: {
      customer: 'Alice Example',
      orderCount: 2,
      revenue: 531.9,
      bigItems: ['Monitor', 'Keyboard'],
      openOrders: 'A-1001',
    },
  },
  reshape: {
    expected: [
      {
        id: 'A-1001',
        status: 'OPEN',
        lines: 2,
        total: 443,
      },
      {
        id: 'A-1002',
        status: 'SHIPPED',
        lines: 2,
        total: 88.9,
      },
    ],
  },
  group: {
    expected: {
      Engineering: {
        headcount: 2,
        avgSalary: 115000,
        people: 'Ada, Linus',
      },
      Research: {
        headcount: 2,
        avgSalary: 127500,
        people: 'Grace, Alan',
      },
      Operations: {
        headcount: 1,
        avgSalary: 90000,
        people: 'Margaret',
      },
    },
  },
  hof: {
    expected: {
      squares: [25, 9, 64, 1, 81, 4],
      evens: [8, 2],
      sum: 28,
      sortedDesc: [9, 8, 5, 3, 2, 1],
    },
  },
  strings: {
    expected: {
      user: 'jane.doe',
      domain: 'example.com',
      level: 'ERROR',
      message: 'disk full',
      day: 'Monday, 19th October 2026',
    },
  },
  functions: {
    expected: {
      n: 6,
      factorial: 720,
      fibonacci: [0, 1, 1, 2, 3, 5, 8],
    },
  },
  analytics: {
    expected: {
      currency: 'EUR',
      totalRevenue: 498.43,
      ranking: [
        {
          customer: 'Globex',
          orders: 2,
          revenue: 265.96,
          rank: 1,
          tier: 'gold',
        },
        {
          customer: 'Acme',
          orders: 2,
          revenue: 212.48,
          rank: 2,
          tier: 'gold',
        },
        {
          customer: 'Initech',
          orders: 1,
          revenue: 19.99,
          rank: 3,
          tier: 'standard',
        },
      ],
      bestSeller: {
        product: 'Widget',
        units: 55,
      },
    },
  },
  join: {
    expected: {
      joined: [
        {
          order: 'O-1',
          total: 120,
          customer: 'Acme AG',
          country: 'Switzerland',
          status: 'matched',
        },
        {
          order: 'O-2',
          total: 80.5,
          customer: 'Globex GmbH',
          country: 'Germany',
          status: 'matched',
        },
        {
          order: 'O-3',
          total: 50,
          customer: '(unknown customer)',
          country: null,
          status: 'orphan',
        },
        {
          order: 'O-4',
          total: 30,
          customer: 'Acme AG',
          country: 'Switzerland',
          status: 'matched',
        },
        {
          order: 'O-5',
          total: 220,
          customer: 'Initech SA',
          country: 'Switzerland',
          status: 'matched',
        },
      ],
      orphans: ['O-3'],
      revenueByCountry: {
        Switzerland: 370,
        Germany: 80.5,
      },
    },
  },
  tree: {
    expected: {
      nodes: 8,
      maxDepth: 4,
      leafPaths: [
        'Store > Clothing > Shoes > Sneakers',
        'Store > Clothing > Shoes > Boots',
        'Store > Clothing > Shirts',
        'Store > Electronics > Phones',
      ],
      perDepth: {
        '1': 1,
        '2': 2,
        '3': 3,
        '4': 2,
      },
      'allIds (using **)': [1, 2, 4, 7, 8, 5, 3, 6],
    },
  },
  timeseries: {
    expected: {
      perDay: {
        '2026-10-19': {
          events: 4,
          errors: 1,
          errorRate: '25 %',
          avgMs: 311.2,
          slowest: 950,
          busiestHour: 8,
        },
        '2026-10-20': {
          events: 3,
          errors: 2,
          errorRate: '66.7 %',
          avgMs: 703.3,
          slowest: 1200,
          busiestHour: 13,
        },
        '2026-10-21': {
          events: 2,
          errors: 0,
          errorRate: '0 %',
          avgMs: 67.5,
          slowest: 95,
          busiestHour: 7,
        },
      },
      timeline: [
        {
          day: '2026-10-19',
          weekday: 'Monday',
          cumulativeErrors: 1,
        },
        {
          day: '2026-10-20',
          weekday: 'Tuesday',
          cumulativeErrors: 3,
        },
        {
          day: '2026-10-21',
          weekday: 'Wednesday',
          cumulativeErrors: 3,
        },
      ],
    },
  },
  cleansing: {
    expected: {
      valid: [
        {
          name: 'Alice Smith',
          email: 'alice@example.com',
          phone: '+41791234567',
          age: 34,
          issues: [],
        },
        {
          name: 'Carla',
          email: 'carla@example.org',
          phone: '+41445556677',
          age: 29,
          issues: [],
        },
      ],
      needsReview: [
        {
          name: 'Bob Jones',
          email: 'bob.jones@@example.com',
          phone: '+41795551212',
          age: null,
          issues: ['invalid email', 'age is not a number'],
        },
      ],
      duplicatesRemoved: 1,
    },
  },
  error: { expectError: 'T2002' },
};

export function testsForDemo(d: Demo): TestCase[] {
  const own = OWN[d.id];
  const first: TestCase = { name: d.expectError ? 'demo data fails with the expected error' : 'demo data', input: d.input, ...own };
  return [first, ...(EXTRA[d.id] ?? [])];
}
