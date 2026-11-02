import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './mobile.css'
import App from './App.tsx'
import { startAutoUpdate } from './autoUpdate'
import { startEscapeClose } from './escapeClose'
import { installAudioUnlock } from './audioUnlock'

// In the desktop app the title bar is hidden, so the page draws its own drag strip
const desktop = (window as any).velcordDesktop;
if (desktop?.isDesktop) {
  // Only the new shell has no title bar; the old one would get an extra empty strip
  if ((desktop.shellVersion ?? 1) >= 2) document.documentElement.classList.add('desktop-app', `desktop-${desktop.platform}`);
  document.title = '\u200B'; // nothing to show in a window title, and never the app name
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

startAutoUpdate()
startEscapeClose()
installAudioUnlock()

// Phones report the page height wrongly while the browser bars or the keyboard move (the bottom bar of the menu
// was cut off on an iPhone). The real visible height is measured and used for the layout.
function setAppHeight() {
  const h = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${Math.round(h)}px`);
}
setAppHeight();
window.addEventListener('resize', setAppHeight);
window.addEventListener('orientationchange', () => setTimeout(setAppHeight, 200));
window.visualViewport?.addEventListener('resize', setAppHeight);
