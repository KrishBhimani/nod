export function speechParts(text: string) {
  const limit = 3000;
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    let end = remaining.lastIndexOf(' ', limit);
    if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}
