import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './app-global.css'   // Fix 4: static CSS replacing runtime style injections
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
