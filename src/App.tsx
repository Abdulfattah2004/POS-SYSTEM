import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import Layout from "./components/Layout";
import LoginPage from "./pages/LoginPage";
import POSPage from "./pages/POSPage";
import InventoryPage from "./pages/InventoryPage";
import InventoryEntryPage from "./pages/InventoryEntryPage";
import DailyMovementPage from "./pages/DailyMovementPage";
import RefundsPage from "./pages/RefundsPage";
import ReceiptsPage from "./pages/ReceiptsPage";
import SalesmenPage from "./pages/SalesmenPage";
import ReportsPage from "./pages/ReportsPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import SettingsPage from "./pages/SettingsPage";
import NotFound from "./pages/NotFound";
import { ReactNode } from "react";

const Router = window.location.protocol === "file:" || "__TAURI_INTERNALS__" in window ? HashRouter : BrowserRouter;

const queryClient = new QueryClient();

function ProtectedRoute({ children, adminOnly = false }: { children: ReactNode; adminOnly?: boolean }) {
  const { user, isAdmin } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && !isAdmin) return <Navigate to="/pos" replace />;
  return <Layout>{children}</Layout>;
}

function AppRoutes() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/pos" replace /> : <LoginPage />} />
      <Route path="/pos" element={<ProtectedRoute><POSPage /></ProtectedRoute>} />
      <Route path="/inventory" element={<ProtectedRoute adminOnly><InventoryPage /></ProtectedRoute>} />
      <Route path="/inventory-entry" element={<ProtectedRoute adminOnly><InventoryEntryPage /></ProtectedRoute>} />
      <Route path="/daily-movement" element={<ProtectedRoute adminOnly><DailyMovementPage /></ProtectedRoute>} />
      <Route path="/receipts" element={<ProtectedRoute><ReceiptsPage /></ProtectedRoute>} />
      <Route path="/refunds" element={<ProtectedRoute><RefundsPage /></ProtectedRoute>} />
      <Route path="/salesmen" element={<ProtectedRoute adminOnly><SalesmenPage /></ProtectedRoute>} />
      <Route path="/reports" element={<ProtectedRoute adminOnly><ReportsPage /></ProtectedRoute>} />
      <Route path="/analytics" element={<ProtectedRoute adminOnly><AnalyticsPage /></ProtectedRoute>} />
      <Route path="/settings" element={<ProtectedRoute adminOnly><SettingsPage /></ProtectedRoute>} />
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="*" element={user ? <NotFound /> : <Navigate to="/login" replace />} />
    </Routes>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Router>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </Router>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
