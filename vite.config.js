import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

/*
 * Backoffice de Stocker — app separada de la que usan los negocios.
 *
 * Separada a propósito, no por prolijidad:
 *
 *   · La sesión de un operador y la de un dueño usan la misma cookie
 *     (`stockerToken`). Si las dos apps compartieran origen, entrar al
 *     backoffice cerraría la sesión del negocio y al revés.
 *   · El código de administración no se le entrega al navegador de cada
 *     cliente. La API valida igual, pero no hay razón para publicar la
 *     superficie interna.
 *
 * Corre en 5174 para poder tener las dos levantadas a la vez en desarrollo.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = new URL(env.VITE_DEV_API_TARGET || 'http://localhost:3000').origin

  return {
    plugins: [react()],
    server: {
      port: 5174,
      proxy: {
        '/api': { target, changeOrigin: true },
      },
    },
  }
})
