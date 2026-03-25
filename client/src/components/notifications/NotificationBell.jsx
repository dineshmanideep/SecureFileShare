import React, { useState } from "react";
import { Bell, Share2, Clock, Shield, Trash2, X } from "lucide-react";

function getNotificationIcon(type) {
  switch(type) {
    case "share": return <Share2 className="w-3 h-3 text-electric-500" />;
    case "expiry": return <Clock className="w-3 h-3 text-amber-500" />;
    case "zkp": return <Shield className="w-3 h-3 text-green-500" />;
    case "gdpr": return <Trash2 className="w-3 h-3 text-red-500" />;
    default: return <Bell className="w-3 h-3 text-gray-400" />;
  }
}

function getNotificationBg(type) {
  switch(type) {
    case "share":  return "bg-electric-50";
    case "expiry": return "bg-amber-50";
    case "zkp":    return "bg-green-50";
    case "gdpr":   return "bg-red-50";
    default:       return "bg-gray-50";
  }
}

// Static demo notifications — in real app these come from blockchain events
const DEMO_NOTIFICATIONS = [
  { id: 1, type: "share",  read: false, message: "File shared with you",               time: "5 min ago"  },
  { id: 2, type: "expiry", read: false, message: "Access expires soon",                 time: "1 hr ago"   },
  { id: 3, type: "zkp",    read: true,  message: "ZKP verification successful",         time: "2 hrs ago"  },
  { id: 4, type: "gdpr",   read: true,  message: "GDPR erasure request fulfilled",      time: "Yesterday"  },
];

export default function NotificationBell({ account }) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState(DEMO_NOTIFICATIONS);

  const unread = notifications.filter(n => !n.read).length;

  const markAllRead = () => setNotifications(ns => ns.map(n => ({ ...n, read: true })));
  const dismiss = (id) => setNotifications(ns => ns.filter(n => n.id !== id));

  return (
    <div className="relative">
      <button
        className="btn-icon relative"
        onClick={() => setOpen(!open)}
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4 text-gray-500" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-2xl shadow-xl border border-gray-100 z-50 overflow-hidden animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-50">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-gray-900 text-sm">Notifications</h3>
                {unread > 0 && <span className="badge badge-blue">{unread} new</span>}
              </div>
              <div className="flex items-center gap-1">
                {unread > 0 && (
                  <button onClick={markAllRead} className="text-xs text-electric-600 hover:text-electric-700 font-medium px-2">
                    Mark all read
                  </button>
                )}
              </div>
            </div>

            {/* Notifications */}
            <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
              {notifications.length === 0 ? (
                <div className="p-8 text-center text-sm text-gray-400">No notifications</div>
              ) : (
                notifications.map((n) => (
                  <div
                    key={n.id}
                    className={`flex items-start gap-3 px-4 py-3 hover:bg-gray-50 transition-colors ${!n.read ? "bg-electric-50/30" : ""}`}
                  >
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${getNotificationBg(n.type)}`}>
                      {getNotificationIcon(n.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm ${!n.read ? "font-semibold text-gray-900" : "text-gray-700"}`}>
                        {n.message}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">{n.time}</p>
                    </div>
                    <button
                      onClick={() => dismiss(n.id)}
                      className="flex-shrink-0 text-gray-300 hover:text-gray-500"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
