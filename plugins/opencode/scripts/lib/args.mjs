// Lightweight argument parser for the OpenCode companion scripts.

/**
 * Parse CLI arguments into options and positional args.
 * @param {string[]} argv
 * @param {{ valueOptions?: string[], booleanOptions?: string[] }} schema
 * @returns {{ options: Record<string, string|boolean>, positional: string[] }}
 */
export function parseArgs(argv, schema = {}) {
  const valueSet = new Set(schema.valueOptions ?? []);
  const boolSet = new Set(schema.booleanOptions ?? []);
  const options = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      if (positional.length > 0) {
        positional.push(arg);
      }
      for (let j = i + 1; j < argv.length; j++) {
        positional.push(argv[j]);
      }
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const rawKey = arg.slice(2);
    const equalsIdx = rawKey.indexOf("=");
    const key = equalsIdx >= 0 ? rawKey.slice(0, equalsIdx) : rawKey;
    const inlineVal = equalsIdx >= 0 ? rawKey.slice(equalsIdx + 1) : null;

    if (valueSet.has(key)) {
      options[key] = inlineVal !== null ? inlineVal : (argv[++i] ?? "");
    } else if (boolSet.has(key)) {
      options[key] = true;
    } else if (!schema.rejectUnknown) {
      options[key] = true;
    } else {
      const accepted = [...valueSet, ...boolSet].sort().map((k) => `--${k}`).join(", ");
      const err = new Error(`Unknown option: ${arg}\nAccepted options: ${accepted}`);
      err.flag = arg;
      err.accepted = accepted;
      throw err;
    }
  }

  return { options, positional };
}

/**
 * Extract the natural-language text from argv after stripping known flags.
 * @param {string[]} argv
 * @param {string[]} flagsWithValue - flags that consume the next token
 * @param {string[]} booleanFlags - flags that are standalone
 * @returns {string}
 */
export function extractTaskText(argv, flagsWithValue = [], booleanFlags = []) {
  const valSet = new Set(flagsWithValue);
  const boolSet = new Set(booleanFlags);
  const parts = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      if (parts.length > 0) {
        parts.push(arg);
      }
      for (let j = i + 1; j < argv.length; j++) {
        parts.push(argv[j]);
      }
      break;
    }
    if (!arg.startsWith("--")) {
      parts.push(arg);
      continue;
    }
    const rawKey = arg.slice(2);
    const equalsIdx = rawKey.indexOf("=");
    const key = equalsIdx >= 0 ? rawKey.slice(0, equalsIdx) : rawKey;
    if (valSet.has(key)) {
      if (equalsIdx < 0) {
        i++; // skip value
      }
    }
    // skip flags silently
  }

  return parts.join(" ").trim();
}
