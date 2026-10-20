import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './demo.css';
import { App } from './App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('demo: 找不到 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
