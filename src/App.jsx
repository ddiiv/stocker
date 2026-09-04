import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { PermissionGuardProvider } from "./context/PermissionGuardContext";
import ProtectedRoute from "./components/layout/ProtectedRoute";
import PermissionRoute from "./components/layout/PermissionRoute";
import OwnerRoute from "./components/layout/OwnerRoute";
import AppLayout from "./components/layout/AppLayout";

import LoginPage from "./pages/LoginPage";

/*
 * Cada pantalla se descarga cuando se entra a ella.
 *
 * Estaban las treinta y cinco importadas de una: un solo archivo de 1,3 MB que
 * el navegador bajaba y parseaba ENTERO antes de dibujar la pantalla de login.
 * La cajera que sólo usa el punto de venta pagaba la descarga del dashboard,
 * de los gráficos, del lector de cámara y de la configuración de ARCA — todo
 * lo que no va a abrir nunca.
 *
 * En el mostrador eso no es una métrica: es la diferencia entre abrir la caja
 * en un segundo o mirar una pantalla en blanco mientras hay gente esperando,
 * en una máquina vieja y con la conexión que haya.
 *
 * El login queda importado de entrada, junto con el armazón: es lo primero que
 * se ve y hacerle esperar un segundo pedido sería cambiar un problema por otro.
 */
