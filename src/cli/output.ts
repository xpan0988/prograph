export type OutputFormat = "text" | "json";

export function writeResult(value: unknown, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatText(value)}\n`);
}

function formatText(value: unknown, indent = ""): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}(none)`;
    return value.map((item, index) => `${indent}${index + 1}. ${formatText(item, `${indent}   `).trimStart()}`).join("\n");
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => {
      if (item && typeof item === "object") return `${indent}${key}:\n${formatText(item, `${indent}  `)}`;
      return `${indent}${key}: ${String(item)}`;
    })
    .join("\n");
}
