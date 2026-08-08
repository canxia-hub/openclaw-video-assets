import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import LoginPage from "./pages/LoginPage";
import AppShell from "./components/AppShell";
import DashboardPage from "./pages/DashboardPage";
import ProjectsPage from "./pages/ProjectsPage";
import AssetsPage from "./pages/AssetsPage";
import CanvasPage from "./pages/CanvasPage";
import GenPrepPage from "./pages/GenPrepPage";
import StagingPage from "./pages/StagingPage";
import AuditPage from "./pages/AuditPage";
import SettingsPage from "./pages/SettingsPage";

export default function App() {
  const { status, probe } = useAuth();

  useEffect(() => {
    if (status === "unknown") void probe();
  }, [status, probe]);

  if (status === "unknown") {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary">
        正在检查会话…
      </div>
    );
  }

  if (status === "anon") return <LoginPage />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectsPage />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/assets/:assetId" element={<AssetsPage />} />
        <Route path="/canvas" element={<CanvasPage />} />
        <Route path="/canvas/:canvasId" element={<CanvasPage />} />
        <Route path="/generate" element={<GenPrepPage />} />
        <Route path="/staging" element={<StagingPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}