const PaymentMethodsPage = lazy(() => import("./pages/PaymentMethodsPage"));
const CashPage = lazy(() => import("./pages/CashPage"));
const AccountPage = lazy(() => import("./pages/AccountPage"));
const SubscriptionPage = lazy(() => import("./pages/SubscriptionPage"));
const RegisterPage = lazy(() => import("./pages/RegisterPage"));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPasswordPage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const StockPage = lazy(() => import("./pages/StockPage"));
const ProductDetailPage = lazy(() => import("./pages/ProductDetailPage"));
const SalesPage = lazy(() => import("./pages/SalesPage"));
const NewSalePage = lazy(() => import("./pages/NewSalePage"));
const SaleDetailPage = lazy(() => import("./pages/SaleDetailPage"));
const BillingPage = lazy(() => import("./pages/BillingPage"));
const EmployeesPage = lazy(() => import("./pages/EmployeesPage"));
const ClientsPage = lazy(() => import("./pages/ClientsPage"));
const ClientAccountsPage = lazy(() => import("./pages/ClientAccountsPage"));
const VariantTypesPage = lazy(() => import("./pages/VariantTypesPage"));
const MercadoLibrePage = lazy(() => import("./pages/MercadoLibrePage"));
const SalesTimelinePage = lazy(() => import("./pages/SalesTimelinePage"));
const ProductMetricsPage = lazy(() => import("./pages/ProductMetricsPage"));
const StockMovementsPage = lazy(() => import("./pages/StockMovementsPage"));
const SkuBuilderPage = lazy(() => import("./pages/SkuBuilderPage"));
const LabelsPage = lazy(() => import("./pages/LabelsPage"));
const StockByLocationPage = lazy(() => import("./pages/StockByLocationPage"));
const DepositoPage = lazy(() => import("./pages/DepositoPage"));
const EnviosDelDiaPage = lazy(() => import("./pages/EnviosDelDiaPage"));
const AnalisisPage = lazy(() => import("./pages/AnalisisPage"));
const SoportePage = lazy(() => import("./pages/SoportePage"));
const EventoPage = lazy(() => import("./pages/EventoPage"));
const StockARegularizarPage = lazy(() => import("./pages/StockARegularizarPage"));
const ReposicionPage = lazy(() => import("./pages/ReposicionPage"));
const ScanStockPage = lazy(() => import("./pages/ScanStockPage"));
const PosPage = lazy(() => import("./pages/PosPage"));
const BusinessCuitsPage = lazy(() => import("./pages/BusinessCuitsPage"));
const ArcaConfigPage = lazy(() => import("./pages/ArcaConfigPage"));

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
       <PermissionGuardProvider>
        {/* Mientras baja el pedazo de la pantalla, algo tiene que haber:
            una pantalla en blanco se lee como "se colgó". */}
        <Suspense fallback={<PantallaCargando />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/registro" element={<RegisterPage />} />
          <Route path="/olvide-password" element={<ForgotPasswordPage />} />

          <Route
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/dashboard"                    element={<PermissionRoute permission="dashboard"><DashboardPage /></PermissionRoute>} />
            <Route path="/dashboard/ventas"             element={<PermissionRoute permission="dashboard"><SalesTimelinePage /></PermissionRoute>} />
            <Route path="/dashboard/productos"          element={<PermissionRoute permission="dashboard"><ProductMetricsPage /></PermissionRoute>} />
            <Route path="/dashboard/analisis"           element={<PermissionRoute permission="dashboard"><AnalisisPage /></PermissionRoute>} />
            <Route path="/stock"                        element={<PermissionRoute permission="stock"><StockPage /></PermissionRoute>} />
            <Route path="/stock/variantes"              element={<PermissionRoute permission="stock" level="editar"><VariantTypesPage /></PermissionRoute>} />
            <Route path="/stock/escanear"               element={<PermissionRoute permission="stock" level="editar"><ScanStockPage /></PermissionRoute>} />
            {/* Antes de la ruta con parámetro: si no, "movimientos" se lee
                como un skuAgrupador y cae en el detalle de producto. */}
            <Route path="/stock/movimientos"            element={<PermissionRoute permission="stock"><StockMovementsPage /></PermissionRoute>} />
            <Route path="/stock/sku"                    element={<PermissionRoute permission="stock"><SkuBuilderPage /></PermissionRoute>} />
            <Route path="/stock/etiquetas"              element={<PermissionRoute permission="stock"><LabelsPage /></PermissionRoute>} />
            <Route path="/stock/por-local"              element={<PermissionRoute permission="stock"><StockByLocationPage /></PermissionRoute>} />
            <Route path="/stock/a-regularizar"          element={<PermissionRoute permission="stock"><StockARegularizarPage /></PermissionRoute>} />
            {/* El circuito depósito → local. Van fuera de /stock a propósito:
                son el trabajo de otra gente, con su propio permiso. */}
            <Route path="/evento"                       element={<PermissionRoute permission="stock"><EventoPage /></PermissionRoute>} />
            <Route path="/deposito"                     element={<PermissionRoute permission="deposito"><DepositoPage /></PermissionRoute>} />
            <Route path="/reposicion"                   element={<PermissionRoute permission="reposicion"><ReposicionPage /></PermissionRoute>} />
            <Route path="/envios"                       element={<PermissionRoute permission="stock"><EnviosDelDiaPage /></PermissionRoute>} />
            <Route path="/stock/:skuAgrupador"          element={<PermissionRoute permission="stock"><ProductDetailPage /></PermissionRoute>} />
            <Route path="/ventas"                       element={<PermissionRoute permission="ventas"><SalesPage /></PermissionRoute>} />
            <Route path="/ventas/nueva"                 element={<PermissionRoute permission="ventas" level="editar"><NewSalePage /></PermissionRoute>} />
            <Route path="/ventas/pos"                   element={<PermissionRoute permission="ventas" level="editar"><PosPage /></PermissionRoute>} />
            <Route path="/ventas/:numero"                   element={<PermissionRoute permission="ventas"><SaleDetailPage /></PermissionRoute>} />
            <Route path="/facturacion"                  element={<PermissionRoute permission="facturacion"><BillingPage /></PermissionRoute>} />
            <Route path="/facturacion/cuits"            element={<PermissionRoute permission="facturacion" level="editar"><BusinessCuitsPage /></PermissionRoute>} />
            <Route path="/facturacion/cuits/:cuitId/arca" element={<PermissionRoute permission="facturacion" level="editar"><ArcaConfigPage /></PermissionRoute>} />
            <Route path="/clientes"                     element={<PermissionRoute permission="clientes"><ClientsPage /></PermissionRoute>} />
            <Route path="/clientes/cuentas"             element={<PermissionRoute permission="clientes"><ClientAccountsPage /></PermissionRoute>} />
            <Route path="/cuenta"                       element={<OwnerRoute><AccountPage /></OwnerRoute>} />
            {/* Soporte lo ve cualquiera con sesión: el que se topa con el bug
                suele ser quien está atendiendo, no el dueño. */}
            <Route path="/soporte"                      element={<SoportePage />} />
            {/* Suscripción: la ve el dueño, no los empleados. */}
            <Route path="/cuenta/suscripcion"           element={<OwnerRoute><SubscriptionPage /></OwnerRoute>} />
            <Route path="/pagos"                        element={<PermissionRoute permission="pagos"><PaymentMethodsPage /></PermissionRoute>} />
            <Route path="/caja"                         element={<PermissionRoute permission="caja"><CashPage /></PermissionRoute>} />
            <Route path="/empleados"                    element={<PermissionRoute permission="empleados"><EmployeesPage /></PermissionRoute>} />
            <Route path="/integraciones/mercadolibre"   element={<PermissionRoute permission="integraciones"><MercadoLibrePage /></PermissionRoute>} />
          </Route>

          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
        </Suspense>
       </PermissionGuardProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

/*
 * Lo que se ve mientras llega el pedazo de la pantalla.
 *
 * Deliberadamente sobrio y sin animación de spinner: en una red del local esto
 * dura menos de lo que tarda el ojo en registrarlo, y un spinner que aparece y
 * desaparece a los 80ms se percibe como un parpadeo, que es peor que nada.
 */
function PantallaCargando() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper-100">
      <div className="h-8 w-8 animate-pulse rounded-md bg-brass-500/30" />
    </div>
  );
}
