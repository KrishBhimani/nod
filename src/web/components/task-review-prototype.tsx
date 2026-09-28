import { createRoot } from 'react-dom/client';
import './task-review-prototype.css';

export type TaskReviewVariant = 'A' | 'B' | 'C';
const variants: { key: TaskReviewVariant; name: string }[] = [
  { key: 'A', name: 'Timeline card' },
  { key: 'B', name: 'Composer banner' },
  { key: 'C', name: 'Otto message' },
];

export function taskReviewVariant(): TaskReviewVariant {
  if (!import.meta.env?.DEV || typeof location === 'undefined') return 'A';
  const value = new URLSearchParams(location.search).get('variant');
  return value === 'B' || value === 'C' ? value : 'A';
}

function Switcher() {
  const current = taskReviewVariant();
  return (
    <nav className="task-review-prototype-switcher" aria-label="Recovery prototype">
      <span>Recovery</span>
      {variants.map((variant) => (
        <a
          key={variant.key}
          href={`?variant=${variant.key}`}
          aria-current={variant.key === current ? 'true' : undefined}
          title={variant.name}
        >
          {variant.key} <small>{variant.name}</small>
        </a>
      ))}
    </nav>
  );
}

if (import.meta.env?.DEV && typeof document !== 'undefined') {
  const host = document.createElement('div');
  document.body.append(host);
  createRoot(host).render(<Switcher />);
}
