// Independent accepted serializer: a598004, analyze.ts final export arguments.
export function acceptedPrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
