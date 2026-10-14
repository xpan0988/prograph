export interface ScipSymbol { raw: string; local: boolean; name: string; scheme?: string; manager?: string; package?: string; version?: string; descriptors?: string }
/** Parse identity syntax, including doubled spaces and escaped descriptor identifiers. */
export function parseScipSymbol(raw: string): ScipSymbol {
  if (!raw || raw.length > 16384) throw Error("Invalid SCIP symbol size");
  if (raw.startsWith("local ")) {
    const id = raw.slice(6); if (!/^[A-Za-z0-9_+$-]+$/.test(id)) throw Error("Invalid local SCIP symbol");
    return { raw, local: true, name: raw };
  }
  let position = 0;
  const token = (): string => {
    let value = "";
    while (position < raw.length) {
      const character = raw[position++]!;
      if (character !== " ") value += character;
      else if (raw[position] === " ") { value += " "; position++; }
      else { if (!value) throw Error("Empty SCIP identity component"); return value; }
    }
    throw Error("Incomplete SCIP package identity");
  };
  const scheme = token(); const manager = token(); const packageName = token(); const version = token();
  if (scheme.startsWith("local")) throw Error("Invalid global SCIP scheme");
  const descriptors = raw.slice(position); let name = "";
  const identifier = (): string => {
    let value = "";
    if (raw[position] === "`") {
      position++; let closed = false;
      while (position < raw.length) { const character = raw[position++]!;
        if (character !== "`") value += character;
        else if (raw[position] === "`") { value += "`"; position++; } else { closed = true; break; }
      }
      if (!closed || !value) throw Error("Invalid escaped SCIP descriptor");
    } else {
      while (position < raw.length && /[A-Za-z0-9_+$-]/.test(raw[position]!)) value += raw[position++];
      if (!value) throw Error("Missing SCIP descriptor identifier");
    }
    return value;
  };
  let count = 0;
  while (position < raw.length) {
    const bracket = raw[position] === "[" ? "]" : raw[position] === "(" ? ")" : undefined;
    if (bracket) { position++; name = identifier(); if (raw[position++] !== bracket) throw Error("Invalid SCIP parameter descriptor"); }
    else {
      name = identifier(); const suffix = raw[position++];
      if (suffix === "(") { while (position < raw.length && /[A-Za-z0-9_+$-]/.test(raw[position]!)) position++; if (raw.slice(position, position + 2) !== ").") throw Error("Invalid SCIP method descriptor"); position += 2; }
      else if (!suffix || !"/#.:!".includes(suffix)) throw Error("Invalid SCIP descriptor suffix");
    }
    if (++count > 256) throw Error("Too many SCIP descriptors");
  }
  if (!count) throw Error("SCIP symbol has no descriptor");
  return { raw, local: false, name, scheme, manager, package: packageName, version, descriptors };
}
