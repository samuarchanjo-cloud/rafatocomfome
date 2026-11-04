import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const checkoutTestMode = import.meta.env.VITE_CHECKOUT_TEST_MODE === "true";
const stagingUrl = "https://epnaaexmxgohurwpfury.supabase.co";
if (checkoutTestMode !== (supabaseUrl === stagingUrl)) {
  throw new Error("Configuração de homologação incompatível.");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
