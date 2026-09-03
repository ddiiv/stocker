import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AdminAuthProvider, useAdmin } from "./context/AdminAuth";
import Shell from "./components/Shell";
import LoginPage from "./pages/LoginPage";
import ActivarTotpPage from "./pages/ActivarTotpPage";
import ResumenPage from "./pages/ResumenPage";
import CuentasPage from "./pages/CuentasPage";
import CuentaDetallePage from "./pages/CuentaDetallePage";
import PlanesPage from "./pages/PlanesPage";
import CobrosPage from "./pages/CobrosPage";
import ArcaPage from "./pages/ArcaPage";
import SeguridadPage from "./pages/SeguridadPage";
import AjustesPage from "./pages/AjustesPage";
import { Cargando } from "./components/ui";

/*
 * Puerta de la aplicación.
 *
 * Mientras la sonda de sesión no terminó no se decide nada: pintar el login
 * durante ese instante haría parpadear la pantalla de acceso a alguien que ya
 * estaba adentro.
 */
function Privado({ children }) {
  const { admin, cargando } = useAdmin();
  if (cargando) return <div className="flex min-h-screen items-center justify-center"><Cargando texto="Verificando sesión…" /></div>;
  if (!admin) return <Navigate to="/login" replace />;
  return children;
}

function Publico({ children }) {
  const { admin, cargando } = useAdmin();
  if (cargando) return <div className="flex min-h-screen items-center justify-center"><Cargando /></div>;
  if (admin) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <AdminAuthProvider>
        <Routes>
          <Route path="/login"   element={<Publico><LoginPage /></Publico>} />
          {/* La activación queda abierta: se autoriza con el token de alta,
              porque antes de activar el segundo factor no hay sesión posible. */}
          <Route path="/activar" element={<ActivarTotpPage />} />

          <Route element={<Privado><Shell /></Privado>}>
            <Route path="/"             element={<ResumenPage />} />
            <Route path="/cuentas"      element={<CuentasPage />} />
            <Route path="/cuentas/:id"  element={<CuentaDetallePage />} />
            <Route path="/planes"       element={<PlanesPage />} />
            <Route path="/cobros"       element={<CobrosPage />} />
            <Route path="/arca"         element={<ArcaPage />} />
            <Route path="/seguridad"    element={<SeguridadPage />} />
            <Route path="/ajustes"      element={<AjustesPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AdminAuthProvider>
    </BrowserRouter>
  );
}
