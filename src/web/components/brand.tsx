export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-glyph ${small ? 'brand-glyph-small' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path
          d="M23 8H13a6 6 0 0 0 0 12h6a3 3 0 1 1 0 6H8"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <path
          d="M9 24h10a6 6 0 0 0 0-12h-6a3 3 0 0 1 0-6h11"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <circle cx="25" cy="6" r="4" fill="var(--primary)" />
      </svg>
    </span>
  );
}
