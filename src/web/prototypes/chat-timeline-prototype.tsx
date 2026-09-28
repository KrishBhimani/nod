import { FlaskConical } from 'lucide-react';

export type ChatVariant = 'A' | 'B' | 'C';

const variants: Record<ChatVariant, string> = {
  A: 'Corner button',
  B: 'Pill and sticky day',
  C: 'Composer tab',
};

export function chatVariant(): ChatVariant {
  if (import.meta.env?.DEV !== true || typeof window === 'undefined') return 'A';
  const value = new URLSearchParams(window.location.search).get('variant');
  return value === 'B' || value === 'C' ? value : 'A';
}

export function ChatTimelinePrototypeSwitcher({
  variant,
  onChange,
}: {
  variant: ChatVariant;
  onChange(variant: ChatVariant): void;
}) {
  if (import.meta.env?.DEV !== true) return null;
  return (
    <div className="chat-prototype-switcher" role="group" aria-label="Prototype variant">
      <span>
        <FlaskConical size={13} />
        Prototype
      </span>
      {(Object.keys(variants) as ChatVariant[]).map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={variant === key}
          title={variants[key]}
          onClick={() => {
            const url = new URL(window.location.href);
            url.searchParams.set('variant', key);
            window.history.replaceState(window.history.state, '', url);
            onChange(key);
          }}
        >
          {key}
        </button>
      ))}
      <small>{variants[variant]}</small>
    </div>
  );
}
