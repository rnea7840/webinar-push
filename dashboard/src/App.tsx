// Main shell — sidebar + routes. Mirrors AISDR layout patterns.
import { useState } from "react";
import { Routes, Route, NavLink } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "./firebase";
import {
  LayoutDashboard, Users, Settings, BarChart3, Linkedin,
  Zap, ChevronLeft, ChevronRight, FlaskConical, Radio,
  LogOut, Loader2, ListChecks, Search,
} from "lucide-react";
import Login from "./pages/Login";
import Overview from "./pages/Overview";
import Prospects from "./pages/Prospects";
import Sources from "./pages/Sources";
import SettingsPage from "./pages/SettingsPage";
import ActivityLog from "./pages/ActivityLog";
import { useAuth, useSettings } from "./hooks/useFirestore";

const NAV = [
  { to: "/",          icon: LayoutDashboard, label: "Overview" },
  { to: "/prospects", icon: Users,           label: "Prospects" },
  { to: "/sources",   icon: Search,          label: "Sources & ICP" },
  { to: "/activity",  icon: ListChecks,      label: "Activity" },
  { to: "/settings",  icon: Settings,        label: "Settings" },
];

export default function App() {
  const { user, loading } = useAuth();
  const { data: settings } = useSettings();
  const [collapsed, setCollapsed] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-950 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-surface-600" />
      </div>
    );
  }
  if (!user) return <Login />;

  const isSandbox = !settings?.mode || settings.mode === "sandbox";
  const isPaused = !!(settings?.paused || settings?.linkedinPaused);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className={`${collapsed ? "w-16" : "w-56"} flex-shrink-0 flex flex-col border-r border-surface-800 bg-surface-950 transition-all duration-200`}>
        <div className={`flex items-center gap-2.5 p-4 ${collapsed ? "justify-center" : ""}`}>
          <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center flex-shrink-0">
            <Zap size={16} className="text-white" />
          </div>
          {!collapsed && <span className="font-semibold text-sm tracking-tight">Webinar Push</span>}
        </div>

        {/* Mode pill */}
        <div className={`mx-3 mb-1 ${collapsed ? "px-0" : ""}`}>
          <div className={`flex items-center gap-2 ${collapsed ? "justify-center" : "px-3"} py-2 rounded-lg text-xs font-medium ${
            isSandbox
              ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
              : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
          }`}>
            {isSandbox ? <FlaskConical size={14} /> : <Radio size={14} />}
            {!collapsed && (isSandbox ? "SANDBOX" : "LIVE")}
          </div>
        </div>

        {/* Paused pill */}
        {isPaused && (
          <div className={`mx-3 mb-2 ${collapsed ? "px-0" : ""}`}>
            <div className={`flex items-center gap-2 ${collapsed ? "justify-center" : "px-3"} py-1.5 rounded-lg text-[10px] font-medium bg-red-500/10 text-red-400 border border-red-500/20`}>
              <Linkedin size={12} />
              {!collapsed && "PAUSED"}
            </div>
          </div>
        )}

        <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto mt-2">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${collapsed ? "justify-center" : ""} ${
                  isActive
                    ? "bg-brand-600/15 text-brand-400 font-medium"
                    : "text-surface-400 hover:text-surface-200 hover:bg-surface-800/50"
                }`}
              title={label}>
              <Icon size={18} />
              {!collapsed && label}
            </NavLink>
          ))}
        </nav>

        {/* User + sign out */}
        <div className="border-t border-surface-800 p-2">
          {!collapsed && (
            <div className="px-3 py-1">
              <p className="text-xs text-surface-400 truncate">{user.displayName || user.email}</p>
              <p className="text-[10px] text-surface-600 truncate">{user.email}</p>
            </div>
          )}
          <button onClick={() => signOut(auth)}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-surface-500 hover:text-red-400 hover:bg-surface-800/50 transition w-full"
            title="Sign out">
            <LogOut size={16} />
            {!collapsed && "Sign out"}
          </button>
        </div>

        <button onClick={() => setCollapsed(!collapsed)}
          className="p-3 border-t border-surface-800 text-surface-500 hover:text-surface-300 transition flex justify-center">
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto p-6">
          <Routes>
            <Route path="/"          element={<Overview />} />
            <Route path="/prospects" element={<Prospects />} />
            <Route path="/sources"   element={<Sources />} />
            <Route path="/activity"  element={<ActivityLog />} />
            <Route path="/settings"  element={<SettingsPage />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
