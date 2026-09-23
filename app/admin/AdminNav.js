"use client";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
import { ROLE_LABELS } from "../../lib/adminAuth";
import { APP_VERSION } from "../../lib/version";

// Shared header + navigation for every admin page.
export default function AdminNav({ me, title }) {
  const router = useRouter();
  const pathname = usePathname();

  const links = [
    { href: "/admin", label: "Attendance" },
    { href: "/admin/coordinators", label: me?.isSuper ? "Coordinators" : "My Coordinators" },
    { href: "/admin/locations", label: "Sites" },
    { href: "/admin/announcements", label: "Announcements" },
  ];
  if (me?.isSuper) links.push({ href: "/admin/team", label: "Team" });

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  return (
    <>
      <div className="admin-header">
        <div className="brand-row">
          <img src="/rera-icon.png" className="brand-mark" alt="Rera" />
          <div>
            <h1>{title}</h1>
            <span className="muted">
              {me?.full_name || me?.email}
              {me && (
                <span className={`badge ${me.isSuper ? "super" : "ok"}`} style={{ marginLeft: 6 }}>
                  {ROLE_LABELS[me.role]}
                </span>
              )}
              <span style={{ marginLeft: 6 }}>· v{APP_VERSION}</span>
            </span>
          </div>
        </div>
        <div className="admin-actions">
          <button className="secondary" style={{ width: "auto" }} onClick={() => router.push("/checkin")}>
            Check-in view
          </button>
          <button className="link" onClick={handleLogout}>Log out</button>
        </div>
      </div>
      <nav className="admin-nav">
        {links.map((l) => (
          <button
            key={l.href}
            className={`tab-btn ${pathname === l.href ? "active" : ""}`}
            onClick={() => router.push(l.href)}
          >
            {l.label}
          </button>
        ))}
      </nav>
    </>
  );
}
