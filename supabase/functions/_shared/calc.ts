// Deterministic tools: exact arithmetic and calendar logic, so the model never
// does maths or date reasoning "in its head".
//
//   calculate("15% of 2400")        → 360
//   calculate("sqrt(2) * (3 + 4)^2") → 69.2964645563
//   dateMath({ op: 'diff', from: '2026-01-01', to: '2026-12-25' }) → 358 days …
//
// The calculator is a small recursive-descent parser over a fixed grammar —
// never eval — so model-written input cannot run code.

// ------------------------------------------------------------- calculator

// Null-prototype objects + own-property checks: names like "constructor" or
// "toString" must never resolve to built-in JavaScript properties.
const FUNCTIONS: Record<string, (...a: number[]) => number> = Object.assign(Object.create(null), {
  sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, exp: Math.exp,
  ln: Math.log, log10: Math.log10, log2: Math.log2,
  log: (x: number, base?: number) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)),
  round: (x: number, digits = 0) => {
    const f = 10 ** digits;
    return Math.round((x + Number.EPSILON) * f) / f;
  },
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  min: Math.min, max: Math.max,
});
const CONSTANTS: Record<string, number> = Object.assign(Object.create(null), { pi: Math.PI, e: Math.E });
const MAX_LENGTH = 300;

type Token = { kind: 'num'; value: number } | { kind: 'id'; value: string } | { kind: 'op'; value: string };

function tokenize(input: string): Token[] {
  const s = input
    .toLowerCase()
    .replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
    .replace(/\b(\d{1,3}(?:,\d{3})+)(?![\d,])/g, (m) => m.replace(/,/g, '')) // 1,200,000
    .replace(/\bpercent\b/g, '%')
    .replace(/\bof\b/g, '*')
    .replace(/\bmod\b/g, ' mod ')
    .replace(/\btimes\b/g, '*').replace(/\bdivided by\b/g, '/').replace(/\bplus\b/g, '+').replace(/\bminus\b/g, '-');
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = s.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/);
    if (num) { tokens.push({ kind: 'num', value: Number(num[0]) }); i += num[0].length; continue; }
    const id = s.slice(i).match(/^[a-z_][a-z0-9_]*/);
    if (id) { tokens.push(id[0] === 'mod' ? { kind: 'op', value: 'mod' } : { kind: 'id', value: id[0] }); i += id[0].length; continue; }
    if ('+-*/^%(),!'.includes(c)) { tokens.push({ kind: 'op', value: c === '*' && s[i + 1] === '*' ? (i++, '^') : c }); i++; continue; }
    throw new Error(`Unexpected character "${c}"`);
  }
  return tokens;
}

/** Evaluates an arithmetic expression exactly as written. Throws a readable error on bad input. */
export function calculate(expression: string): number {
  if (expression.length > MAX_LENGTH) throw new Error('Expression is too long');
  const tokens = tokenize(expression);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.kind === 'op' && peek()!.value === v;
  const take = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}"`);
    pos++;
  };

  const expr = (): number => {
    if (++depth > 50) throw new Error('Expression is nested too deeply');
    let v = term();
    while (isOp('+') || isOp('-')) v = (tokens[pos++].value === '+') ? v + term() : v - term();
    depth--;
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (isOp('*') || isOp('/') || isOp('mod') || peek()?.kind === 'num' || peek()?.kind === 'id' || isOp('(')) {
      // Implicit multiplication: "2(3+4)", "2pi"
      const op = peek()!.kind === 'op' && ['*', '/', 'mod'].includes(peek()!.value as string) ? (tokens[pos++].value as string) : '*';
      const r = unary();
      if (op === '/' && r === 0) throw new Error('Division by zero');
      v = op === '*' ? v * r : op === '/' ? v / r : ((v % r) + r) % r;
    }
    return v;
  };
  // Unary minus binds looser than ^, so -3^2 = -9 (standard maths); 2^-1 = 0.5.
  const unary = (): number => {
    if (isOp('-')) { pos++; return -unary(); }
    if (isOp('+')) { pos++; return unary(); }
    return power();
  };
  const power = (): number => {
    const base = postfix();
    if (isOp('^')) { pos++; return base ** unary(); } // right-associative
    return base;
  };
  const postfix = (): number => {
    let v = primary();
    while (isOp('%') || isOp('!')) {
      if (tokens[pos++].value === '%') v = v / 100;
      else {
        if (!Number.isInteger(v) || v < 0 || v > 170) throw new Error('Factorial needs a whole number from 0 to 170');
        let f = 1;
        for (let k = 2; k <= v; k++) f *= k;
        v = f;
      }
    }
    return v;
  };
  const primary = (): number => {
    const t = peek();
    if (!t) throw new Error('The expression ended unexpectedly');
    if (t.kind === 'num') { pos++; return t.value; }
    if (t.kind === 'op' && t.value === '(') { pos++; const v = expr(); take(')'); return v; }
    if (t.kind === 'id') {
      pos++;
      if (Object.hasOwn(CONSTANTS, t.value) && !isOp('(')) return CONSTANTS[t.value];
      if (!Object.hasOwn(FUNCTIONS, t.value)) throw new Error(`Unknown function or name "${t.value}"`);
      const fn = FUNCTIONS[t.value];
      take('(');
      const args = [expr()];
      while (isOp(',')) { pos++; args.push(expr()); }
      take(')');
      return fn(...args);
    }
    throw new Error(`Unexpected "${t.value}"`);
  };

  const value = expr();
  if (pos < tokens.length) throw new Error(`Unexpected "${(tokens[pos] as Token).value}"`);
  if (!Number.isFinite(value)) throw new Error('The result is not a finite number');
  return value;
}

