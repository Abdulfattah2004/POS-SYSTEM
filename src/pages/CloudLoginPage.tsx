import { useState } from "react";
import { Lock, Mail, Cloud, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function CloudLoginPage({
  onSuccess,
}: {
  onSuccess: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function loginToCloud() {
    if (!email || !password) {
      alert("Please enter cloud email and password.");
      return;
    }

    setLoading(true);

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      alert(error.message);
      return;
    }

    console.log("Cloud logged in as:", data.user.id);
    onSuccess();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-xl">
        <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 text-white">
          <Cloud className="h-7 w-7" />
        </div>

        <h1 className="text-2xl font-bold text-slate-950">Cloud Login</h1>
        <p className="mt-2 text-sm text-slate-500">
          Login to Supabase cloud to enable secure sync with RLS.
        </p>

        <div className="mt-6 space-y-4">
          <div className="relative">
            <Mail className="absolute left-4 top-3.5 h-5 w-5 text-slate-400" />
            <Input
              className="h-12 rounded-2xl pl-12"
              placeholder="Cloud email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="relative">
            <Lock className="absolute left-4 top-3.5 h-5 w-5 text-slate-400" />
            <Input
              className="h-12 rounded-2xl pl-12"
              placeholder="Cloud password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") loginToCloud();
              }}
            />
          </div>

          <Button
            className="h-12 w-full rounded-2xl"
            onClick={loginToCloud}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Logging in...
              </>
            ) : (
              "Login to Cloud"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}