/** Reference data for the JSONata built-in function library (jsonata 2.x). */

export type Category =
  | 'string'
  | 'numeric'
  | 'aggregation'
  | 'boolean'
  | 'array'
  | 'object'
  | 'datetime'
  | 'higher-order';

export interface FnDoc {
  name: string; // without leading $
  signature: string; // e.g. $substring(str, start[, length])
  description: string;
  category: Category;
  url: string;
}

const PAGES: Record<Category, string> = {
  string: 'string-functions',
  numeric: 'numeric-functions',
  aggregation: 'aggregation-functions',
  boolean: 'boolean-functions',
  array: 'array-functions',
  object: 'object-functions',
  datetime: 'date-time',
  'higher-order': 'higher-order-functions'
};

export const DOCS_BASE = 'https://docs.jsonata.org';

// [name, params, description, category]
const RAW: Array<[string, string, string, Category]> = [
  // string
  ['string', 'arg[, prettify]', 'Casts the argument to a string. Objects/arrays are JSON-stringified (set prettify to true for indentation).', 'string'],
  ['length', 'str', 'Number of characters in the string.', 'string'],
  ['substring', 'str, start[, length]', 'Substring starting at the 0-based start position (negative counts from the end), optionally limited to length characters.', 'string'],
  ['substringBefore', 'str, chars', 'Part of str before the first occurrence of chars.', 'string'],
  ['substringAfter', 'str, chars', 'Part of str after the first occurrence of chars.', 'string'],
  ['uppercase', 'str', 'Converts the string to upper case.', 'string'],
  ['lowercase', 'str', 'Converts the string to lower case.', 'string'],
  ['trim', 'str', 'Trims whitespace and normalizes inner whitespace runs to a single space.', 'string'],
  ['pad', 'str, width[, char]', 'Pads str to |width| characters (right-pads if width is positive, left-pads if negative).', 'string'],
  ['contains', 'str, pattern', 'True if str contains the substring or matches the regex pattern.', 'string'],
  ['split', 'str[, separator][, limit]', 'Splits str into an array on a string or regex separator.', 'string'],
  ['join', 'array[, separator]', 'Concatenates an array of strings with an optional separator.', 'string'],
  ['match', 'str, pattern[, limit]', 'Applies a regex to str and returns an array of match objects (match, index, groups).', 'string'],
  ['replace', 'str, pattern, replacement[, limit]', 'Replaces occurrences of pattern (string or regex) with replacement (string or function).', 'string'],
  ['eval', 'expr[, context]', 'Parses and evaluates a JSONata expression string at runtime.', 'string'],
  ['base64encode', 'str', 'Encodes the string as Base64.', 'string'],
  ['base64decode', 'str', 'Decodes a Base64 string.', 'string'],
  ['encodeUrlComponent', 'str', 'Percent-encodes a URL component.', 'string'],
  ['encodeUrl', 'str', 'Percent-encodes a full URL.', 'string'],
  ['decodeUrlComponent', 'str', 'Decodes a percent-encoded URL component.', 'string'],
  ['decodeUrl', 'str', 'Decodes a percent-encoded URL.', 'string'],
  // numeric
  ['number', 'arg', 'Casts the argument (string, boolean) to a number.', 'numeric'],
  ['abs', 'number', 'Absolute value.', 'numeric'],
  ['floor', 'number', 'Largest integer not greater than the number.', 'numeric'],
  ['ceil', 'number', 'Smallest integer not less than the number.', 'numeric'],
  ['round', 'number[, precision]', 'Rounds half to even, optionally to a number of decimal places.', 'numeric'],
  ['power', 'base, exponent', 'base raised to the power of exponent.', 'numeric'],
  ['sqrt', 'number', 'Square root.', 'numeric'],
  ['random', '', 'Pseudo-random number 0 <= n < 1.', 'numeric'],
  ['formatNumber', 'number, picture[, options]', 'Formats a number using an XPath/XQuery decimal-format picture string.', 'numeric'],
  ['formatBase', 'number[, radix]', 'Formats a number in the given radix (default 10).', 'numeric'],
  ['formatInteger', 'number, picture', 'Formats an integer using a picture (e.g. "w" words, "I" roman, "001").', 'numeric'],
  ['parseInteger', 'str, picture', 'Parses a formatted integer string using a picture.', 'numeric'],
  // aggregation
  ['sum', 'array', 'Sum of an array of numbers.', 'aggregation'],
  ['max', 'array', 'Largest number in the array.', 'aggregation'],
  ['min', 'array', 'Smallest number in the array.', 'aggregation'],
  ['average', 'array', 'Mean of an array of numbers.', 'aggregation'],
  // boolean
  ['boolean', 'arg', 'Casts the argument to a boolean using JSONata truthiness rules.', 'boolean'],
  ['not', 'arg', 'Boolean negation of the (cast) argument.', 'boolean'],
  ['exists', 'arg', 'True if the argument evaluates to something (is not undefined).', 'boolean'],
  // array
  ['count', 'array', 'Number of items in the array (1 for a single value, 0 for undefined).', 'array'],
  ['append', 'array1, array2', 'Concatenates two arrays (non-arrays are wrapped).', 'array'],
  ['sort', 'array[, function]', 'Sorts an array; the optional comparator returns true if $l should come AFTER $r.', 'array'],
  ['reverse', 'array', 'Reverses the order of the array.', 'array'],
  ['shuffle', 'array', 'Randomly reorders the array.', 'array'],
  ['distinct', 'array', 'Removes duplicate values.', 'array'],
  ['zip', 'array1, ...', 'Convolves arrays into an array of arrays (stops at the shortest).', 'array'],
  // object
  ['keys', 'object', 'Array of the object\'s (unique) keys.', 'object'],
  ['lookup', 'object, key', 'Value of the given key (maps over arrays of objects).', 'object'],
  ['spread', 'object', 'Splits an object into an array of single-key objects.', 'object'],
  ['merge', 'array<object>', 'Merges an array of objects into one (later keys win).', 'object'],
  ['sift', 'object[, function]', 'Keeps the object entries for which the function returns true.', 'object'],
  ['each', 'object, function', 'Applies a function(value, key) to each entry and returns an array of the results.', 'object'],
  ['error', '[message]', 'Throws an error with the given message.', 'object'],
  ['assert', 'condition, message', 'Throws an error with message when condition is false.', 'object'],
  ['type', 'value', 'Type name of the value: "null", "number", "string", "boolean", "array", "object", "function" or undefined.', 'object'],
  // date/time
  ['now', '[picture[, timezone]]', 'Current timestamp as an ISO 8601 string (or formatted by picture).', 'datetime'],
  ['millis', '', 'Current time in milliseconds since the Unix epoch.', 'datetime'],
  ['toMillis', 'timestamp[, picture]', 'Converts an ISO 8601 timestamp (or one matching picture) to milliseconds since the epoch.', 'datetime'],
  ['fromMillis', 'number[, picture[, timezone]]', 'Converts epoch milliseconds to an ISO 8601 string or a custom picture such as "[Y0001]-[M01]-[D01]".', 'datetime'],
  // higher-order
  ['map', 'array, function', 'Applies function(value, index, array) to each item and returns the results.', 'higher-order'],
  ['filter', 'array, function', 'Keeps the items for which function(value, index, array) is truthy.', 'higher-order'],
  ['reduce', 'array, function[, init]', 'Folds the array with function(accumulator, value, index, array).', 'higher-order'],
  ['single', 'array[, function]', 'Returns the one item matching function; throws if zero or more than one match.', 'higher-order'],
  ['sort', 'array[, function]', 'Sorts an array; the optional comparator returns true if $l should come AFTER $r.', 'array']
];

