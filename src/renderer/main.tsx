import { MotionConfig } from 'framer-motion';
import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import './web-api';
import './styles/app.css';

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
    <section class="fatal-screen">
      <article class="fatal-card glass-float">
        <p class="eyebrow">WebUI Error</p>
        <h1>Whisper Studio WebUI 启动失败</h1>
        <pre>${escapeHtml(message)}</pre>
        <div class="fatal-actions">
          <button class="primary-button" id="fatal-reload">重新加载</button>
          <button class="ghost-button" id="fatal-close">关闭页面</button>
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

window.addEventListener('error', (event) => {
  showFatalError(event.error?.stack || event.message || 'Unknown renderer error');
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.stack || event.reason.message : String(event.reason);
  showFatalError(reason);
});

try {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </React.StrictMode>
  );
} catch (error) {
  showFatalError(error instanceof Error ? error.stack || error.message : String(error));
}
