import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles.css';
import { App } from './App';
import { createFirebaseApi } from './firebaseApi';
import { I18nProvider } from './i18n';

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');
const api = createFirebaseApi();
createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App api={api} />
    </I18nProvider>
  </StrictMode>,
);
