import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bootAppearance } from './theme/appearance';
import './styles.css';
import './awards.css';
import './ceremony.css';

// Theme first, so the first paint is already in the organizer's colours.
const initialAppearance = bootAppearance();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
createRoot(container).render(
  <StrictMode>
    <App initialAppearance={initialAppearance} />
  </StrictMode>,
);
