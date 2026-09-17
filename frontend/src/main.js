import { mount } from 'svelte';
import '@fontsource-variable/inter';
import './app.css';
import App from './App.svelte';

// The installed iOS app carries a solid strip above the shell (app.css,
// html.ios-standalone). navigator.standalone only exists on iOS WebKit, so
// Android's installed app — no system blur to hide — is left alone.
if (navigator.standalone === true) document.documentElement.classList.add('ios-standalone');

const app = mount(App, { target: document.getElementById('root') });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

export default app;
