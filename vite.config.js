import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// El front habla con la API siempre por /api, mismo origen. En dev lo resuelve
// este proxy; en producción, el server.js que sirve el build y reenvía por la
// red privada de Railway. Mantener los dos entornos iguales es lo que permite
// usar cookies SameSite=Lax sin excepciones para desarrollo.
export default defineConfig(({ mode }) => {
  // process.env NO se llena solo con los .env: Vite los expone al cliente vía
  // import.meta.env, pero para leerlos acá dentro hace falta loadEnv.
  const env = loadEnv(mode, process.cwd(), '')

  // El proxy conserva la ruta completa del request (/api/auth/me), así que el
  // target tiene que ser sólo el origen. Si viniera con /api al final, el
  // backend recibiría /api/api/auth/me y respondería 404 a todo.
  const target = new URL(env.VITE_DEV_API_TARGET || 'http://localhost:3000').origin

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target, changeOrigin: true },
      },
    },
  }
})
