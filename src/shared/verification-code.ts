type VerificationReply =
  { kind: 'code'; code: string } | { kind: 'invalid' } | { kind: 'ordinary' };

export function classifyVerificationReply(text: string): VerificationReply {
  const value = text.trim();
  const prefix =
    /^(?:(?:(?:the|my)\s+)?(?:(?:verification|security|authentication|one[- ]time|2fa|sms|email)\s+)?code|otp|(?:(?:o|meu|o meu)\s+)?c[oó]digo(?:\s+de\s+(?:verifica[cç][aã]o|seguran[cç]a|autentica[cç][aã]o))?)(?:\s+(?:is|[eé]))?(?:\s*[:=]\s*|\s+)(?=\d)/i.exec(
      value,
    );
  const candidate = prefix ? value.slice(prefix[0].length).replace(/[.!]$/, '') : value;
  if (candidate.length <= 160 && /^[\d \t]+$/.test(candidate)) {
    const code = candidate.replace(/[ \t]/g, '');
    if (/^\d{4,8}$/.test(code)) return { kind: 'code', code };
  }
  return { kind: prefix ? 'invalid' : 'ordinary' };
}
