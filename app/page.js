"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../lib/supabaseClient";
import { getCurrentUser, signOutDeactivated } from "../lib/session";

export default function Home() {
  const router = useRouter();
  const [status, setStatus] = useState("Loading...");

  useEffect(() => {
    (async () => {
      const user = await getCurrentUser();
      if (!user) {
        router.replace("/login");
        return;
      }
      if (user.offline) {
        router.replace("/checkin"); // offline: go straight to check-in
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("role, active")
        .eq("id", user.id)
        .single();

      if (profile?.active === false) {
        await signOutDeactivated(router);
      } else if (profile?.role === "hr_admin" || profile?.role === "super_admin") {
        router.replace("/admin");
      } else {
        router.replace("/checkin");
      }
    })();
  }, [router]);

  return (
    <div className="container">
      <p className="muted">{status}</p>
    </div>
  );
}
