// Strict JSON Schema validation for tool calls and internal handoffs.
//
// Covers the subset our schemas use: type (object, string, integer, number,
// boolean, array), properties, required, additionalProperties: false, enum,
// minimum/maximum, minLength/maxLength, pattern, items, minItems/maxItems.
// Tool calls that fail validation are never executed: the model gets the
// errors back and may retry (see aro-agent's state machine).

export type JsonSchema = {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  description?: string;
};

/** Every problem with `value`, as readable "path: problem" lines. Empty = valid. */
export function validate(schema: JsonSchema, value: unknown, path = 'arguments'): string[] {
  const errors: string[] = [];
  const type = schema.type;
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: must be an object`];
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined || obj[key] === null) errors.push(`${path}.${key}: is required`);
    }
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (!sub) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: is not an allowed field`);
        continue;
      }
      if (v === undefined || v === null) continue;
      errors.push(...validate(sub, v, `${path}.${key}`));
    }
    return errors;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${path}: must be an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items!, v, `${path}[${i}]`)));
    return errors;
  }
  if (type === 'string') {
    if (typeof value !== 'string') return [`${path}: must be a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: must not be empty`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: is too long (max ${schema.maxLength})`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: has the wrong format`);
  } else if (type === 'integer' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) {
      return [`${path}: must be ${type === 'integer' ? 'an integer' : 'a number'}`];
    }
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be at most ${schema.maximum}`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return [`${path}: must be true or false`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  return errors;
}
