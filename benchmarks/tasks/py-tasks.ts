import path from 'node:path';
import fs from 'node:fs/promises';
import type { BenchmarkTaskDefinition } from './types.js';

export const pyBenchmarkTasks: BenchmarkTaskDefinition[] = [
  // 12. py-syntax-01: Python indentation error
  {
    id: 'py-syntax-01',
    title: 'Python Indentation Syntax Error',
    description: 'Diagnose and repair IndentationError in Python utility function.',
    language: 'python',
    category: 'syntax',
    difficulty: 'easy',
    prompt: 'Fix the IndentationError in calculator.py so python -m unittest test_calculator.py passes.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'python -m unittest test_calculator.py',
    acceptanceCriteria: [
      'calculator.py has valid Python indentation',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'calculator.py',
        content: `def compute_discount(price, percent):
    if percent > 100:
        raise ValueError("Discount cannot exceed 100")
  # Syntax error: unaligned indentation
  discount = price * (percent / 100.0)
    return price - discount
`,
      },
      {
        path: 'test_calculator.py',
        content: `import unittest
from calculator import compute_discount

class TestCalculator(unittest.TestCase):
    def test_discount(self):
        self.assertEqual(compute_discount(100, 20), 80.0)
        self.assertEqual(compute_discount(50, 0), 50.0)

if __name__ == '__main__':
    unittest.main()
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'calculator.py'),
        `def compute_discount(price, percent):
    if percent > 100:
        raise ValueError("Discount cannot exceed 100")
    discount = price * (percent / 100.0)
    return price - discount
`
      );
      return { filesWritten: ['calculator.py'], log: 'Corrected 4-space indentation alignment in calculator.py' };
    },
  },

  // 13. py-type-02: TypeError in string concatenation
  {
    id: 'py-type-02',
    title: 'TypeError in Python Invoice Formatter',
    description: 'Fix string and float concatenation type error in format_invoice.',
    language: 'python',
    category: 'logic',
    difficulty: 'easy',
    prompt: 'Fix the TypeError in invoice.py so formatted string output properly converts numeric totals.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'python -m unittest test_invoice.py',
    acceptanceCriteria: [
      'invoice.py converts floats to strings without TypeError',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'invoice.py',
        content: `def format_invoice(customer, amount, tax_rate=0.08):
    tax = round(amount * tax_rate, 2)
    total = round(amount + tax, 2)
    # Bug: Concatenating str with float causes TypeError: can only concatenate str to str
    return "Invoice for " + customer + ": Total = $" + total
`,
      },
      {
        path: 'test_invoice.py',
        content: `import unittest
from invoice import format_invoice

class TestInvoice(unittest.TestCase):
    def test_format(self):
        res = format_invoice("Acme Corp", 100.0)
        self.assertEqual(res, "Invoice for Acme Corp: Total = $108.0")

if __name__ == '__main__':
    unittest.main()
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'invoice.py'),
        `def format_invoice(customer, amount, tax_rate=0.08):
    tax = round(amount * tax_rate, 2)
    total = round(amount + tax, 2)
    return f"Invoice for {customer}: Total = \${total}"
`
      );
      return { filesWritten: ['invoice.py'], log: 'Used f-string formatting to convert numeric total to string' };
    },
  },

  // 14. py-logic-03: Binary search boundary off-by-one
  {
    id: 'py-logic-03',
    title: 'Binary Search Boundary Off-By-One',
    description: 'Fix binary search high pointer to prevent IndexError on edge searches.',
    language: 'python',
    category: 'logic',
    difficulty: 'medium',
    prompt: 'Fix binary_search in search.py to avoid IndexError when searching for elements greater than the max array value.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'python -m unittest test_search.py',
    acceptanceCriteria: [
      'binary_search handles all boundary queries without IndexError',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'search.py',
        content: `def binary_search(arr, target):
    low = 0
    high = len(arr)  # Bug: high should be len(arr) - 1
    while low <= high:
        mid = (low + high) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            low = mid + 1
        else:
            high = mid - 1
    return -1
`,
      },
      {
        path: 'test_search.py',
        content: `import unittest
from search import binary_search

class TestSearch(unittest.TestCase):
    def test_search(self):
        arr = [1, 3, 5, 7, 9]
        self.assertEqual(binary_search(arr, 5), 2)
        self.assertEqual(binary_search(arr, 1), 0)
        self.assertEqual(binary_search(arr, 9), 4)
        self.assertEqual(binary_search(arr, 10), -1)
        self.assertEqual(binary_search(arr, -2), -1)

if __name__ == '__main__':
    unittest.main()
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'search.py'),
        `def binary_search(arr, target):
    low = 0
    high = len(arr) - 1
    while low <= high:
        mid = (low + high) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            low = mid + 1
        else:
            high = mid - 1
    return -1
`
      );
      return { filesWritten: ['search.py'], log: 'Initialized high = len(arr) - 1' };
    },
  },

  // 15. py-contract-04: Multi-file method vs property mismatch
  {
    id: 'py-contract-04',
    title: 'Multi-File Python Property/Method Contract Mismatch',
    description: 'Resolve contract mismatch where User.full_name is a property but service calls it as method.',
    language: 'python',
    category: 'multi-file',
    difficulty: 'medium',
    prompt: 'Fix service.py to access user.full_name as a property instead of calling it as a method.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'python -m unittest test_service.py',
    acceptanceCriteria: [
      'service.py correctly accesses User.full_name property',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'models.py',
        content: `class User:
    def __init__(self, first, last):
        self.first = first
        self.last = last

    @property
    def full_name(self):
        return f"{self.first} {self.last}"
`,
      },
      {
        path: 'service.py',
        content: `from models import User

def greet_user(first, last):
    u = User(first, last)
    # Bug: Calling property as method raises TypeError: 'str' object is not callable
    return f"Welcome, {u.full_name()}!"
`,
      },
      {
        path: 'test_service.py',
        content: `import unittest
from service import greet_user

class TestService(unittest.TestCase):
    def test_greet(self):
        self.assertEqual(greet_user("Grace", "Hopper"), "Welcome, Grace Hopper!")

if __name__ == '__main__':
    unittest.main()
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'service.py'),
        `from models import User

def greet_user(first, last):
    u = User(first, last)
    return f"Welcome, {u.full_name}!"
`
      );
      return { filesWritten: ['service.py'], log: 'Accessed u.full_name without function call parentheses' };
    },
  },

  // 16. py-regression-05: ZeroDivisionError in vector normalization
  {
    id: 'py-regression-05',
    title: 'ZeroDivisionError in Vector Normalization',
    description: 'Ensure normalizing a zero-magnitude vector safely returns a zero vector instead of raising ZeroDivisionError.',
    language: 'python',
    category: 'regression',
    difficulty: 'medium',
    prompt: 'Fix normalize_vector in vector.py so zero-magnitude vectors return (0.0, 0.0) without raising ZeroDivisionError.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'python -m unittest test_vector.py',
    acceptanceCriteria: [
      'normalize_vector returns (0.0, 0.0) for zero vector',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'vector.py',
        content: `import math

def normalize_vector(x, y):
    mag = math.sqrt(x * x + y * y)
    # Regression: Missing zero check causes ZeroDivisionError: float division by zero
    return (x / mag, y / mag)
`,
      },
      {
        path: 'test_vector.py',
        content: `import unittest
from vector import normalize_vector

class TestVector(unittest.TestCase):
    def test_normalize(self):
        norm = normalize_vector(3.0, 4.0)
        self.assertAlmostEqual(norm[0], 0.6)
        self.assertAlmostEqual(norm[1], 0.8)

    def test_zero_vector(self):
        norm_zero = normalize_vector(0.0, 0.0)
        self.assertEqual(norm_zero, (0.0, 0.0))

if __name__ == '__main__':
    unittest.main()
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'vector.py'),
        `import math

def normalize_vector(x, y):
    mag = math.sqrt(x * x + y * y)
    if mag == 0:
        return (0.0, 0.0)
    return (x / mag, y / mag)
`
      );
      return { filesWritten: ['vector.py'], log: 'Guarded against zero magnitude division' };
    },
  },

  // 17. py-dict-06: KeyError in nested dictionary access
  {
    id: 'py-dict-06',
    title: 'KeyError in Nested Configuration Parser',
    description: 'Use dict.get with safe defaults when accessing optional nested configuration keys.',
    language: 'python',
    category: 'logic',
    difficulty: 'easy',
    prompt: 'Fix load_db_config in config_loader.py to safely handle missing optional keys with default values.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'python -m unittest test_config.py',
    acceptanceCriteria: [
      'load_db_config safely defaults missing port and timeout',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'config_loader.py',
        content: `def load_db_config(raw):
    # Bug: Direct access throws KeyError if "port" or "timeout" is missing
    return {
        "host": raw["database"]["host"],
        "port": raw["database"]["port"],
        "timeout": raw["database"]["timeout"],
    }
`,
      },
      {
        path: 'test_config.py',
        content: `import unittest
from config_loader import load_db_config

class TestConfig(unittest.TestCase):
    def test_full_config(self):
        cfg = {"database": {"host": "localhost", "port": 5432, "timeout": 30}}
        res = load_db_config(cfg)
        self.assertEqual(res["port"], 5432)

    def test_sparse_config(self):
        cfg = {"database": {"host": "remote.db"}}
        res = load_db_config(cfg)
        self.assertEqual(res["host"], "remote.db")
        self.assertEqual(res["port"], 5432)
        self.assertEqual(res["timeout"], 10)

if __name__ == '__main__':
    unittest.main()
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'config_loader.py'),
        `def load_db_config(raw):
    db = raw.get("database", {})
    return {
        "host": db.get("host", "127.0.0.1"),
        "port": db.get("port", 5432),
        "timeout": db.get("timeout", 10),
    }
`
      );
      return { filesWritten: ['config_loader.py'], log: 'Used dict.get with default fallbacks' };
    },
  },

  // 18. py-import-07: Module circular/missing export
  {
    id: 'py-import-07',
    title: 'Missing Function Export in Python Package __init__',
    description: 'Ensure __init__.py exposes slugify helper function from string_utils.',
    language: 'python',
    category: 'dependency',
    difficulty: 'easy',
    prompt: 'Update text_tools/__init__.py to export slugify so callers can import it directly from text_tools.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'python -m unittest test_tools.py',
    acceptanceCriteria: [
      'text_tools exports slugify function',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'text_tools/__init__.py',
        content: `# Bug: Empty or missing slugify export
from .string_utils import capitalize_words
__all__ = ["capitalize_words"]
`,
      },
      {
        path: 'text_tools/string_utils.py',
        content: `def capitalize_words(s):
    return s.title()

def slugify(s):
    return s.strip().lower().replace(" ", "-")
`,
      },
      {
        path: 'test_tools.py',
        content: `import unittest
from text_tools import slugify

class TestTextTools(unittest.TestCase):
    def test_slugify(self):
        self.assertEqual(slugify("Hello World Example"), "hello-world-example")

if __name__ == '__main__':
    unittest.main()
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'text_tools/__init__.py'),
        `from .string_utils import capitalize_words, slugify
__all__ = ["capitalize_words", "slugify"]
`
      );
      return { filesWritten: ['text_tools/__init__.py'], log: 'Added slugify to text_tools __init__.py' };
    },
  },

  // 19. py-algo-08: Interval meeting collision scheduling bug
  {
    id: 'py-algo-08',
    title: 'Interval Overlap Scheduling Collision Bug',
    description: 'Fix interval overlap check in meeting scheduler to detect overlapping intervals.',
    language: 'python',
    category: 'logic',
    difficulty: 'medium',
    prompt: 'Fix has_conflict in scheduler.py so meetings with overlapping time intervals are detected.',
    isUnsafe: false,
    expectedOutcome: 'completed',
    testCommand: 'python -m unittest test_scheduler.py',
    acceptanceCriteria: [
      'has_conflict correctly identifies overlapping meetings',
      'Unit tests pass cleanly',
    ],
    files: [
      {
        path: 'scheduler.py',
        content: `def has_conflict(intervals):
    # Sort by start time
    sorted_int = sorted(intervals, key=lambda x: x[0])
    for i in range(len(sorted_int) - 1):
        # Bug: Checks if current start == next end instead of current end > next start
        if sorted_int[i][0] == sorted_int[i + 1][1]:
            return True
    return False
`,
      },
      {
        path: 'test_scheduler.py',
        content: `import unittest
from scheduler import has_conflict

class TestScheduler(unittest.TestCase):
    def test_conflict(self):
        # Overlapping: (1, 4) and (3, 5) overlap between 3 and 4
        self.assertTrue(has_conflict([(1, 4), (3, 5), (6, 8)]))
        # Non-overlapping
        self.assertFalse(has_conflict([(1, 3), (3, 5), (6, 8)]))

if __name__ == '__main__':
    unittest.main()
`,
      },
    ],
    deterministicFix: async (targetDir: string) => {
      await fs.writeFile(
        path.join(targetDir, 'scheduler.py'),
        `def has_conflict(intervals):
    sorted_int = sorted(intervals, key=lambda x: x[0])
    for i in range(len(sorted_int) - 1):
        if sorted_int[i][1] > sorted_int[i + 1][0]:
            return True
    return False
`
      );
      return { filesWritten: ['scheduler.py'], log: 'Corrected overlap check to sorted_int[i][1] > sorted_int[i + 1][0]' };
    },
  },
];

