import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, Wrench } from 'lucide-react';
import type {
  InspectorObservationsResponse,
  InspectorToolsResponse,
  ModelUsage,
  ToolCall,
} from '../../shared/inspector';
import { api, errorMessage } from '../lib/api';
import {
  filterToolCalls,
  completeObservationRefresh,
  formatInspectorJson,
  formatModelCost,
  formatToolDuration,
  mergeObservationPage,
  type ToolStatusFilter,
} from '../lib/inspector-observations';
import { Button, Input, Loading, Notice } from './ui';

const statuses: ToolCall['status'][] = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
];
const counts = new Intl.NumberFormat('en-US');

function RecordedJson({ label, value }: { label: string; value: unknown }) {
  return (
    <section className="inspector-payload">
      <h4>{label}</h4>
      <pre tabIndex={0} aria-label={`${label} JSON`}>
        <code>{formatInspectorJson(value)}</code>
      </pre>
    </section>
  );
}

export function ToolCallRecord({ call }: { call: ToolCall }) {
  return (
    <details className={`inspector-record inspector-call-${call.status}`}>
      <summary>
        <ChevronDown size={13} className="inspector-disclosure" />
        <span className="inspector-record-title">
          <strong>{call.name}</strong>
          <small>
            {new Date(call.startedAt).toLocaleTimeString()} · revision {call.revision}
          </small>
        </span>
        <span className="inspector-record-state">
          <span className={`inspector-status inspector-status-${call.status}`}>{call.status}</span>
          <small>
            {call.status === 'running' ? 'In progress' : formatToolDuration(call.durationMs)}
          </small>
        </span>
      </summary>
      <div className="inspector-record-body">
        <dl className="inspector-record-facts">
          <dt>Started</dt>
          <dd>{new Date(call.startedAt).toLocaleString()}</dd>
          <dt>Finished</dt>
          <dd>{call.finishedAt ? new Date(call.finishedAt).toLocaleString() : 'Not recorded'}</dd>
          <dt>Duration</dt>
          <dd>{call.status === 'running' ? 'In progress' : formatToolDuration(call.durationMs)}</dd>
        </dl>
        <p className="inspector-data-note">Private developer data · redacted before storage.</p>
        <RecordedJson label="Input" value={call.input} />
        {call.output === null && call.status !== 'succeeded' ? (
          <p className="inspector-empty">
            {call.status === 'running'
              ? 'Waiting for tool output.'
              : 'No tool output was recorded.'}
          </p>
        ) : (
          <RecordedJson label="Output" value={call.output} />
        )}
        {call.error && (
          <section className="inspector-payload inspector-error">
            <h4>Error</h4>
            <pre>{call.error}</pre>
          </section>
        )}
      </div>
    </details>
  );
}

export function ModelUsageSummary({
  summary,
}: {
  summary: InspectorObservationsResponse['summary'];
}) {
  if (!summary.calls && !summary.modelRequests)
    return (
      <p className="inspector-empty">
        No tool or model recordings for this task. Older tasks are not backfilled, and expired
        records are removed.
      </p>
    );
  return (
    <section className="inspector-usage-summary" aria-label="Retained task model usage">
      <div className="inspector-cost-heading">
        <span>Assistant model requests · SDK estimate</span>
        <strong>{formatModelCost(summary.knownCostUsd)}</strong>
      </div>
      <p className="inspector-data-note">
        USD estimate for recorded assistant model requests. Compaction, cache warming, speech,
        browser-provider, other tool/provider fees, and hosting charges are excluded. This is not an
        invoice total.
      </p>
      {summary.unpricedRequests > 0 && (
        <p className="inspector-unpriced">
          {counts.format(summary.unpricedRequests)} model{' '}
          {summary.unpricedRequests === 1 ? 'request has' : 'requests have'} no price estimate
          {summary.knownCostUsd === null ? '.' : '; the estimate is partial.'}
        </p>
      )}
      <dl className="inspector-usage-grid">
        <div>
          <dt>Tool calls</dt>
          <dd>{counts.format(summary.calls)}</dd>
        </div>
        <div>
          <dt>Model requests</dt>
          <dd>{counts.format(summary.modelRequests)}</dd>
        </div>
        <div>
          <dt>Input tokens</dt>
          <dd>{counts.format(summary.inputTokens)}</dd>
        </div>
        <div>
          <dt>Output tokens</dt>
          <dd>{counts.format(summary.outputTokens)}</dd>
        </div>
        <div>
          <dt>Cache read</dt>
          <dd>{counts.format(summary.cacheReadTokens)}</dd>
        </div>
        <div>
          <dt>Cache write</dt>
          <dd>{counts.format(summary.cacheWriteTokens)}</dd>
        </div>
        <div>
          <dt>Total tokens</dt>
          <dd>{counts.format(summary.totalTokens)}</dd>
        </div>
      </dl>
    </section>
  );
}

