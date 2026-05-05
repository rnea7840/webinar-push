// Login screen — Google or email/password. Lifted from AISDR pattern.
import { useState } from "react";
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider,
} from "firebase/auth";
import { auth } from "../firebase";
import { Zap, Loader2, AlertCircle, Eye, EyeOff } from "lucide-react";

const googleProvider = new GoogleAuthProvider();

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [gLoading, setGLoading] = useState(false);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (mode === "signup") {
        if (password.length < 6) { setError("Password must be at least 6 characters."); setLoading(false); return; }
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      const code = err.code || "";
      if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
        setError("Invalid email or password");
      } else if (code.includes("email-already-in-use")) {
        setError("Account already exists. Sign in instead."); setMode("signin");
      } else if (code.includes("operation-not-allowed")) {
        setError("Email/password sign-in not enabled. Firebase Console → Authentication → Sign-in method.");
      } else if (code.includes("configuration-not-found")) {
        setError("Firebase Auth not initialized. Firebase Console → Authentication → Get started → enable Google.");
      } else {
        setError(err.message);
      }
    }
    setLoading(false);
  }

  async function handleGoogle() {
    setError(""); setGLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      const code = err.code || "";
      if (code.includes("popup-closed-by-user")) { /* ignore */ }
      else if (code.includes("unauthorized-domain")) {
        setError("This domain is not authorized in Firebase Auth → Settings → Authorized domains.");
      } else if (code.includes("configuration-not-found")) {
        setError("Firebase Auth not initialized. Firebase Console → Authentication → Get started → enable Google.");
      } else {
        setError(err.message);
      }
    }
    setGLoading(false);
  }

  return (
    <div className="min-h-screen bg-surface-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-brand-600 flex items-center justify-center mb-4">
            <Zap size={24} className="text-white" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-surface-100">Webinar Push</h1>
          <p className="text-sm text-surface-500 mt-1">
            {mode === "signin" ? "Sign in to continue" : "Create your account"}
          </p>
        </div>

        <div className="glass rounded-xl p-6 space-y-4">
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          <button
            onClick={handleGoogle}
            disabled={gLoading}
            className="btn w-full bg-white hover:bg-gray-100 text-gray-800 border border-gray-300 flex items-center justify-center gap-3 py-3"
          >
            {gLoading ? (<Loader2 size={16} className="animate-spin" />) : (
              <svg width="18" height="18" viewBox="0 0 48 48">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
              </svg>
            )}
            {mode === "signin" ? "Sign in with Google" : "Sign up with Google"}
          </button>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-surface-800" />
            <span className="text-xs text-surface-600">or</span>
            <div className="flex-1 h-px bg-surface-800" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="label">Email</label>
              <input type="email" className="input" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <label className="label">Password</label>
              <div className="relative">
                <input type={showPassword ? "text" : "password"} className="input pr-10" placeholder={mode === "signup" ? "Min 6 characters" : "••••••••"} value={password} onChange={(e) => setPassword(e.target.value)} required />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300 p-1">
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? <Loader2 size={14} className="animate-spin inline mr-2" /> : null}
              {mode === "signin" ? "Sign In" : "Create Account"}
            </button>
          </form>

          <div className="text-center pt-1">
            {mode === "signin" ? (
              <p className="text-xs text-surface-500">
                New here?{" "}
                <button onClick={() => { setMode("signup"); setError(""); }} className="text-brand-400 hover:text-brand-300 font-medium">Create an account</button>
              </p>
            ) : (
              <p className="text-xs text-surface-500">
                Already have an account?{" "}
                <button onClick={() => { setMode("signin"); setError(""); }} className="text-brand-400 hover:text-brand-300 font-medium">Sign in</button>
              </p>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-surface-600 mt-4">Webinar Push · SBOM Event</p>
      </div>
    </div>
  );
}
