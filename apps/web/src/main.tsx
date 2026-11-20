import { lazy, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHttpApi } from './api';
import { App } from './App';
import { SurfaceBoundary } from './components';
import './styles.css';

const PlatformPreview = lazy(() => import('./PlatformPreview').then(({ PlatformPreview }) => ({ default: PlatformPreview })));

const platformPreview = new URLSearchParams(window.location.search).get('preview') === 'm10';
const mock = import.meta.env.VITE_USE_MOCK === 'true';
const apiBase = import.meta.env.VITE_API_BASE_URL?.trim() || '/api';
const api = platformPreview ? undefined : mock ? (await import('./mock')).createMockApi() : createHttpApi(apiBase);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {api ? <App api={api} apiBase={mock ? window.location.origin : apiBase} mock={mock} />
      : <SurfaceBoundary loadingText="正在開啟合成資料預覽…"><PlatformPreview /></SurfaceBoundary>}
  </StrictMode>,
);
