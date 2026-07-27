import { mount } from 'svelte';
import '@fontsource-variable/inter';
import './app.css';
import App from './App.svelte';

const app = mount(App, { target: document.getElementById('root') });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

export default app;
