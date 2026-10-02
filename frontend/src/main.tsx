import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import PhoneApp from './phone/PhoneApp'
import { registerServiceWorker } from './phone/sw-register'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

// `vite build --mode phone` makes the iPhone app (GitHub Pages); the default build is the PC app.
const isPhone = import.meta.env.MODE === 'phone'
if (isPhone) registerServiceWorker()

createRoot(root).render(<StrictMode>{isPhone ? <PhoneApp /> : <App />}</StrictMode>)