/** A number written the way people read it: exact integers, otherwise 12 significant digits. */
export function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  return String(Number(value.toPrecision(12)));
}

// ------------------------------------------------------------------- dates

export type DateRequest =
  | { op: 'now'; timezone?: string }
  | { op: 'add'; date: string; amount: number; unit: 'days' | 'weeks' | 'months' | 'years' }
  | { op: 'diff'; from: string; to: string }
  | { op: 'weekday'; date: string };

const DAY = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function parseDate(raw: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) throw new Error(`"${raw}" is not a date in YYYY-MM-DD form`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) throw new Error(`${raw} is not a real date`);
  return date;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months, day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, lastDay))); // 31 Jan + 1 month = 28/29 Feb
}

/** Exact calendar logic. Returns a JSON-able result. */
export function dateMath(req: DateRequest, now: () => Date = () => new Date()): Record<string, unknown> {
  switch (req.op) {
    case 'now': {
      const timeZone = req.timezone || 'UTC';
      let formatted: string;
      try {
        formatted = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(now());
      } catch {
        throw new Error(`Unknown time zone "${timeZone}" (use an IANA name such as Africa/Lagos)`);
      }
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
      return { timezone: timeZone, now: formatted, date: parts };
    }
    case 'add': {
      const d = parseDate(req.date);
      const out = req.unit === 'days' ? new Date(d.getTime() + req.amount * DAY)
        : req.unit === 'weeks' ? new Date(d.getTime() + req.amount * 7 * DAY)
        : req.unit === 'months' ? addMonths(d, req.amount)
        : addMonths(d, req.amount * 12);
      return { date: iso(out), weekday: WEEKDAYS[out.getUTCDay()] };
    }
    case 'diff': {
      const a = parseDate(req.from), b = parseDate(req.to);
      const days = Math.round((b.getTime() - a.getTime()) / DAY);
      const [start, end] = days >= 0 ? [a, b] : [b, a];
      let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
      if (addMonths(start, months).getTime() > end.getTime()) months--;
      const rest = Math.round((end.getTime() - addMonths(start, months).getTime()) / DAY);
      return {
        days,
        weeks: Math.trunc(days / 7), extra_days: Math.abs(days % 7),
        calendar: { years: Math.trunc(months / 12), months: months % 12, days: rest, direction: days >= 0 ? 'forward' : 'backward' },
      };
    }
    case 'weekday': {
      const d = parseDate(req.date);
      return { date: req.date, weekday: WEEKDAYS[d.getUTCDay()] };
    }
  }
}

// --------------------------------------------------- tool definitions

export const CALC_TOOLS = [
  {
    name: 'calculate',
    description:
      'Evaluate an arithmetic expression exactly. ALWAYS use this for any arithmetic instead of computing in your head. ' +
      'Supports + - * / ^, parentheses, % (as percent: "15% of 2400"), mod, sqrt, round(x, digits), log, ln, min, max, sin/cos/tan (radians), pi, e.',
    parameters: {
      type: 'object' as const,
      properties: { expression: { type: 'string' as const, minLength: 1, maxLength: MAX_LENGTH } },
      required: ['expression'],
      additionalProperties: false,
    },
  },
  {
    name: 'date_math',
    description:
      'Exact calendar logic. ALWAYS use this for dates instead of reasoning in your head. ' +
      'op "now" (current date/time, optional IANA timezone such as Africa/Lagos), "add" (date + amount days/weeks/months/years), ' +
      '"diff" (days and calendar years/months/days between two dates), "weekday" (day of the week). Dates are YYYY-MM-DD.',
    parameters: {
      type: 'object' as const,
      properties: {
        op: { type: 'string' as const, enum: ['now', 'add', 'diff', 'weekday'] },
        timezone: { type: 'string' as const, maxLength: 64 },
        date: { type: 'string' as const, pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        from: { type: 'string' as const, pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string' as const, pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        amount: { type: 'integer' as const, minimum: -100000, maximum: 100000 },
        unit: { type: 'string' as const, enum: ['days', 'weeks', 'months', 'years'] },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
];

/** Runs a calculate/date_math tool call. Returns the result text, or throws with a readable message. */
export function runCalcTool(name: string, args: Record<string, unknown>, now?: () => Date): string {
  if (name === 'calculate') {
    const expression = String(args.expression ?? '');
    return `${expression} = ${formatNumber(calculate(expression))}`;
  }
  const op = args.op;
  const need = (keys: string[]) => {
    const missing = keys.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) throw new Error(`date_math "${op}" needs: ${missing.join(', ')}`);
  };
  if (op === 'add') need(['date', 'amount', 'unit']);
  if (op === 'diff') need(['from', 'to']);
  if (op === 'weekday') need(['date']);
  return JSON.stringify(dateMath(args as DateRequest, now));
}
