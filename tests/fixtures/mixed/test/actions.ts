import { formatGreeting } from "../src/actions";

export function testFormatGreeting(): boolean {
  return formatGreeting("Ada") === "Hello Ada";
}
