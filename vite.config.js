import { defineConfig, loadEnv } from "vite";

// This branch builds only against the dedicated checkout test project.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
  if (
    env.VITE_CHECKOUT_TEST_MODE !== "true"
    || env.VITE_SUPABASE_URL !== "https://epnaaexmxgohurwpfury.supabase.co"
    || !env.VITE_SUPABASE_ANON_KEY
    || env.VERCEL_ENV === "production"
  ) {
    throw new Error("Build interrompido: configuração de homologação incompatível.");
  }
  return {};
});
