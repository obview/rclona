import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// 深浅主题：渲染前先读本地偏好定好，避免首屏闪一下再变色（默认深色）
try {
  const saved = localStorage.getItem('rclona-theme');
  document.documentElement.dataset.theme = saved === 'light' || saved === 'dark' ? saved : 'dark';
} catch { document.documentElement.dataset.theme = 'dark'; }

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
