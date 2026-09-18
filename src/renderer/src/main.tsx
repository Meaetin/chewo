import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

/**
 * A file dropped anywhere the chat pane is not.
 *
 * The browser's default is to navigate to it, and on this window — frameless,
 * no back button, no address bar — that page sits on top of the whole app
 * until ⌘R. Main's `will-navigate` guard would refuse the navigation anyway,
 * but refusing it there is a backstop; swallowing it here means nothing ever
 * tries. Only drags carrying files, so an internal card or tab drag still
 * reaches whatever is listening for it.
 */
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (e) => {
    const drag = e as DragEvent
    if (drag.dataTransfer?.types.includes('Files')) drag.preventDefault()
  })
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
