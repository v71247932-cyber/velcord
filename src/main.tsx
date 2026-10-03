import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startAutoUpdate } from './autoUpdate'

// In the desktop app the title bar is hidden, so the page draws its own drag strip
const desktop = (window as any).velcordDesktop;
if (desktop?.isDesktop) document.documentElement.classList.add('desktop-app', `desktop-${desktop.platform}`);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

startAutoUpdate()
