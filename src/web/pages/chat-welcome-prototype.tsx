import { ArrowUpRight, FlaskConical, Plug } from 'lucide-react';
import type { Connection } from '../../shared/contracts';
import {
  integrationServiceIds,
  integrationServices,
  type IntegrationService,
} from '../../shared/integrations';
import { BrandMark } from '../components/brand';
import { usePageData } from '../hooks/use-page-data';

export type WelcomeVariant = 'A' | 'B' | 'C';
const variants: Record<WelcomeVariant, string> = {
  A: 'Greeting',
  B: 'App cards',
  C: 'Quiet chat',
};
const appSuggestions: Record<IntegrationService, string> = {
  gmail: 'Summarize my unread email',
  googlecalendar: 'Plan my day from my calendar',
  googledrive: 'Find a file in Google Drive',
  googlesheets: 'Review a spreadsheet',
  googledocs: 'Summarize a document',
  slack: 'Catch me up on Slack',
  notion: 'Find a page in Notion',
  linear: 'Show my open Linear issues',
};
const starterSuggestions = ['Plan my day', 'Help me research something', 'Start a goal'];

export function welcomeVariant(): WelcomeVariant {
  const value = new URLSearchParams(window.location.search).get('variant');
  return value === 'B' || value === 'C' ? value : 'A';
}

function useConnectedApps() {
  const { data, loading } = usePageData<Connection[]>('/api/apps');
  return {
    loading,
    connected: integrationServiceIds.filter((slug) =>
      data?.some((connection) => connection.slug === slug && connection.status === 'connected'),
    ),
  };
}

export function welcomeSuggestions(text: string) {
  return text
    .split('\n')
    .map((line) => /^\s*(?:\d+[.)]|[-*])\s+(.+)$/.exec(line)?.[1])
    .filter((line): line is string => Boolean(line))
    .slice(0, 3)
    .map((line) => {
      const labelled = /^\*\*([^*]+?):?\*\*:?\s*(.+)$/.exec(line);
      return {
        app: labelled?.[1].trim(),
        text: (labelled?.[2] ?? line).replace(/\*\*/g, '').replace(/\.$/, '').trim(),
      };
    });
}

function Logo({ slug }: { slug: IntegrationService }) {
  return <img src={`/logos/${slug}.svg`} alt="" width={16} height={16} />;
}

