import React, { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, FolderOpen, Share2, Users, Shield,
  Settings, ChevronLeft, Lock
} from "lucide-react";

const navItems = [
  { to: "/dashboard",  icon: LayoutDashboard, label: "Dashboard" },
  { to: "/my-files",   icon: FolderOpen,       label: "My Files"       },
  { to: "/shared",     icon: Share2,            label: "Shared With Me" },
  { to: "/groups",     icon: Users,             label: "Groups"         },
  { to: "/gdpr",       icon: Shield,            label: "GDPR Center"    },
  { to: "/settings",   icon: Settings,          label: "Settings"       },
];

export default function Sidebar({ collapsed, onToggle }) {
  const location = useLocation();

  return (
    <aside className="sidebar" style={{ width: collapsed ? 64 : 240 }}>
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 mb-2">
        <div className="w-8 h-8 rounded-xl bg-electric-500 flex items-center justify-center flex-shrink-0">
          <Lock className="w-4 h-4 text-white" />
        </div>
        {!collapsed && (
          <span className="text-white font-bold text-base tracking-tight">SecureShare</span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 px-1">
        {navItems.map(({ to, icon: Icon, label }) => {
          const active = location.pathname === to || (to === "/my-files" && location.pathname === "/");
          return (
            <Link
              key={to}
              to={to}
              className={`sidebar-link ${active ? "active" : ""}`}
              title={collapsed ? label : undefined}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {!collapsed && <span>{label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={onToggle}
        className="flex items-center justify-center mx-auto mb-4 w-8 h-8 rounded-full bg-white/10 text-slate-400 hover:text-white transition-colors"
      >
        <ChevronLeft className={`w-4 h-4 transition-transform ${collapsed ? "rotate-180" : ""}`} />
      </button>
    </aside>
  );
}
