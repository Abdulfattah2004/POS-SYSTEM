import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
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
import CloudSetupPage from "./pages/CloudSetupPage";
import CloudLoginPage from "./pages/CloudLoginPage";
import { ReactNode, useEffect, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import { migrateLocalStorageToSqlite } from "@/lib/migrateToSqlite";
import { getSetting } from "@/lib/localSettings";
import { syncAll } from "@/lib/sync";
import { supabase } from "@/lib/supabase";

const queryClient = new QueryClient();

async function ensureSyncColumns(db: any) {
  const tables = [
    "products",
    "sales",
    "sale_items",
    "refunds",
    "refund_items",
    "inventory_entries",
  ];

  for (const table of tables) {
    try {
      const tableExistsResult = await db.select(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`
      );

      const tableExists = tableExistsResult as Array<{ name: string }>;

      if (!tableExists || tableExists.length === 0) {
        console.warn(`Table ${table} does not exist yet. Skipping synced column.`);
        continue;
      }

      const columnsResult = await db.select(`PRAGMA table_info(${table})`);

      const columns = columnsResult as Array<{ name: string }>;

      const hasSyncedColumn = columns.some(
        (column) => column.name === "synced"
      );

      if (!hasSyncedColumn) {
        console.log(`Adding synced column to ${table}...`);

        await db.execute(
          `ALTER TABLE ${table} ADD COLUMN synced INTEGER NOT NULL DEFAULT 0`
        );
      }
    } catch (error) {
      console.error(`Failed checking synced column for ${table}:`, error);
    }
  }
}

function ProtectedRoute({
  children,
  adminOnly = false,
}: {
  children: ReactNode;
  adminOnly?: boolean;
}) {
  const { user, isAdmin } = useAuth();

  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && !isAdmin) return <Navigate to="/pos" replace />;

  return <Layout>{children}</Layout>;
}

function AppRoutes() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/pos" replace /> : <LoginPage />}
      />

      <Route
        path="/pos"
        element={
          <ProtectedRoute>
            <POSPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/inventory"
        element={
          <ProtectedRoute adminOnly>
            <InventoryPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/inventory-entry"
        element={
          <ProtectedRoute adminOnly>
            <InventoryEntryPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/daily-movement"
        element={
          <ProtectedRoute adminOnly>
            <DailyMovementPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/receipts"
        element={
          <ProtectedRoute adminOnly>
            <ReceiptsPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/refunds"
        element={
          <ProtectedRoute>
            <RefundsPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/salesmen"
        element={
          <ProtectedRoute adminOnly>
            <SalesmenPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/reports"
        element={
          <ProtectedRoute adminOnly>
            <ReportsPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/analytics"
        element={
          <ProtectedRoute adminOnly>
            <AnalyticsPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/settings"
        element={
          <ProtectedRoute adminOnly>
            <SettingsPage />
          </ProtectedRoute>
        }
      />

      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

async function hasSupabaseSession() {
  const { data, error } = await supabase.auth.getSession();

  if (error) {
    console.error("Supabase session check failed:", error);
    return false;
  }

  if (!data.session) {
    console.warn("No Supabase Auth session. Cloud sync stopped.");
    return false;
  }

  console.log("Supabase logged in as:", data.session.user.id);
  return true;
}

async function safeSync(db: any) {
  const sessionExists = await hasSupabaseSession();

  if (!sessionExists) {
    return false;
  }

  await syncAll(db);
  return true;
}

function AppContent({
  db,
  initialCloudConfigured,
}: {
  db: any;
  initialCloudConfigured: boolean;
}) {
  const { user } = useAuth();
  const [cloudConfigured, setCloudConfigured] = useState(initialCloudConfigured);
  const [checkingCloudAuth, setCheckingCloudAuth] = useState(true);
  const [cloudLoggedIn, setCloudLoggedIn] = useState(false);

  useEffect(() => {
    async function checkCloudAuth() {
      const { data, error } = await supabase.auth.getSession();

      if (error) {
        console.error("Cloud auth check failed:", error);
        setCloudLoggedIn(false);
      } else {
        setCloudLoggedIn(Boolean(data.session));
      }

      setCheckingCloudAuth(false);
    }

    checkCloudAuth();

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setCloudLoggedIn(Boolean(session));
      }
    );

    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    async function runStartupSync() {
      if (!user || !db || !cloudConfigured || !cloudLoggedIn) return;

      try {
        console.log("Startup cloud sync running...");
        const didSync = await safeSync(db);

        if (didSync) {
          console.log("Startup cloud sync completed");
        }
      } catch (error) {
        console.error("Startup cloud sync failed:", error);
      }
    }

    runStartupSync();
  }, [user, db, cloudConfigured, cloudLoggedIn]);

  useEffect(() => {
    if (!user || !db || !cloudConfigured || !cloudLoggedIn) return;

    const interval = setInterval(async () => {
      try {
        console.log("Auto sync running...");
        const didSync = await safeSync(db);

        if (didSync) {
          console.log("Auto sync completed");
        }
      } catch (error) {
        console.error("Auto sync failed:", error);
      }
    }, 60000);

    return () => clearInterval(interval);
  }, [user, db, cloudConfigured, cloudLoggedIn]);

  if (!user) {
    return <AppRoutes />;
  }

  if (checkingCloudAuth) {
    return <div className="p-6">Checking cloud login...</div>;
  }

  if (!cloudLoggedIn) {
    return <CloudLoginPage onSuccess={() => setCloudLoggedIn(true)} />;
  }

  if (!cloudConfigured) {
    return (
      <CloudSetupPage
        db={db}
        onComplete={async () => {
          setCloudConfigured(true);

          try {
            console.log("Cloud setup completed. First sync running...");
            const didSync = await safeSync(db);

            if (didSync) {
              console.log("First sync completed");
            }
          } catch (error) {
            console.error("First sync failed:", error);
          }
        }}
      />
    );
  }

  return <AppRoutes />;
}

const App = () => {
  const [db, setDb] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [initialCloudConfigured, setInitialCloudConfigured] = useState(false);

  async function initApp() {
    try {
      await migrateLocalStorageToSqlite();

      const dbInstance = await Database.load("sqlite:pos_v2.db");

      await ensureSyncColumns(dbInstance);

      setDb(dbInstance);

      const businessId = await getSetting(dbInstance, "business_id");
      const branchId = await getSetting(dbInstance, "branch_id");

      console.log("Cloud businessId:", businessId);
      console.log("Cloud branchId:", branchId);

      setInitialCloudConfigured(Boolean(businessId && branchId));
    } catch (error) {
      console.error("Startup failed:", error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    initApp();
  }, []);

  if (loading) {
    return <div className="p-6">Loading POS...</div>;
  }

  if (!db) {
    return <div className="p-6">Database failed to load.</div>;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Sonner />
        <BrowserRouter>
          <AuthProvider>
            <AppContent
              db={db}
              initialCloudConfigured={initialCloudConfigured}
            />
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
