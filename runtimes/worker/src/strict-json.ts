export function parseUniqueJSON(text: string): unknown {
  const value: unknown = JSON.parse(text);
  // JSON.parse checks syntax. Scan the valid tokens for repeated decoded keys.
  const stack: ({ key: boolean; seen: Set<string> } | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const token = text[i];
    switch (token) {
      case '"': {
        const start = i;
        for (i++; text[i] !== '"'; i++) {
          if (text[i] === "\\") i++;
        }
        const frame = stack.at(-1);
        if (frame?.key) {
          const key = JSON.parse(text.slice(start, i + 1)) as string;
          if (frame.seen.has(key)) throw new SyntaxError("Duplicate JSON key");
          frame.seen.add(key);
        }
        break;
      }
      case "{": stack.push({ key: true, seen: new Set() }); break;
      case "[": stack.push(null); break;
      case "}":
      case "]": stack.pop(); break;
      case ",":
      case ":": {
        const frame = stack.at(-1);
        if (frame) frame.key = token === ",";
        break;
      }
    }
  }
  return value;
}
