// §5.8 step 3: where a template variable's value comes from. Shared by both channels.

export type ValueSource = ({ field: string } | { attribute: string } | { static: string }) & { fallback?: string };
export type VariableContact = { attributes?: Record<string, unknown> | null } & Record<string, unknown>;

/** G-14: newlines, tabs and runs of spaces become one space. This also stops header injection in an email subject. */
export const cleanValue = (value: unknown) => (value === null || value === undefined ? '' : String(value).replace(/[\r\n\t ]+/g, ' ').trim());

/** The cleaned value, or its fallback, or null when both are empty. */
export function resolveValue(source: ValueSource | undefined, contact: VariableContact): string | null {
  if (!source) return null;
  const raw = 'static' in source ? source.static : 'field' in source ? contact[source.field] : contact.attributes?.[source.attribute];
  return cleanValue(raw) || cleanValue(source.fallback) || null;
}
