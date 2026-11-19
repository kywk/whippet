import { lazy, Suspense } from 'react';

const Markdown = lazy(() => import('react-markdown'));

export function VersionMarkdown({ text }: { text: string }) {
  return <div className="version-markdown">
    <Suspense fallback={<p>{text}</p>}><Markdown disallowedElements={['img']}>{text}</Markdown></Suspense>
  </div>;
}
