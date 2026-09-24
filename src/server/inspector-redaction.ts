export const inspectorPayloadLimit = 16_384;
const hidden = '[redacted]';
const secretNames =
  'password|passwd|pwd|passphrase|secret|clientsecret|authorization|proxyauthorization|cookie|setcookie|apikey|xapikey|xauthtoken|xcsrftoken|csrftoken|sessiontoken|accesskey|privatekey|signingkey|masterkey|vaultkey|token|accesstoken|refreshtoken|idtoken|bottoken|credential|credentials|otp|otpcode|verificationcode|totp|totpsecret|cvv|cvc|pan|cardnumber';
const secretKey = new RegExp(`^(?:${secretNames})$`, 'i');
const secretAssignment = new RegExp(
  String.raw`((["']?)\b(?:${secretNames
    .split('|')
    .map((name) => name.split('').join('[-_]?'))
    .join('|')})\2\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}&]+)`,
  'gi',
);

export function createInspectorRedactor(secrets: string[] = []) {
  const values = [...new Set(secrets.filter((value) => value.length >= 8))].sort(
    (a, b) => b.length - a.length,
  );
  function text(value: string): string {
    for (const secret of values) {
      value = value.replaceAll(secret, hidden).replaceAll(encodeURIComponent(secret), hidden);
    }
    return value
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, hidden)
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi, hidden)
      .replace(
        /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*[^\r\n]+/gi,
        hidden,
      )
      .replace(
        /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|ghs_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
        hidden,
      )
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, hidden)
      .replace(
        /((?:https?:\/\/[^\s/"'<>]+)?\/(?:credentials|approvals)\/)[^\s"'<>]+/gi,
        '$1[redacted]',
      )
      .replace(
        /([?&#](?:access_token|refresh_token|id_token|token|code|state|key|api_key|secret|password)=)[^\s&"'<>]*/gi,
        '$1[redacted]',
      )
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
      .replace(secretAssignment, '$1[redacted]')
      .replace(/\bdata:[^,\s]+;base64,[A-Za-z0-9+/=]+/g, '[binary omitted]');
  }
  return function redact(value: unknown): unknown {
    let nodes = 0;
    const seen = new WeakSet<object>();
    function visit(item: unknown, depth: number): unknown {
      if (++nodes > 1200 || depth > 12) return '[truncated]';
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          if (trimmed.length >= 64_000) return '[oversized JSON payload omitted]';
          try {
            return visit(JSON.parse(trimmed), depth + 1);
          } catch {}
        }
        const safe = text(item).slice(0, 64_000);
        return safe.length > 8000 ? safe.slice(0, 8000) + ' [truncated]' : safe;
      }
      if (item === null || typeof item === 'boolean') return item;
      if (typeof item === 'number') return Number.isFinite(item) ? item : null;
      if (typeof item !== 'object') return '[omitted]';
      if (seen.has(item)) return '[circular]';
      seen.add(item);
      if (Buffer.isBuffer(item) || item instanceof Uint8Array) return '[binary omitted]';
      if (item instanceof Date) return Number.isFinite(item.getTime()) ? item.toISOString() : null;
      if (Array.isArray(item)) {
        if (typeof item[0] === 'string' && secretKey.test(item[0].replace(/[^a-z0-9]/gi, '')))
          return [text(item[0]), hidden];
        const result = item.slice(0, 100).map((entry) => visit(entry, depth + 1));
        if (item.length > 100) result.push('[truncated]');
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      const namedSecret =
        'name' in item &&
        typeof item.name === 'string' &&
        secretKey.test(item.name.replace(/[^a-z0-9]/gi, ''));
      for (const [key, entry] of Object.entries(item).slice(0, 100)) {
        const normalized = key.replace(/[^a-z0-9]/gi, '');
        result[text(key)] =
          secretKey.test(normalized) || (namedSecret && key === 'value')
            ? hidden
            : (key === 'data' &&
                  'type' in item &&
                  ['image', 'audio', 'base64'].includes(String(item.type))) ||
                ['image_url', 'audio_url', 'base64'].includes(key)
              ? '[binary omitted]'
              : visit(entry, depth + 1);
      }
      return result;
    }
    const safe = visit(value, 0);
    const encoded = JSON.stringify(safe);
    if (Buffer.byteLength(encoded) <= inspectorPayloadLimit) return safe;
    let preview = encoded.slice(0, 8000);
    while (Buffer.byteLength(JSON.stringify({ preview, truncated: true })) > inspectorPayloadLimit)
      preview = preview.slice(0, Math.floor(preview.length * 0.8));
    return { preview, truncated: true };
  };
}
