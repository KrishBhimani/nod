import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeTheme } from '../lib/theme';
import { initializeFocusVisibility } from '../lib/focus';
import { FakeSignIn, Playground } from './playground';
import '../styles.css';
import '../theme.css';
import '../pages/onboarding/onboarding.css';
import '../pages/onboarding/steps/brain.css';
import '../components/models.css';
import './playground.css';
import './variants/variants.css';

initializeTheme();
initializeFocusVisibility();

const params = new URLSearchParams(window.location.search);
const attempt = params.get('signin');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {attempt ? (
      <FakeSignIn attempt={attempt} provider={params.get('provider') ?? ''} />
    ) : (
      <Playground />
    )}
  </StrictMode>,
);
