import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHttpApi } from './api';
import { App } from './App';
import './styles.css';

const mock = import.meta.env.VITE_USE_MOCK === 'true';
const apiBase = import.meta.env.VITE_API_BASE_URL?.trim() || '/api';
const api = mock ? (await import('./mock')).createMockApi() : createHttpApi(apiBase);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={api} apiBase={mock ? window.location.origin : apiBase} mock={mock} />
  </StrictMode>,
);
