import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DisplayApp } from './DisplayApp';
import { bootAppearance } from './theme/appearance';
import './awards.css';
import './display.css';
import './ceremony.css';

// The organizer's theme arrives in the page URL, so the first paint already matches it.
bootAppearance();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
createRoot(container).render(
  <StrictMode>
    <DisplayApp />
  </StrictMode>,
);