function Dots() {
  return (
    <span className="thinking-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function Chips({ labels, onPick }: { labels: string[]; onPick(label: string): void }) {
  return (
    <div className="starter-actions">
      {labels.map((label) => (
        <button key={label} onClick={() => onPick(label)}>
          {label}
          <ArrowUpRight size={15} />
        </button>
      ))}
    </div>
  );
}

function appNames(connected: IntegrationService[]) {
  const names = connected.map((slug) => integrationServices[slug].name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
}

export function ChatWelcome({
  variant,
  status,
  onPick,
}: {
  variant: WelcomeVariant;
  status?: string;
  onPick(label: string): void;
}) {
  const { loading, connected } = useConnectedApps();
  const labels = [...connected.map((slug) => appSuggestions[slug]), ...starterSuggestions].slice(
    0,
    3,
  );
  if (variant === 'B') {
    const cards: Array<{ slug?: IntegrationService; label: string; connect?: boolean }> = [
      ...connected.map((slug) => ({ slug, label: appSuggestions[slug] })),
      ...(['gmail', 'googlecalendar'] as const)
        .filter((slug) => !connected.includes(slug))
        .map((slug) => ({ slug, label: integrationServices[slug].description, connect: true })),
      ...starterSuggestions.map((label) => ({ label })),
    ].slice(0, 3);
    return (
      <div className="welcome-flow">
        <div className="welcome-flow-intro">
          <div className="assistant-mark">
            <BrandMark small />
          </div>
          {status ? (
            <p role="status" aria-label={status}>
              {connected.length
                ? `Looking at ${appNames(connected)}`
                : 'Getting your first suggestions'}
              <Dots />
            </p>
          ) : (
            <p>Start with your apps, or ask anything.</p>
          )}
        </div>
        {!loading && (
          <div className={`welcome-cards${status ? ' welcome-cards-pending' : ''}`}>
            {(status
              ? connected.length
                ? connected.slice(0, 3).map((slug) => ({ slug, label: '', connect: false }))
                : [{ label: '' }, { label: '' }, { label: '' }]
              : cards
            ).map((card, index) =>
              status ? (
                <div key={card.slug ?? index} className="welcome-card" aria-hidden="true">
                  <span className="welcome-card-app">
                    {card.slug && <Logo slug={card.slug} />}
                    {card.slug ? integrationServices[card.slug].name : 'Otto'}
                  </span>
                  <span className="welcome-card-line" />
                  <span className="welcome-card-line short" />
                </div>
              ) : card.connect && card.slug ? (
                <a key={card.slug} className="welcome-card" href="/apps">
                  <span className="welcome-card-app">
                    <Logo slug={card.slug} />
                    {integrationServices[card.slug].name}
                  </span>
                  <span className="welcome-card-text">{card.label}</span>
                  <span className="welcome-card-action">
                    <Plug size={14} />
                    Connect
                  </span>
                </a>
              ) : (
                <button
                  key={card.label}
                  className="welcome-card"
                  onClick={() => onPick(card.label)}
                >
                  <span className="welcome-card-app">
                    {card.slug ? <Logo slug={card.slug} /> : <BrandMark small />}
                    {card.slug ? integrationServices[card.slug].name : 'Otto'}
                  </span>
                  <span className="welcome-card-text">{card.label}</span>
                  <span className="welcome-card-action">
                    Try this
                    <ArrowUpRight size={14} />
                  </span>
                </button>
              ),
            )}
          </div>
        )}
      </div>
    );
  }
  if (variant === 'C')
    return (
      <div className="welcome-quiet">
        {status ? (
          <div className="thinking" role="status" aria-label={status}>
            <div className="assistant-mark">
              <BrandMark small />
            </div>
            <Dots />
            <span>Otto is writing your first message.</span>
          </div>
        ) : (
          <>
            <div className="welcome-quiet-note">
              <div className="assistant-mark">
                <BrandMark small />
              </div>
              <p>Ask me anything, or pick one of these.</p>
            </div>
            {!loading && <QuickReplies labels={labels} onPick={onPick} />}
          </>
        )}
      </div>
    );
  return (
    <div className="welcome">
      <BrandMark />
      <h1>{status ? 'Otto is looking at your apps.' : 'What’s on your mind?'}</h1>
      {status ? (
        <div className="welcome-status" role="status" aria-label={status}>
          {connected.length > 0 && (
            <div className="welcome-apps">
              {connected.slice(0, 4).map((slug) => (
                <span key={slug}>
                  <Logo slug={slug} />
                  {integrationServices[slug].name}
                </span>
              ))}
            </div>
          )}
          <Dots />
        </div>
      ) : (
        !loading && <Chips labels={labels} onPick={onPick} />
      )}
    </div>
  );
}

function QuickReplies({ labels, onPick }: { labels: string[]; onPick(label: string): void }) {
  return (
    <div className="quick-replies">
      {labels.map((label) => (
        <button key={label} onClick={() => onPick(label)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function FirstMessageSuggestions({
  variant,
  text,
  onPick,
}: {
  variant: WelcomeVariant;
  text: string;
  onPick(label: string): void;
}) {
  const suggestions = welcomeSuggestions(text);
  if (!suggestions.length) return null;
  if (variant === 'B')
    return (
      <div className="welcome-cards welcome-cards-reply">
        {suggestions.map((suggestion) => {
          const slug = integrationServiceIds.find(
            (id) => integrationServices[id].name === suggestion.app,
          );
          return (
            <button
              key={suggestion.text}
              className="welcome-card"
              onClick={() => onPick(suggestion.text)}
            >
              <span className="welcome-card-app">
                {slug ? <Logo slug={slug} /> : <BrandMark small />}
                {suggestion.app ?? 'Otto'}
              </span>
              <span className="welcome-card-text">{suggestion.text}</span>
              <span className="welcome-card-action">
                Do this
                <ArrowUpRight size={14} />
              </span>
            </button>
          );
        })}
      </div>
    );
  if (variant === 'C')
    return (
      <QuickReplies labels={suggestions.map((suggestion) => suggestion.text)} onPick={onPick} />
    );
  return (
    <div className="welcome-reply-chips">
      <Chips labels={suggestions.map((suggestion) => suggestion.text)} onPick={onPick} />
    </div>
  );
}

export function WelcomeVariantSwitcher({ variant }: { variant: WelcomeVariant }) {
  return (
    <nav className="welcome-prototype-switcher" aria-label="Prototype variants">
      <FlaskConical size={13} aria-hidden="true" />
      {(Object.keys(variants) as WelcomeVariant[]).map((key) => {
        const url = new URL(window.location.href);
        url.searchParams.set('variant', key);
        return (
          <a
            key={key}
            href={`${url.pathname}${url.search}`}
            aria-current={key === variant ? 'true' : undefined}
          >
            {key} · {variants[key]}
          </a>
        );
      })}
    </nav>
  );
}
