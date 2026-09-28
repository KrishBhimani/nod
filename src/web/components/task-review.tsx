import { useId } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import type { Artifact } from '../../shared/contracts';
import { BrandMark } from './brand';
import { Button } from './ui';
import type { TaskReviewVariant } from './task-review-prototype';

export interface TaskReviewState {
  taskId: string;
  summary: string;
  text: string;
  attachments: Artifact[];
}

export function TaskReview({
  variant,
  review,
  busy,
  error,
  onRestart,
  onLeave,
}: {
  variant: TaskReviewVariant;
  review: TaskReviewState;
  busy: boolean;
  error: string;
  onRestart(): void;
  onLeave(): void;
}) {
  const heading = useId();
  const detail = useId();
  const summary = review.summary.trim() || 'the earlier request';
  const actions = (
    <div className="task-review-actions">
      <Button size="sm" disabled={busy} onClick={onRestart}>
        <RotateCcw size={14} aria-hidden="true" />
        It didn’t happen, start again
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onLeave}>
        Leave it
      </Button>
    </div>
  );
  const failure = error && (
    <p className="task-review-error" role="alert">
      {error}
    </p>
  );
  if (variant === 'B')
    return (
      <section
        className="task-review task-review-banner"
        aria-labelledby={heading}
        aria-describedby={detail}
      >
        <TriangleAlert className="task-review-icon" size={16} aria-hidden="true" />
        <div className="task-review-copy">
          <h2 id={heading}>Check the app before Otto tries again</h2>
          <p id={detail}>
            Otto stopped during “{summary}” and may have already sent or changed something.
          </p>
          {failure}
        </div>
        {actions}
      </section>
    );
  if (variant === 'C')
    return (
      <section
        className="message message-assistant task-review task-review-message"
        aria-labelledby={heading}
        aria-describedby={detail}
      >
        <div className="assistant-mark" aria-hidden="true">
          <BrandMark small />
        </div>
        <div className="message-content">
          <span className="task-review-status" id={heading}>
            <TriangleAlert size={12} aria-hidden="true" />
            Needs your check
          </span>
          <div className="message-text" id={detail}>
            <p>
              I stopped during “{summary}”, and I may have already sent, submitted or changed
              something. Please check the app or website first, so I don’t do it twice.
            </p>
          </div>
          {actions}
          {failure}
        </div>
      </section>
    );
  return (
    <section
      className="task-review task-review-card"
      aria-labelledby={heading}
      aria-describedby={detail}
    >
      <header>
        <span className="task-review-badge">
          <TriangleAlert size={14} aria-hidden="true" />
        </span>
        <h2 id={heading}>Check this before Otto starts again</h2>
      </header>
      <p id={detail}>
        Otto stopped during <strong>{summary}</strong>. It may have already sent, submitted or
        changed something. Check the app or website first.
      </p>
      <blockquote className="task-review-held">
        <span>Your message</span>
        {review.text}
      </blockquote>
      {actions}
      {failure}
    </section>
  );
}
