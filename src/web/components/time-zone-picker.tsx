import { useCallback, useEffect, useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Search, X } from 'lucide-react';

function searchText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_/]+/g, ' ')
    .toLowerCase();
}

export function TimeZonePicker({
  value,
  zones,
  disabled = false,
  labelledBy,
  onChange,
}: {
  value: string;
  zones: string[];
  disabled?: boolean;
  labelledBy: string;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(value);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const tabTarget = useRef<HTMLElement | null>(null);
  const id = useId();
  const words = searchText(query).trim().split(/\s+/).filter(Boolean);
  const matches = zones.filter((zone) => words.every((word) => searchText(zone).includes(word)));
  const activeIndex = Math.max(0, matches.indexOf(active));
  const activeZone = matches[activeIndex];
  const scrollActiveIntoView = useCallback(
    () =>
      options.current
        ?.querySelector<HTMLElement>('[data-active="true"]')
        ?.scrollIntoView?.({ block: 'nearest' }),
    [],
  );
  const observeOptions = useCallback(
    (node: HTMLDivElement | null) => {
      options.current = node;
      if (!node) return;
      let previousHeight = -1;
      const observer =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver(([entry]) => {
              if (entry && entry.contentRect.height !== previousHeight) {
                previousHeight = entry.contentRect.height;
                scrollActiveIntoView();
              }
            });
      observer?.observe(node);
      return () => {
        observer?.disconnect();
        options.current = null;
      };
    },
    [scrollActiveIntoView],
  );
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery('');
      setActive(value);
    }
  };
  const select = (zone: string) => {
    onChange(zone);
    setOpen(false);
  };
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (open) scrollActiveIntoView();
  }, [open, activeZone, scrollActiveIntoView]);
  return (
    <Popover.Root open={open} onOpenChange={changeOpen} modal>
      <Popover.Trigger
        ref={trigger}
        type="button"
        className="time-zone-picker-trigger"
        disabled={disabled}
        aria-labelledby={`${labelledBy} ${id}-value`}
        title={value.replaceAll('_', ' ')}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            changeOpen(true);
          }
        }}
      >
        <span id={`${id}-value`}>{value.replaceAll('_', ' ')}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="time-zone-picker-panel"
          aria-label="Choose time zone"
          align="end"
          sideOffset={7}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            search.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            if (tabTarget.current?.isConnected) {
              event.preventDefault();
              tabTarget.current.focus();
            }
            tabTarget.current = null;
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
            event.preventDefault();
            const scope = trigger.current?.closest('[role="dialog"]') ?? document.body;
            const candidates = [
              ...scope.querySelectorAll<HTMLElement>('button,a,input,[tabindex]'),
            ].filter(
              (candidate) =>
                candidate.tabIndex >= 0 &&
                !candidate.hasAttribute('disabled') &&
                !candidate.closest('[hidden],[inert]') &&
                getComputedStyle(candidate).visibility !== 'hidden' &&
                getComputedStyle(candidate).display !== 'none',
            );
            const index = candidates.indexOf(trigger.current!);
            tabTarget.current = candidates[index + (event.shiftKey ? -1 : 1)] ?? trigger.current;
            setOpen(false);
          }}
        >
          <div className="time-zone-picker-search">
            <Search size={16} aria-hidden="true" />
            <input
              ref={search}
              type="text"
              role="combobox"
              aria-label="Search time zones"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={`${id}-options`}
              aria-activedescendant={activeZone ? `${id}-option-${activeIndex}` : undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder="Search city or time zone"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive('');
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.altKey || event.metaKey || event.ctrlKey)
                  return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (activeZone) select(activeZone);
                  return;
                }
                const next =
                  event.key === 'ArrowDown'
                    ? (activeIndex + 1) % matches.length
                    : event.key === 'ArrowUp'
                      ? (activeIndex - 1 + matches.length) % matches.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? matches.length - 1
                          : null;
                if (next !== null) {
                  event.preventDefault();
                  if (matches[next]) setActive(matches[next]);
                }
              }}
            />
            {query && (
              <button
                type="button"
                aria-label="Clear time zone search"
                onClick={() => {
                  setQuery('');
                  setActive(value);
                  search.current?.focus();
                }}
              >
                <X size={15} aria-hidden="true" />
              </button>
            )}
          </div>
          <div
            ref={observeOptions}
            id={`${id}-options`}
            role="listbox"
            aria-label="Time zones"
            className="time-zone-picker-options"
          >
            {matches.map((zone, index) => (
              <button
                key={zone}
                id={`${id}-option-${index}`}
                type="button"
                role="option"
                aria-selected={zone === value}
                data-active={zone === activeZone}
                tabIndex={-1}
                onPointerMove={(event) => {
                  if (event.pointerType === 'mouse') setActive(zone);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(zone)}
              >
                <span>{zone.replaceAll('_', ' ')}</span>
                {zone === value && <Check size={16} aria-hidden="true" />}
              </button>
            ))}
          </div>
          {!matches.length && (
            <p className="time-zone-picker-empty" role="status">
              No time zones found.
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
