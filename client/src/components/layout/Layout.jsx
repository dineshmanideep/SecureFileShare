import React, { useState } from "react";
import Sidebar from "./Sidebar";
import Navbar from "./Navbar";
import WelcomeModal from "../onboarding/WelcomeModal";

export default function Layout({ account, onDisconnect, children, searchQuery, onSearch }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const isFirstVisit = account && !localStorage.getItem(`onboarded_${account}`);

  return (
    <div className="app-layout">
      <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(c => !c)} />

      <div className="main-content">
        <Navbar
          account={account}
          onDisconnect={onDisconnect}
          searchQuery={searchQuery}
          onSearch={onSearch}
        />
        <div className="page-content">
          {children}
        </div>
      </div>

      {isFirstVisit && <WelcomeModal account={account} />}
    </div>
  );
}
