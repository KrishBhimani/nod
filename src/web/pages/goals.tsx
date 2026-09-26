import { PageTitle } from '../components/page-title';
import { useId, useState } from 'react';
import { ArrowUpRight, Pause, Play, Plus } from 'lucide-react';
import type { Goal } from '../../shared/contracts';
import { Button, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { draftInChat, goalDraft } from '../lib/secondary-pages';
import { DeletePlan } from '../components/delete-plan';

export function GoalRow({ goal }: { goal: Goal }) {
  const headingId = useId();
  return (
    <article className="saved-plan" aria-labelledby={headingId}>
      <div className="saved-plan-title">
        <h2 id={headingId}>{goal.title}</h2>
        <span className="saved-plan-status">{goal.status}</span>
      </div>
      {goal.description && <p className="saved-plan-description">{goal.description}</p>}
      <div className="saved-goal-progress">
        <progress aria-label={`${goal.title} progress`} max={100} value={goal.progress} />
        <span>{goal.progress}%</span>
      </div>
      {goal.nextAction && goal.status !== 'completed' && (
        <p className="saved-plan-next">
          <span>Next</span>
          {goal.nextAction}
        </p>
      )}
      <div className="saved-plan-footer">
        <span>{goal.targetDate ? `Target ${goal.targetDate}` : ''}</span>
        <div className="saved-plan-actions">
          {goal.status !== 'completed' && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${goal.status === 'active' ? 'Pause' : 'Resume'} goal ${goal.title}`}
              onClick={() => draftInChat(goalDraft(goal, 'status'))}
            >
              {goal.status === 'active' ? <Pause size={13} /> : <Play size={13} />}
              {goal.status === 'active' ? 'Pause' : 'Resume'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Update goal ${goal.title}`}
            onClick={() => draftInChat(goalDraft(goal, 'discuss'))}
          >
            Update <ArrowUpRight size={14} />
          </Button>
          <DeletePlan kind="goal" id={goal.id} title={goal.title} />
        </div>
      </div>
    </article>
  );
}

export function Goals() {
  const { data: goals, error, loading, refreshing, refresh } = usePageData<Goal[]>('/api/goals');
  const [view, setView] = useState<'active' | 'completed'>('active');
  const tabsId = useId();
  const active = (goals ?? []).filter((goal) => goal.status === 'active');
  const paused = (goals ?? []).filter((goal) => goal.status === 'paused');
  const completed = (goals ?? []).filter((goal) => goal.status === 'completed');
  const add = () =>
    draftInChat(
      "I'd like to set a new goal. Help me define what I want to achieve and the next step.",
    );
  return (
    <div className="content-page secondary-page goals-page">
      <header className="page-heading secondary-heading">
        <div>
          <PageTitle path="/goals" />
          <p>Your goals and next steps.</p>
        </div>
        <div className="secondary-heading-actions">
          <Button size="sm" onClick={add}>
            <Plus size={14} />
            Add goal
          </Button>
        </div>
      </header>
      <div
        className="goals-views"
        role="tablist"
        aria-label="Goal views"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 'active'
              : event.key === 'End'
                ? 'completed'
                : view === 'active'
                  ? 'completed'
                  : 'active';
          setView(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
        }}
      >
        {(['active', 'completed'] as const).map((item) => (
          <button
            key={item}
            id={`${tabsId}-tab-${item}`}
            data-view={item}
            role="tab"
            tabIndex={view === item ? 0 : -1}
            aria-selected={view === item}
            aria-controls={`${tabsId}-panel-${item}`}
            onClick={() => setView(item)}
          >
            {item === 'active' ? 'Active' : 'Completed'}
            {goals && <span>{item === 'active' ? active.length : completed.length}</span>}
          </button>
        ))}
      </div>
      {error && (
        <Notice>
          Could not load goals.{' '}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Retry loading goals"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            Try again
          </Button>
        </Notice>
      )}
      {(['active', 'completed'] as const).map((item) => (
        <div
          key={item}
          role="tabpanel"
          id={`${tabsId}-panel-${item}`}
          aria-labelledby={`${tabsId}-tab-${item}`}
          hidden={view !== item}
          tabIndex={view === item ? 0 : -1}
        >
          {view === item &&
            (!goals ? (
              loading ? (
                <div role="status">
                  <Loading label="Loading goals…" />
                </div>
              ) : null
            ) : view === 'completed' ? (
              completed.length ? (
                <div className="saved-plan-list">
                  {completed.map((goal) => (
                    <GoalRow key={goal.id} goal={goal} />
                  ))}
                </div>
              ) : (
                <div className="secondary-empty">
                  <h2>No completed goals yet</h2>
                  <p>Goals you finish will appear here.</p>
                </div>
              )
            ) : (
              <>
                {active.length ? (
                  <div className="saved-plan-list">
                    {active.map((goal) => (
                      <GoalRow key={goal.id} goal={goal} />
                    ))}
                  </div>
                ) : (
                  <div className="secondary-empty">
                    <h2>{goals.length ? 'No active goals' : 'No goals yet'}</h2>
                    <p>
                      {paused.length
                        ? 'Resume a paused goal or start something new.'
                        : 'Choose something to work toward and add your next step.'}
                    </p>
                  </div>
                )}
                {paused.length > 0 && (
                  <details className="goals-paused" open={!active.length}>
                    <summary>
                      Paused <span>{paused.length}</span>
                    </summary>
                    <div className="saved-plan-list">
                      {paused.map((goal) => (
                        <GoalRow key={goal.id} goal={goal} />
                      ))}
                    </div>
                  </details>
                )}
              </>
            ))}
        </div>
      ))}
    </div>
  );
}