const seen = new Set<string>();
export const FUNCTIONS: FnDoc[] = [];
for (const [name, params, description, category] of RAW) {
  if (seen.has(name)) continue;
  seen.add(name);
  FUNCTIONS.push({
    name,
    signature: `$${name}(${params})`,
    description,
    category,
    url: `${DOCS_BASE}/${PAGES[category]}#${name.toLowerCase()}`
  });
}

export const FUNCTION_NAMES = new Set(FUNCTIONS.map((f) => f.name));
export const FUNCTION_BY_NAME = new Map(FUNCTIONS.map((f) => [f.name, f]));

export interface HelpLink {
  label: string;
  description: string;
  url: string;
}

export const HELP_LINKS: HelpLink[] = [
  { label: 'JSONata documentation', description: 'Introduction and overview', url: `${DOCS_BASE}/overview` },
  { label: 'Simple queries & path expressions', description: 'Navigating JSON', url: `${DOCS_BASE}/simple` },
  { label: 'Predicate queries', description: 'Filtering with [ ... ]', url: `${DOCS_BASE}/predicate` },
  { label: 'Sorting, grouping & aggregation', description: 'Order-by and group-by', url: `${DOCS_BASE}/sorting-grouping` },
  { label: 'Programming constructs', description: 'Conditionals, variables, functions, blocks', url: `${DOCS_BASE}/programming` },
  { label: 'Path operators', description: '. [] {} ^ * ** % # @ ~>', url: `${DOCS_BASE}/path-operators` },
  { label: 'Comparison & boolean operators', description: '=, !=, <, and, or, in', url: `${DOCS_BASE}/comparison-operators` },
  { label: 'Function library reference', description: 'All built-in $functions', url: `${DOCS_BASE}/overview#function-library` },
  { label: 'String functions', description: '$substring, $replace, $match ...', url: `${DOCS_BASE}/string-functions` },
  { label: 'Numeric functions', description: '$round, $formatNumber ...', url: `${DOCS_BASE}/numeric-functions` },
  { label: 'Aggregation functions', description: '$sum, $average ...', url: `${DOCS_BASE}/aggregation-functions` },
  { label: 'Array functions', description: '$sort, $distinct, $zip ...', url: `${DOCS_BASE}/array-functions` },
  { label: 'Object functions', description: '$keys, $merge, $each ...', url: `${DOCS_BASE}/object-functions` },
  { label: 'Date/time functions', description: '$now, $fromMillis, $toMillis', url: `${DOCS_BASE}/date-time` },
  { label: 'Higher order functions', description: '$map, $filter, $reduce', url: `${DOCS_BASE}/higher-order-functions` },
  { label: 'Regular expressions', description: 'Regex literals in JSONata', url: `${DOCS_BASE}/regex` },
  { label: 'JSONata Exerciser (browser)', description: 'Official online playground', url: 'https://try.jsonata.org/' },
  { label: 'JSONata GitHub repository', description: 'Source code and issues', url: 'https://github.com/jsonata-js/jsonata' }
];

/** Parameter name list for signature help. */
export function paramLabels(fn: FnDoc): Array<[number, number]> {
  const open = fn.signature.indexOf('(');
  const close = fn.signature.lastIndexOf(')');
  const inner = fn.signature.slice(open + 1, close);
  const ranges: Array<[number, number]> = [];
  let cursor = open + 1;
  // split by commas, ignoring '[' and ']' decorations
  for (const raw of inner.split(',')) {
    const name = raw.replace(/[[\]]/g, '').trim();
    if (!name) continue;
    const idx = fn.signature.indexOf(name, cursor);
    if (idx < 0) continue;
    ranges.push([idx, idx + name.length]);
    cursor = idx + name.length;
  }
  return ranges;
}
