import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { setSetting } from "@/lib/localSettings";

export default function CloudSetupPage({ db, onComplete }: any) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businesses, setBusinesses] = useState<any[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [branchId, setBranchId] = useState("");

  async function login() {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    alert(error.message);
    return;
  }

  console.log("Logged in user:", data.user.id);

  const { data: businessData, error: businessError } = await supabase
    .from("businesses")
    .select("*")
    .eq("owner_id", data.user.id);

  if (businessError) {
    console.error("Business load error:", businessError);
    alert(businessError.message);
    return;
  }

  console.log("Businesses:", businessData);
  setBusinesses(businessData || []);
}

  async function loadBranches(id: string) {
    setBusinessId(id);

    const { data } = await supabase
      .from("branches")
      .select("*")
      .eq("business_id", id);

    setBranches(data || []);
  }

  async function finishSetup() {
    if (!businessId || !branchId) {
      alert("Choose business and branch");
      return;
    }

    await setSetting(db, "business_id", businessId);
    await setSetting(db, "branch_id", branchId);

    onComplete();
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="space-y-4 w-full max-w-md">
        <h1 className="text-2xl font-bold">Cloud Setup</h1>

        <input
          className="border p-2 w-full"
          placeholder="Owner email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          className="border p-2 w-full"
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button className="border p-2 w-full" onClick={login}>
          Login
        </button>

        {businesses.length > 0 && (
          <select
            className="border p-2 w-full"
            onChange={(e) => loadBranches(e.target.value)}
          >
            <option value="">Choose Business</option>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}

        {branches.length > 0 && (
          <select
            className="border p-2 w-full"
            onChange={(e) => setBranchId(e.target.value)}
          >
            <option value="">Choose Branch</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}

        {businessId && branchId && (
          <button className="border p-2 w-full" onClick={finishSetup}>
            Finish Setup
          </button>
        )}
      </div>
    </div>
  );
}