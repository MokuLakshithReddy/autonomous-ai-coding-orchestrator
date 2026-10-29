import path from 'node:path';
import fs from 'node:fs/promises';
import type { BenchmarkTaskDefinition } from './types.js';

export const tsBenchmarkTasks: BenchmarkTaskDefinition[] = [
  // 1. ts-syntax-01: Unterminated string & syntax bug
  {
    id: 'ts-syntax-01',
    title: 'Syntax Error in ID Token Generator',
    description: 'Diagnose and fix syntax error (unterminated template literal and missing bracket) in generator.',
    language: 'javascript',
    category: 'syntax',
    difficulty: 'easy',
    prompt: 'Fix the syntax error in generator.js so that the test suite passes cleanly.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'node test.js',
    acceptanceCriteria: [
      'generator.js contains valid syntax',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'ts-syntax-01', type: 'module', scripts: { test: 'node test.js' } }, null, 2),
      },
      {
        path: 'generator.js',
        content: `export function generateToken(user, expMinutes) {
  const payload = \`usr_\${user.id}_\${Date.now()};
  return { token: payload, expires: expMinutes * 60;
}
`,
      },
      {
        path: 'test.js',
        content: `import assert from 'node:assert';
import { generateToken } from './generator.js';

const res = generateToken({ id: '42' }, 15);
assert.ok(res.token.startsWith('usr_42_'), 'Token format invalid');
assert.strictEqual(res.expires, 900, 'Expiration calculation incorrect');
console.log('✓ Token generator verified');
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'generator.js'),
        `export function generateToken(user, expMinutes) {
  const payload = \`usr_\${user.id}_\${Date.now()}\`;
  return { token: payload, expires: expMinutes * 60 };
}
`
      );
      return { filesWritten: ['generator.js'], log: 'Fixed syntax error in generator.js' };
    },
  },

  // 2. ts-logic-02: Pagination off-by-one bug
  {
    id: 'ts-logic-02',
    title: 'Off-By-One Boundary Bug in Pagination',
    description: 'Fix page slicing calculation that drops the boundary element on each page.',
    language: 'javascript',
    category: 'logic',
    difficulty: 'medium',
    prompt: 'Fix pagination calculation in pagination.js so that all items are correctly returned without dropping boundary items.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'node test.js',
    acceptanceCriteria: [
      'paginateItems handles boundary elements without loss',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'ts-logic-02', type: 'module', scripts: { test: 'node test.js' } }, null, 2),
      },
      {
        path: 'pagination.js',
        content: `export function paginateItems(items, page, pageSize) {
  const start = page * pageSize;
  const end = (page + 1) * pageSize - 1; // Off-by-one: slice end index is non-inclusive!
  return {
    items: items.slice(start, end),
    total: items.length,
    page,
    totalPages: Math.ceil(items.length / pageSize),
  };
}
`,
      },
      {
        path: 'test.js',
        content: `import assert from 'node:assert';
import { paginateItems } from './pagination.js';

const all = Array.from({ length: 15 }, (_, i) => i + 1);
const page0 = paginateItems(all, 0, 5);
assert.strictEqual(page0.items.length, 5, 'Page 0 must have exactly 5 elements');
assert.deepStrictEqual(page0.items, [1, 2, 3, 4, 5], 'Page 0 items mismatch');

const page1 = paginateItems(all, 1, 5);
assert.strictEqual(page1.items.length, 5, 'Page 1 must have exactly 5 elements');
assert.deepStrictEqual(page1.items, [6, 7, 8, 9, 10], 'Page 1 items mismatch');
console.log('✓ Pagination logic verified');
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'pagination.js'),
        `export function paginateItems(items, page, pageSize) {
  const start = page * pageSize;
  const end = (page + 1) * pageSize;
  return {
    items: items.slice(start, end),
    total: items.length,
    page,
    totalPages: Math.ceil(items.length / pageSize),
  };
}
`
      );
      return { filesWritten: ['pagination.js'], log: 'Corrected slice end boundary index' };
    },
  },

  // 3. ts-async-03: Missing await in async read-through cache
  {
    id: 'ts-async-03',
    title: 'Async Race Condition in Cache Read-Through',
    description: 'Ensure cache read-through properly awaits async fetchers before caching value.',
    language: 'javascript',
    category: 'logic',
    difficulty: 'medium',
    prompt: 'Fix the async cache in cache.js so that fetcher promises are awaited before storing and returning values.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'node test.js',
    acceptanceCriteria: [
      'Cached values are resolved objects rather than unresolved promises',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'ts-async-03', type: 'module', scripts: { test: 'node test.js' } }, null, 2),
      },
      {
        path: 'cache.js',
        content: `export class AsyncCache {
  constructor() {
    this.store = new Map();
  }
  async getOrFetch(key, fetcher) {
    if (this.store.has(key)) {
      return this.store.get(key);
    }
    // Bug: Missing await on fetcher call stores Promise instead of resolved value
    const val = fetcher(key);
    this.store.set(key, val);
    return val;
  }
}
`,
      },
      {
        path: 'test.js',
        content: `import assert from 'node:assert';
import { AsyncCache } from './cache.js';

const cache = new AsyncCache();
const val1 = await cache.getOrFetch('user:1', async (id) => {
  return { id, name: 'Alice' };
});

assert.ok(!(val1 instanceof Promise), 'Returned value must not be a Promise');
assert.strictEqual(val1.name, 'Alice', 'Returned object name mismatch');

const valCached = await cache.getOrFetch('user:1', async () => {
  throw new Error('Should have hit cache');
});
assert.strictEqual(valCached.name, 'Alice', 'Cached value mismatch');
console.log('✓ Async cache read-through verified');
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'cache.js'),
        `export class AsyncCache {
  constructor() {
    this.store = new Map();
  }
  async getOrFetch(key, fetcher) {
    if (this.store.has(key)) {
      return this.store.get(key);
    }
    const val = await fetcher(key);
    this.store.set(key, val);
    return val;
  }
}
`
      );
      return { filesWritten: ['cache.js'], log: 'Awaited fetcher call before caching' };
    },
  },

  // 4. ts-contract-04: Multi-file schema drift between service and controller
  {
    id: 'ts-contract-04',
    title: 'Multi-File Interface Schema Drift in Auth Controller',
    description: 'Coordinate parameter renaming across auth-service.js and user-controller.js.',
    language: 'javascript',
    category: 'multi-file',
    difficulty: 'medium',
    prompt: 'Fix the contract mismatch between auth-service.js and user-controller.js so login succeeds.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'node test.js',
    acceptanceCriteria: [
      'auth-service and user-controller share compatible parameter interface',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'ts-contract-04', type: 'module', scripts: { test: 'node test.js' } }, null, 2),
      },
      {
        path: 'auth-service.js',
        content: `export function authenticateUser(credentials) {
  // Service was updated to expect username and passwordHash
  const { username, passwordHash } = credentials;
  if (!username || !passwordHash) {
    return { success: false, error: 'Missing username or passwordHash' };
  }
  return { success: true, session: \`sess_\${username}\` };
}
`,
      },
      {
        path: 'user-controller.js',
        content: `import { authenticateUser } from './auth-service.js';

export function handleLogin(email, hash) {
  // Bug: Controller still sends userEmail and hash
  return authenticateUser({ userEmail: email, hash });
}
`,
      },
      {
        path: 'test.js',
        content: `import assert from 'node:assert';
import { handleLogin } from './user-controller.js';

const res = handleLogin('alice@corp.local', 'sha256_mock_hash');
assert.strictEqual(res.success, true, \`Login failed: \${res.error}\`);
assert.strictEqual(res.session, 'sess_alice@corp.local');
console.log('✓ Multi-file auth contract verified');
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'user-controller.js'),
        `import { authenticateUser } from './auth-service.js';

export function handleLogin(email, hash) {
  return authenticateUser({ username: email, passwordHash: hash });
}
`
      );
      return { filesWritten: ['user-controller.js'], log: 'Aligned user-controller credentials with auth-service schema' };
    },
  },

  // 5. ts-regression-05: Pricing discount broke tax calculation
  {
    id: 'ts-regression-05',
    title: 'Regression in Order Total Tax Calculation',
    description: 'Ensure coupon discounts correctly compute subtotal without dropping mandatory regional taxes.',
    language: 'javascript',
    category: 'regression',
    difficulty: 'medium',
    prompt: 'Fix pricing.js so that coupon discounts are applied correctly while preserving regional tax computation.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'node test.js',
    acceptanceCriteria: [
      'Coupon discounts reduce subtotal before tax computation',
      'Taxes are computed accurately and not zeroed out',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'ts-regression-05', type: 'module', scripts: { test: 'node test.js' } }, null, 2),
      },
      {
        path: 'pricing.js',
        content: `export function calculateOrderTotal(subtotal, taxRate, couponCode) {
  let discount = 0;
  if (couponCode === 'SAVE20') {
    discount = subtotal * 0.20;
    // Regression: Developer inadvertently zeroed taxRate when coupon applied
    taxRate = 0;
  }
  const discountedSubtotal = Math.max(0, subtotal - discount);
  const tax = discountedSubtotal * taxRate;
  return {
    subtotal: discountedSubtotal,
    tax,
    total: discountedSubtotal + tax,
  };
}
`,
      },
      {
        path: 'test.js',
        content: `import assert from 'node:assert';
import { calculateOrderTotal } from './pricing.js';

// Case 1: Standard order without coupon
const res1 = calculateOrderTotal(100, 0.10, null);
assert.strictEqual(res1.subtotal, 100);
assert.strictEqual(res1.tax, 10);
assert.strictEqual(res1.total, 110);

// Case 2: Discounted order with coupon - tax must still apply!
const res2 = calculateOrderTotal(100, 0.10, 'SAVE20');
assert.strictEqual(res2.subtotal, 80);
assert.strictEqual(res2.tax, 8, 'Tax must be 10% of discounted subtotal ($8), not 0');
assert.strictEqual(res2.total, 88);
console.log('✓ Pricing regression verified');
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'pricing.js'),
        `export function calculateOrderTotal(subtotal, taxRate, couponCode) {
  let discount = 0;
  if (couponCode === 'SAVE20') {
    discount = subtotal * 0.20;
  }
  const discountedSubtotal = Math.max(0, subtotal - discount);
  const tax = discountedSubtotal * taxRate;
  return {
    subtotal: discountedSubtotal,
    tax,
    total: discountedSubtotal + tax,
  };
}
`
      );
      return { filesWritten: ['pricing.js'], log: 'Preserved regional taxRate calculation when discount applied' };
    },
  },

  // 6. ts-dependency-06: Missing re-export in barrel index
  {
    id: 'ts-dependency-06',
    title: 'Missing Re-export in Module Index',
    description: 'Fix module export name in math/index.js to re-export add instead of deprecated sum function.',
    language: 'javascript',
    category: 'dependency',
    difficulty: 'easy',
    prompt: 'Fix math/index.js to export the add function from core.js.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'node test.js',
    acceptanceCriteria: [
      'math/index.js exports add function',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'ts-dependency-06', type: 'module', scripts: { test: 'node test.js' } }, null, 2),
      },
      {
        path: 'math/core.js',
        content: `export function add(a, b) {
  return a + b;
}
`,
      },
      {
        path: 'math/index.js',
        content: `// Bug: Exports sum instead of add
export { sum } from './core.js';
`,
      },
      {
        path: 'test.js',
        content: `import assert from 'node:assert';
import { add } from './math/index.js';

assert.strictEqual(typeof add, 'function', 'add must be exported from ./math/index.js');
assert.strictEqual(add(2, 3), 5);
console.log('✓ Module barrel export verified');
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'math/index.js'),
        `export { add } from './core.js';\n`
      );
      return { filesWritten: ['math/index.js'], log: 'Updated math/index.js to re-export add' };
    },
  },

  // 7. ts-null-07: Unhandled null/undefined dereference
  {
    id: 'ts-null-07',
    title: 'Unhandled Null Dereference in User Profile Parser',
    description: 'Add optional chaining and safe defaulting for nested user preferences.',
    language: 'javascript',
    category: 'logic',
    difficulty: 'easy',
    prompt: 'Fix profile.js so that users without preferences do not trigger runtime TypeError exceptions.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'node test.js',
    acceptanceCriteria: [
      'getUserNotificationEmail handles null or missing preferences gracefully',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'ts-null-07', type: 'module', scripts: { test: 'node test.js' } }, null, 2),
      },
      {
        path: 'profile.js',
        content: `export function getUserNotificationEmail(user) {
  // Bug: Throws when preferences or notifications is null/undefined
  return user.preferences.notifications.email || user.defaultEmail;
}
`,
      },
      {
        path: 'test.js',
        content: `import assert from 'node:assert';
import { getUserNotificationEmail } from './profile.js';

const fullUser = { preferences: { notifications: { email: 'pref@corp.com' } }, defaultEmail: 'def@corp.com' };
assert.strictEqual(getUserNotificationEmail(fullUser), 'pref@corp.com');

const sparseUser = { preferences: null, defaultEmail: 'def@corp.com' };
assert.strictEqual(getUserNotificationEmail(sparseUser), 'def@corp.com');

const emptyUser = { defaultEmail: 'def@corp.com' };
assert.strictEqual(getUserNotificationEmail(emptyUser), 'def@corp.com');
console.log('✓ Null dereference protection verified');
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'profile.js'),
        `export function getUserNotificationEmail(user) {
  return user?.preferences?.notifications?.email || user?.defaultEmail || null;
}
`
      );
      return { filesWritten: ['profile.js'], log: 'Added optional chaining and null fallbacks' };
    },
  },

  // 8. ts-repair-08: Multi-step repair requiring two iterations
  {
    id: 'ts-repair-08',
    title: 'Multi-Step Coordinated Parser & Envelope Repair',
    description: 'Requires fixing string splitting first, then resolving the returned response envelope.',
    language: 'javascript',
    category: 'multi-step',
    difficulty: 'hard',
    prompt: 'Fix parseConfig in parser.js to properly split KEY=VAL lines and return an envelope { status: "OK", config: { ... } }.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'node test.js',
    acceptanceCriteria: [
      'parseConfig parses KEY=VAL string pairs cleanly',
      'Return format matches { status: "OK", config: ... }',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'ts-repair-08', type: 'module', scripts: { test: 'node test.js' } }, null, 2),
      },
      {
        path: 'parser.js',
        content: `export function parseConfig(content) {
  // Flawed initial implementation: splits on space instead of newline, returns raw dict
  const lines = content.split(' ');
  const res = {};
  for (const line of lines) {
    const [k, v] = line.split(':');
    if (k && v) res[k] = v;
  }
  return res;
}
`,
      },
      {
        path: 'test.js',
        content: `import assert from 'node:assert';
import { parseConfig } from './parser.js';

const raw = "HOST=127.0.0.1\\nPORT=8080\\nNAME=Orchestrator";
const out = parseConfig(raw);

assert.strictEqual(out.status, 'OK', 'Envelope status must be OK');
assert.strictEqual(out.config.HOST, '127.0.0.1');
assert.strictEqual(out.config.PORT, '8080');
assert.strictEqual(out.config.NAME, 'Orchestrator');
console.log('✓ Multi-step config parser verified');
`,
      },
    ],
    deterministicFix: async (targetDir: string, attempt: number) => {
      if (attempt === 1) {
        // Step 1: Fix splitting logic, but forget envelope
        await fs.writeFile(
          path.join(targetDir, 'parser.js'),
          `export function parseConfig(content) {
  const lines = content.split('\\n');
  const config = {};
  for (const line of lines) {
    const [k, v] = line.split('=');
    if (k && v) config[k.trim()] = v.trim();
  }
  return { config }; // missing status: 'OK'
}
`
        );
        return { filesWritten: ['parser.js'], log: 'Partial fix: fixed line splitting' };
      }
      // Step 2 (Corrective Repair): Fix envelope status: 'OK'
      await fs.writeFile(
        path.join(targetDir, 'parser.js'),
        `export function parseConfig(content) {
  const lines = content.split('\\n');
  const config = {};
  for (const line of lines) {
    const [k, v] = line.split('=');
    if (k && v) config[k.trim()] = v.trim();
  }
  return { status: 'OK', config };
}
`
      );
      return { filesWritten: ['parser.js'], log: 'Complete fix: added envelope status: OK' };
    },
  },

  // 9. ts-algo-09: LRU Cache Eviction Bug
  {
    id: 'ts-algo-09',
    title: 'LRU Cache Eviction Ordering Bug',
    description: 'Ensure cache evicts the least recently used element instead of the newest.',
    language: 'javascript',
    category: 'logic',
    difficulty: 'medium',
    prompt: 'Fix LRUCache in lru.js so accessed items are moved to the most recent position and evict oldest.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'node test.js',
    acceptanceCriteria: [
      'LRUCache respects access order and evicts least recently accessed element',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'ts-algo-09', type: 'module', scripts: { test: 'node test.js' } }, null, 2),
      },
      {
        path: 'lru.js',
        content: `export class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return null;
    const val = this.map.get(key);
    // Bug: Did not refresh key position in map on get()!
    return val;
  }
  put(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }
}
`,
      },
      {
        path: 'test.js',
        content: `import assert from 'node:assert';
import { LRUCache } from './lru.js';

const cache = new LRUCache(2);
cache.put('a', 1);
cache.put('b', 2);
assert.strictEqual(cache.get('a'), 1); // 'a' accessed, so 'b' is now least recently used

cache.put('c', 3); // must evict 'b', keeping 'a' and 'c'
assert.strictEqual(cache.get('b'), null, 'Key b must be evicted');
assert.strictEqual(cache.get('a'), 1, 'Key a must still exist');
assert.strictEqual(cache.get('c'), 3, 'Key c must exist');
console.log('✓ LRU eviction ordering verified');
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'lru.js'),
        `export class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return null;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }
  put(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }
}
`
      );
      return { filesWritten: ['lru.js'], log: 'Refreshed access order in Map on get()' };
    },
  },

  // 10. ts-state-10: State Machine Invalid Transition Bug
  {
    id: 'ts-state-10',
    title: 'Order State Machine Transition Validation',
    description: 'Enforce transition rules so cancelled orders cannot transition to shipped.',
    language: 'javascript',
    category: 'logic',
    difficulty: 'easy',
    prompt: 'Fix payment state transitions in order-state.js so invalid transitions throw an Error.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'node test.js',
    acceptanceCriteria: [
      'Invalid transitions are rejected with an Error',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'ts-state-10', type: 'module', scripts: { test: 'node test.js' } }, null, 2),
      },
      {
        path: 'order-state.js',
        content: `export class OrderWorkflow {
  constructor() {
    this.state = 'CREATED';
    this.allowed = {
      CREATED: ['PROCESSING', 'CANCELLED'],
      PROCESSING: ['SHIPPED', 'CANCELLED'],
      SHIPPED: ['DELIVERED'],
      CANCELLED: ['SHIPPED'], // Bug: Cancelled orders must never be allowed to transition to SHIPPED!
      DELIVERED: [],
    };
  }
  transitionTo(next) {
    if (!this.allowed[this.state]?.includes(next)) {
      throw new Error(\`Invalid transition from \${this.state} to \${next}\`);
    }
    this.state = next;
    return this.state;
  }
}
`,
      },
      {
        path: 'test.js',
        content: `import assert from 'node:assert';
import { OrderWorkflow } from './order-state.js';

const flow = new OrderWorkflow();
flow.transitionTo('CANCELLED');
assert.throws(
  () => flow.transitionTo('SHIPPED'),
  /Invalid transition/,
  'Cancelled order must not transition to SHIPPED'
);
console.log('✓ Order state machine verified');
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'order-state.js'),
        `export class OrderWorkflow {
  constructor() {
    this.state = 'CREATED';
    this.allowed = {
      CREATED: ['PROCESSING', 'CANCELLED'],
      PROCESSING: ['SHIPPED', 'CANCELLED'],
      SHIPPED: ['DELIVERED'],
      CANCELLED: [],
      DELIVERED: [],
    };
  }
  transitionTo(next) {
    if (!this.allowed[this.state]?.includes(next)) {
      throw new Error(\`Invalid transition from \${this.state} to \${next}\`);
    }
    this.state = next;
    return this.state;
  }
}
`
      );
      return { filesWritten: ['order-state.js'], log: 'Disallowed invalid transition from CANCELLED to SHIPPED' };
    },
  },

  // 11. ts-exhaustion-11: Unfulfillable task testing truthful failure
  {
    id: 'ts-exhaustion-11',
    title: 'Unfulfillable Task Truthful Failure Verification',
    description: 'Ensure system truthfully reports FAILED when requirements are mathematically or logically impossible.',
    language: 'javascript',
    category: 'multi-step',
    difficulty: 'hard',
    prompt: 'Implement a function in paradox.js that returns a string that is simultaneously of length 5 and length 10.',
    isUnsafe: false,
    expectedOutcome: 'failed',
    testCommand: 'node test.js',
    acceptanceCriteria: [
      'Impossible criteria must fail verification',
    ],
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'ts-exhaustion-11', type: 'module', scripts: { test: 'node test.js' } }, null, 2),
      },
      {
        path: 'paradox.js',
        content: `export function getParadox() {
  return "hello"; // length is 5, fails 10
}
`,
      },
      {
        path: 'test.js',
        content: `import assert from 'node:assert';
import { getParadox } from './paradox.js';

const s = getParadox();
assert.strictEqual(s.length, 5);
assert.strictEqual(s.length, 10, 'Paradox failed: length cannot be both 5 and 10');
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      // Simulates an agent that tries but cannot solve impossible requirements
      return { filesWritten: [], log: 'Cannot satisfy contradictory constraints' };
    },
  },
];

