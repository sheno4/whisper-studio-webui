import { MotionConfig } from 'framer-motion';
import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { initializeAppearance } from './hooks/useAppearance';
import './web-api';
import './styles/lens.css';
import './styles/glass.css';
import './studio/studio.css';
import './studio/content.css';
import './studio/workbench.css';
import './styles/segments.css';
import './styles/scroll-edge.css';
import './styles/switches.css';
import './styles/rdev.css';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const showFatalError = (message: string): void => {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  root.innerHTML = `
    <section class="studio-startup">
      <article>
        <p class="studio-eyebrow">WebUI Error</p>
        <h1>Whisper Studio WebUI 启动失败</h1>
        <pre>${escapeHtml(message)}</pre>
        <div class="studio-confirm-actions">
          <button class="studio-button studio-primary" id="fatal-reload">重新加载</button>
          <button class="studio-button" id="fatal-close">关闭页面</button>
        </div>
      </article>
    </section>
  `;

  document.getElementById('fatal-reload')?.addEventListener('click', () => {
    window.location.reload();
  });

  document.getElementById('fatal-close')?.addEventListener('click', () => {
    window.close();
  });
};

// A failed background operation must not tear down a healthy React workspace.
// API actions display their own errors; only a render failure reaches this UI.
class RenderBoundary extends React.Component<React.PropsWithChildren, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error): { error: Error } { return { error }; }
  componentDidCatch(error: Error): void { console.error('Whisper Studio render failure', error); }
  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return <section className="studio-startup" role="alert">
      <h1>工作台遇到了问题</h1>
      <p>任务会继续在后台处理，重新加载即可再次连接。</p>
      <pre className="studio-fatal-details">{this.state.error.message}</pre>
      <button className="studio-button studio-primary" onClick={() => window.location.reload()}>重新加载</button>
    </section>;
  }
}

try {
  initializeAppearance();
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <MotionConfig reducedMotion="user">
        <RenderBoundary><App /></RenderBoundary>
      </MotionConfig>
    </React.StrictMode>
  );
} catch (error) {
  showFatalError(error instanceof Error ? error.stack || error.message : String(error));
}
