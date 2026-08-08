import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { PermissionGuardProvider } from "./context/PermissionGuardContext";
import ProtectedRoute from "./components/layout/ProtectedRoute";
import PermissionRoute from "./components/layout/PermissionRoute";
import AppLayout from "./components/layout/AppLayout";

import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import DashboardPage from "./pages/DashboardPage";
import StockPage from "./pages/StockPage";
import ProductDetailPage from "./pages/ProductDetailPage";
import SalesPage from "./pages/SalesPage";
import NewSalePage from "./pages/NewSalePage";
import SaleDetailPage from "./pages/SaleDetailPage";
import BillingPage from "./pages/BillingPage";
import EmployeesPage from "./pages/EmployeesPage";
import ClientsPage from "./pages/ClientsPage";
import VariantTypesPage from "./pages/VariantTypesPage";
import MercadoLibrePage from "./pages/MercadoLibrePage";
import SalesTimelinePage from "./pages/SalesTimelinePage";
import ProductMetricsPage from "./pages/ProductMetricsPage";
import BusinessCuitsPage from "./pages/BusinessCuitsPage";
import ArcaConfigPage from "./pages/ArcaConfigPage";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
       <PermissionGuardProvider>
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
            <Route path="/stock"                        element={<PermissionRoute permission="stock"><StockPage /></PermissionRoute>} />
            <Route path="/stock/variantes"              element={<PermissionRoute permission="stock" level="editar"><VariantTypesPage /></PermissionRoute>} />
            <Route path="/stock/:skuAgrupador"          element={<PermissionRoute permission="stock"><ProductDetailPage /></PermissionRoute>} />
            <Route path="/ventas"                       element={<PermissionRoute permission="ventas"><SalesPage /></PermissionRoute>} />
            <Route path="/ventas/nueva"                 element={<PermissionRoute permission="ventas" level="editar"><NewSalePage /></PermissionRoute>} />
            <Route path="/ventas/:id"                   element={<PermissionRoute permission="ventas"><SaleDetailPage /></PermissionRoute>} />
            <Route path="/facturacion"                  element={<PermissionRoute permission="facturacion"><BillingPage /></PermissionRoute>} />
            <Route path="/facturacion/cuits"            element={<PermissionRoute permission="facturacion" level="editar"><BusinessCuitsPage /></PermissionRoute>} />
            <Route path="/facturacion/cuits/:cuitId/arca" element={<PermissionRoute permission="facturacion" level="editar"><ArcaConfigPage /></PermissionRoute>} />
            <Route path="/clientes"                     element={<PermissionRoute permission="ventas"><ClientsPage /></PermissionRoute>} />
            <Route path="/empleados"                    element={<PermissionRoute permission="empleados"><EmployeesPage /></PermissionRoute>} />
            <Route path="/integraciones/mercadolibre"   element={<PermissionRoute permission="stock"><MercadoLibrePage /></PermissionRoute>} />
          </Route>

          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
       </PermissionGuardProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
