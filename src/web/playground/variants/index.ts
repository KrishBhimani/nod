import type { ComponentType } from 'react';
import { Ask } from './ask';
import { ChevronPages } from './chevron-pages';
import { Focused } from './focused';
import { OneCard } from './one-card';
import { PasteKey } from './paste-key';
import { RowActions } from './row-actions';
import { SignInFirst } from './sign-in-first';

export type VariantOption = 'collapse' | 'split' | 'column' | 'noDivider';

export const optionLabels: Record<VariantOption, string> = {
  collapse: 'Collapse less common providers',
  split: 'Separate ChatGPT plan and OpenAI API rows',
  column: 'Sign in shortcut, API key in the right column',
  noDivider: 'Hide the divider',
};

export const optionRequires: Partial<Record<VariantOption, VariantOption>> = {
  noDivider: 'column',
};

export type VariantProps = {
  intro: boolean;
  options?: Partial<Record<VariantOption, boolean>>;
  onNext(): void;
  onBack(): void;
};

export type Variant =
  | 'current'
  | 'focused'
  | 'sign-in-first'
  | 'one-card'
  | 'row-actions'
  | 'chevron-pages'
  | 'paste-key'
  | 'ask';

export const variants: Record<
  Variant,
  {
    name: string;
    idea: string;
    options?: VariantOption[];
    component?: ComponentType<VariantProps>;
  }
> = {
  current: {
    name: 'Current',
    idea: 'The real onboarding step, which now ships design B4.',
  },
  focused: {
    name: 'A · Focused list',
    idea: 'Smallest change. The three providers most people use stay on top, the rest fold under “More providers”. A chevron instead of a radio, because a row opens rather than selects.',
    component: Focused,
  },
  'sign-in-first': {
    name: 'B · Sign-in first',
    idea: 'The easiest path gets the most space: one ChatGPT card with a primary button. Everything else is a compact grid of tiles that opens one form at a time.',
    component: SignInFirst,
  },
  'one-card': {
    name: 'B2 · One card',
    idea: 'One white card. First a plain list of providers, then the card turns into a page for the chosen one, with a back button at the top left. Only one decision is on screen at a time.',
    options: ['collapse', 'split'],
    component: OneCard,
  },
  'row-actions': {
    name: 'B3 · Sign in on the row',
    idea: 'Like B2, but OpenAI and OpenRouter keep one row each with the recommended action right on it: Sign in, with a quieter API key button beside it that opens the key page. Other providers open their page as in B2.',
    options: ['collapse', 'column', 'noDivider'],
    component: RowActions,
  },
  'chevron-pages': {
    name: 'B4 · Chevrons only',
    idea: 'The quietest list: every row is just a logo, a name and a chevron. The page decides. OpenAI and OpenRouter open on a prominent sign-in button with a quiet “Use an API key instead” that reveals the key form below. Other providers open straight on their key setup.',
    options: ['collapse'],
    component: ChevronPages,
  },
  'paste-key': {
    name: 'C · One key field',
    idea: 'No provider list at all. Two sign-in buttons, then a single field that recognises the key from its prefix and asks only when it can’t tell. Cloud fields appear only when the key needs them.',
    component: PasteKey,
  },
  ask: {
    name: 'D · Ask what you have',
    idea: 'Fits the chat style of onboarding. nod asks what you already pay for and answers with the one next step, including an honest reply for Claude plans, which can’t be used.',
    component: Ask,
  },
};
