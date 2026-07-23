import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Stamp the build with the commit it was built from and where the repo lives,
// so the installed app can tell when the repo has moved past it (sidebar
// version footer, src/main/app-version.ts).
let buildHash = ''
try {
  buildHash = execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim()
} catch {
  /* not a git checkout — footer stays hidden */
}

export default defineConfig({
  main: {
    define: {
      __BUILD_HASH__: JSON.stringify(buildHash),
      __REPO_PATH__: JSON.stringify(__dirname)
    }
  },
  preload: {},
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          // Main app window + the floating voice HUD (SPEC-TODOS §6)
          index: resolve(__dirname, 'src/renderer/index.html'),
          hud: resolve(__dirname, 'src/renderer/hud.html')
        }
      }
    }
  }
})
