import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, CreditCard, Globe } from 'lucide-react';
import type { VaultEntry } from '../../shared/contracts';
import { Button } from './ui';

export function VaultEntryIcon({ entry, size = 20 }: { entry: VaultEntry; size?: number }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (entry.kind === 'card') return <CreditCard size={size} aria-hidden="true" />;
  return (
    <>
      {!loaded && <Globe size={size} aria-hidden="true" />}
      {!failed && (
        <img
          className="vault-site-icon"
          src={`/api/vault/${encodeURIComponent(entry.id)}/icon`}
          alt=""
          width={size}
          height={size}
          decoding="async"
          referrerPolicy="no-referrer"
          hidden={!loaded}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </>
  );
}

export function VaultTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="vault-hero-title" data-vault-title tabIndex={-1}>
      {children}
    </h2>
  );
}

export function VaultSurface({
  label,
  autoFocus = true,
  onClose,
  children,
}: {
  label: string;
  autoFocus?: boolean;
  onClose(): void;
  children: React.ReactNode;
}) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (autoFocus) section.current?.querySelector<HTMLElement>('[data-vault-title]')?.focus();
  }, [autoFocus]);
  return (
    <section
      ref={section}
      className="vault-surface"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) onClose();
      }}
    >
      {children}
    </section>
  );
}

export function VaultBackButton({ onClick }: { onClick(): void }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="vault-back" onClick={onClick}>
      <ChevronLeft size={18} aria-hidden="true" />
      Vault
    </Button>
  );
}
