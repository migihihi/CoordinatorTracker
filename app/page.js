"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../lib/supabaseClient";

export default function Home() {
  const router = useRouter();
  const [status, setStatus] = useState("Loading...");

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace("/login");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", session.user.id)
        .single();

      if (profile?.role === "hr_admin") {
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
