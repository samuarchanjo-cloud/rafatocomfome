import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
  const testMode = env.VITE_CHECKOUT_TEST_MODE === "true";
  const stagingUrl = "https://epnaaexmxgohurwpfury.supabase.co";
  const supabaseUrl = env.VITE_SUPABASE_URL;

  if (!supabaseUrl || !env.VITE_SUPABASE_ANON_KEY) {
    throw new Error("Configure a URL e a chave pública do Supabase.");
  }
  if (env.VERCEL_ENV === "production") {
    if (testMode || supabaseUrl === stagingUrl) {
      throw new Error("Build de produção não pode usar a homologação.");
    }
  } else if (!testMode || supabaseUrl !== stagingUrl) {
    throw new Error("Build interrompido: configuração de homologação incompatível.");
  }

  return {};
});
