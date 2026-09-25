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
import GenerationQueuePage from "./pages/GenerationQueuePage";
import StagingPage from "./pages/StagingPage";
import AuditPage from "./pages/AuditPage";
import PlaceholderPage from "./components/PlaceholderPage";
import ErrorBoundary from "./components/ErrorBoundary";
import DiagnosticsPage from "./pages/DiagnosticsPage";
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
      {/* 每页一个错误边界：一页渲染出错只让那一页降级，而不是整站白屏。 */}
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/projects" element={<ErrorBoundary scope="项目总览"><ProjectsPage /></ErrorBoundary>} />
        <Route path="/projects/:projectId" element={<ProjectsPage />} />
        <Route path="/assets" element={<ErrorBoundary scope="素材库"><AssetsPage /></ErrorBoundary>} />
        <Route path="/assets/:assetId" element={<AssetsPage />} />
        <Route path="/canvas" element={<ErrorBoundary scope="镜头画布"><CanvasPage /></ErrorBoundary>} />
        <Route path="/canvas/:canvasId" element={<CanvasPage />} />
        <Route path="/generate" element={<ErrorBoundary scope="生成准备"><GenPrepPage /></ErrorBoundary>} />
        <Route path="/jobs" element={<ErrorBoundary scope="生成队列"><GenerationQueuePage /></ErrorBoundary>} />
        {/*
          审核交付 has no delivery/handover surface yet. The label stays in the product navigation because the
          path is real - review notes and revision cards exist and are used from the canvas - but this page must
          not imply a delivery pipeline that is not implemented. The bullets name which half exists.
        */}
        <Route
          path="/review"
          element={
            <PlaceholderPage
              title="审核交付"
              phase="规划中"
              description="审核批注与返修卡已在产品内可用（在镜头画布中登记、从画布导出简报）；面向交付的交接面（成片清单、交付包、平台导出）尚未实现。"
              bullets={[
                "已可用：画布审片批注、返修卡状态流转、批注简报导出 — 入口在「镜头画布」",
                "已可用：素材版本与派生文件的完整性检查 — 入口在「素材库」",
                "未实现：交付包清单、平台规格导出、交付确认流程",
              ]}
            />
          }
        />
        <Route path="/staging" element={<StagingPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        {/* 诊断面：构建身份与降级自检。不在产品导航里，也不是业务功能。 */}
        <Route path="/diagnostics" element={<ErrorBoundary scope="诊断"><DiagnosticsPage /></ErrorBoundary>} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}