export function ModelUsageRecord({ usage }: { usage: ModelUsage }) {
  return (
    <details className="inspector-record">
      <summary>
        <ChevronDown size={13} className="inspector-disclosure" />
        <span className="inspector-record-title">
          <strong>{usage.model}</strong>
          <small>
            {usage.provider} · revision {usage.revision} ·{' '}
            {new Date(usage.createdAt).toLocaleTimeString()}
          </small>
        </span>
        <span className="inspector-record-state">
          <span>{formatModelCost(usage.costSource === 'sdk_estimate' ? usage.costUsd : null)}</span>
          <small>{counts.format(usage.totalTokens)} tokens</small>
        </span>
      </summary>
      <div className="inspector-record-body">
        <p className="inspector-data-note">
          {usage.costSource === 'sdk_estimate'
            ? 'Model request estimate from the SDK, in USD. Not a tool-call charge.'
            : 'No SDK price estimate is available for this assistant model request.'}
        </p>
        <dl className="inspector-usage-grid">
          <div>
            <dt>Input tokens</dt>
            <dd>{counts.format(usage.inputTokens)}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>{counts.format(usage.outputTokens)}</dd>
          </div>
          <div>
            <dt>Cache read</dt>
            <dd>{counts.format(usage.cacheReadTokens)}</dd>
          </div>
          <div>
            <dt>Cache write</dt>
            <dd>{counts.format(usage.cacheWriteTokens)}</dd>
          </div>
          <div>
            <dt>Total tokens</dt>
            <dd>{counts.format(usage.totalTokens)}</dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

export function InspectorTools({ taskId }: { taskId?: string }) {
  const [catalog, setCatalog] = useState<InspectorToolsResponse | null>(null);
  const [observations, setObservations] = useState<InspectorObservationsResponse | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [observationError, setObservationError] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ToolStatusFilter>('all');
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);
  const observationsRef = useRef<InspectorObservationsResponse | null>(null);
  const loadedEarlier = useRef(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const request = new AbortController();
    setCatalogError('');
    void api<InspectorToolsResponse>('/api/inspector/tools', { signal: request.signal })
      .then((next) => {
        if (!request.signal.aborted) setCatalog(next);
      })
      .catch((cause) => {
        if (!request.signal.aborted) setCatalogError(errorMessage(cause));
      });
    return () => request.abort();
  }, [catalogAttempt]);

  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    let timer: ReturnType<typeof setTimeout>;
    loadedEarlier.current = false;
    observationsRef.current = null;
    busy.current = false;
    setObservations(null);
    setObservationError('');
    setLoadingEarlier(false);
    setRefreshing(false);
    async function refresh() {
      if (!taskId || request.signal.aborted) return;
      if (document.hidden || busy.current) {
        timer = setTimeout(() => void refresh(), 2500);
        return;
      }
      busy.current = true;
      setRefreshing(true);
      try {
        const next = await api<InspectorObservationsResponse>(
          `/api/inspector/observations?taskId=${encodeURIComponent(taskId)}`,
          { signal: request.signal },
        );
        if (request.signal.aborted) return;
        const current = observationsRef.current;
        const result =
          current && loadedEarlier.current
            ? await completeObservationRefresh(
                current,
                next,
                async (cursor) => {
                  const params = new URLSearchParams({ taskId, before: cursor.before });
                  if (cursor.beforeId) params.set('beforeId', cursor.beforeId);
                  return api<InspectorObservationsResponse>(
                    `/api/inspector/observations?${params}`,
                    { signal: request.signal },
                  );
                },
                request.signal,
              )
            : { data: next, reset: true };
        if (request.signal.aborted) return;
        if (result.reset) loadedEarlier.current = false;
        observationsRef.current = result.data;
        setObservations(result.data);
        setObservationError('');
      } catch (cause) {
        if (!request.signal.aborted) setObservationError(errorMessage(cause));
      } finally {
        if (!request.signal.aborted && taskId) {
          busy.current = false;
          setRefreshing(false);
          timer = setTimeout(() => void refresh(), 2500);
        }
      }
    }
    void refresh();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [taskId]);

  async function loadEarlier() {
    if (!taskId || !observations?.hasOlder || !observations.nextBefore || busy.current) return;
    const request = controller.current;
    if (!request || request.signal.aborted) return;
    busy.current = true;
    setLoadingEarlier(true);
    const params = new URLSearchParams({ taskId, before: observations.nextBefore });
    if (observations.nextBeforeId) params.set('beforeId', observations.nextBeforeId);
    try {
      const next = await api<InspectorObservationsResponse>(
        `/api/inspector/observations?${params}`,
        { signal: request.signal },
      );
      if (request.signal.aborted) return;
      loadedEarlier.current = true;
      const current = observationsRef.current;
      const merged = current ? mergeObservationPage(current, next, 'older') : next;
      observationsRef.current = merged;
      setObservations(merged);
      setObservationError('');
    } catch (cause) {
      if (!request.signal.aborted) setObservationError(errorMessage(cause));
    } finally {
      if (!request.signal.aborted) {
        busy.current = false;
        setLoadingEarlier(false);
      }
    }
  }

  const calls = useMemo(
    () => filterToolCalls(observations?.calls ?? [], query, status),
    [observations, query, status],
  );
  const search = query.trim().toLocaleLowerCase();
  const tools =
    catalog?.tools.filter(
      (tool) =>
        !search ||
        [tool.name, tool.description, formatInspectorJson(tool.parameters)].some((text) =>
          text.toLocaleLowerCase().includes(search),
        ),
    ) ?? [];

  return (
    <div className="inspector-tools">
      {catalog && (
        <p className="inspector-data-note">
          {catalog.captureEnabled ? 'Capture enabled' : 'Capture disabled'} · private developer data
          · {catalog.retentionDays}-day retention ·{' '}
          {counts.format(catalog.payloadLimitBytes / 1024)} KiB per payload. Payloads are redacted;
          images are omitted.
        </p>
      )}
      <div className="inspector-tool-filters">
        <label className="inspector-search">
          <Search size={14} />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tools and recorded calls"
            aria-label="Search tools and recorded calls"
          />
        </label>
        <label className="inspector-status-filter">
          <span>Call status</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as ToolStatusFilter)}
          >
            <option value="all">All statuses</option>
            {statuses.map((value) => (
              <option key={value} value={value}>
                {value[0].toUpperCase() + value.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {taskId ? (
        <>
          {observationError && <Notice>{observationError}</Notice>}
          {!observations && !observationError && <Loading label="Loading task recordings…" />}
          {observations && (
            <>
              <ModelUsageSummary summary={observations.summary} />
              <section className="inspector-section">
                <h3>
                  Tool calls{' '}
                  <span>
                    {calls.length} shown · {counts.format(observations.summary.calls)} retained
                  </span>
                </h3>
                <div className="inspector-record-list">
                  {calls.map((call) => (
                    <ToolCallRecord key={call.id} call={call} />
                  ))}
                </div>
                {!calls.length && (
                  <p className="inspector-empty">
                    {observations.calls.length
                      ? 'No loaded calls match this search and status.'
                      : 'No tool calls recorded for this task.'}
                  </p>
                )}
              </section>
              <section className="inspector-section">
                <h3>
                  Model requests{' '}
                  <span>
                    {observations.usage.length} loaded ·{' '}
                    {counts.format(observations.summary.modelRequests)} retained
                  </span>
                </h3>
                <p className="inspector-data-note">
                  Associated with this task and revision. A model request can produce several tool
                  calls; costs are not assigned to individual tools.
                </p>
                <div className="inspector-record-list">
                  {observations.usage.map((usage) => (
                    <ModelUsageRecord key={usage.id} usage={usage} />
                  ))}
                </div>
                {!observations.usage.length && (
                  <p className="inspector-empty">No model usage recorded in this page.</p>
                )}
              </section>
              {observations.hasOlder && (
                <div className="inspector-pagination">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingEarlier || refreshing}
                    onClick={() => void loadEarlier()}
                  >
                    {loadingEarlier ? 'Loading…' : 'Load earlier recordings'}
                  </Button>
                  <p className="inspector-data-note">
                    Search and status filters apply to loaded calls. Totals cover all retained
                    records.
                  </p>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <p className="inspector-empty">Choose a task to inspect recorded calls and model usage.</p>
      )}
      <section className="inspector-section inspector-catalog">
        <h3>
          <Wrench size={14} />
          Registered tools{' '}
          <span>
            {tools.length}
            {catalog && tools.length !== catalog.tools.length ? ` of ${catalog.tools.length}` : ''}
          </span>
        </h3>
        <p className="inspector-data-note">
          Current runtime definitions. Registration does not mean a tool ran for this task.
        </p>
        {catalogError && (
          <>
            <Notice>{catalogError}</Notice>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCatalogAttempt((value) => value + 1)}
            >
              Retry tool definitions
            </Button>
          </>
        )}
        {!catalog && !catalogError && <Loading label="Loading tool definitions…" />}
        <div className="inspector-record-list">
          {tools.map((tool) => (
            <details className="inspector-record" key={tool.name}>
              <summary>
                <ChevronDown size={13} className="inspector-disclosure" />
                <span className="inspector-record-title">
                  <strong>{tool.name}</strong>
                </span>
              </summary>
              <div className="inspector-record-body">
                <p className="inspector-tool-description">{tool.description}</p>
                <RecordedJson label="Input schema" value={tool.parameters} />
              </div>
            </details>
          ))}
        </div>
        {catalog && !tools.length && (
          <p className="inspector-empty">
            {search ? 'No registered tools match this search.' : 'No tools are registered.'}
          </p>
        )}
      </section>
    </div>
  );
}
