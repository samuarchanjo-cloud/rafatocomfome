import { supabase } from "./supabase";
import { FALLBACK_BUSINESS_HOURS, FALLBACK_CATEGORIES, PUBLIC_FALLBACKS } from "../menuData";

const PRODUCTS_BUCKET = "product-images";

function isMissingTable(error) {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

function normalizeProduct(product) {
  return {
    ...product,
    price: Number(product.price) || 0,
    image: product.image_url || product.image || "",
    visible: product.visible !== false,
    featured: Boolean(product.featured),
    sort_order: Number(product.sort_order) || 0,
    status: ["esgotado", "indisponivel"].includes(
      String(product.status || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(),
    )
      ? "Esgotado"
      : "Disponível",
  };
}

export async function loadStoreData() {
  const setupWarnings = [];
  const [productsResult, categoriesResult, hoursResult, rangesResult, settingsResult] = await Promise.all([
    supabase.from("products").select("*").order("sort_order", { ascending: true }).order("name"),
    supabase.from("categories").select("*").order("sort_order", { ascending: true }),
    supabase.from("business_hours").select("*").order("day_of_week", { ascending: true }),
    supabase.from("delivery_fee_ranges").select("*").order("min_distance_km", { ascending: true }),
    supabase.from("app_settings").select("*").eq("id", "global").maybeSingle(),
  ]);

  if (productsResult.error) throw productsResult.error;
  const useFallback = (result, label, fallback) => {
    if (!result.error) return result.data?.length ? result.data : fallback;
    if (isMissingTable(result.error)) {
      setupWarnings.push(`${label} ainda não existe no Supabase.`);
      return fallback;
    }
    throw result.error;
  };

  const categories = useFallback(categoriesResult, "A tabela categories", FALLBACK_CATEGORIES);
  const businessHours = useFallback(hoursResult, "A tabela business_hours", FALLBACK_BUSINESS_HOURS);
  const deliveryRanges = useFallback(rangesResult, "A tabela delivery_fee_ranges", []);
  let settings = PUBLIC_FALLBACKS;
  if (!settingsResult.error) settings = { ...PUBLIC_FALLBACKS, ...(settingsResult.data || {}) };
  else if (isMissingTable(settingsResult.error)) setupWarnings.push("A tabela app_settings ainda não existe no Supabase.");
  else throw settingsResult.error;

  return {
    products: (productsResult.data || []).map(normalizeProduct),
    categories,
    businessHours,
    deliveryRanges,
    settings,
    setupWarnings,
  };
}

export function subscribeToStoreChanges(onChange) {
  const channel = supabase.channel("store-admin-live");
  ["products", "categories", "business_hours", "delivery_fee_ranges", "app_settings"].forEach((table) => {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, () => onChange(table));
  });
  channel.subscribe();
  return () => supabase.removeChannel(channel);
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function checkIsAdmin() {
  const { data, error } = await supabase.rpc("is_admin");
  if (error) throw error;
  return data === true;
}

export async function loadAdminOrders() {
  const { data, error } = await supabase
    .from("orders")
    .select("*, order_items(*)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return data || [];
}

function productPayload(product) {
  return {
    id: product.id,
    name: product.name.trim(),
    description: product.description?.trim() || "",
    price: Number(product.price),
    category: product.category,
    image_url: product.image || product.image_url || "",
    status: product.status,
    visible: product.visible !== false,
    featured: Boolean(product.featured),
    sort_order: Number(product.sort_order) || 0,
  };
}

export async function saveProduct(product, isNew) {
  const query = isNew
    ? supabase.from("products").insert(productPayload(product))
    : supabase.from("products").update(productPayload(product)).eq("id", product.id);
  const { data, error } = await query.select("*").single();
  if (error) throw error;
  return normalizeProduct(data);
}

export async function deleteProduct(productId) {
  const { error } = await supabase.from("products").delete().eq("id", productId);
  if (error) throw error;
}

export async function saveCategory(category, isNew) {
  const payload = {
    id: category.id,
    name: category.name.trim(),
    description: category.description?.trim() || "",
    banner_url: category.banner_url?.trim() || "",
    sort_order: Number(category.sort_order) || 0,
    active: category.active !== false,
  };
  const query = isNew
    ? supabase.from("categories").insert(payload)
    : supabase.from("categories").update(payload).eq("id", category.id);
  const { error } = await query;
  if (error) throw error;
}

export async function deleteCategory(categoryId) {
  const { error } = await supabase.from("categories").delete().eq("id", categoryId);
  if (error) throw error;
}

export async function saveBusinessHours(hours) {
  const payload = hours.map((item) => ({
    day_of_week: Number(item.day_of_week),
    is_open: Boolean(item.is_open),
    opening_time: item.is_open ? item.opening_time : null,
    closing_time: item.is_open ? item.closing_time : null,
  }));
  const { error } = await supabase.from("business_hours").upsert(payload, { onConflict: "day_of_week" });
  if (error) throw error;
}

export async function saveDeliveryRange(range, isNew) {
  const payload = {
    min_distance_km: Number(range.min_distance_km),
    max_distance_km: Number(range.max_distance_km),
    fee: Number(range.fee),
    active: range.active !== false,
  };
  const query = isNew
    ? supabase.from("delivery_fee_ranges").insert(payload)
    : supabase.from("delivery_fee_ranges").update(payload).eq("id", range.id);
  const { error } = await query;
  if (error) throw error;
}

export async function deleteDeliveryRange(rangeId) {
  const { error } = await supabase.from("delivery_fee_ranges").delete().eq("id", rangeId);
  if (error) throw error;
}

export async function saveSettings(settings) {
  const payload = {
    id: "global",
    store_name: settings.store_name,
    whatsapp_number: settings.whatsapp_number,
    pix_key: settings.pix_key,
    pix_name: settings.pix_name,
    pix_qr_code_url: settings.pix_qr_code_url,
    brand_logo_url: settings.brand_logo_url,
    brand_hero_url: settings.brand_hero_url,
    timezone: settings.timezone || "America/Sao_Paulo",
    store_latitude: Number(settings.store_latitude),
    store_longitude: Number(settings.store_longitude),
    below_one_km_behavior: settings.below_one_km_behavior,
    below_one_km_fee:
      settings.below_one_km_behavior === "fixed" ? Number(settings.below_one_km_fee) : null,
    maximum_delivery_distance_km: settings.maximum_delivery_distance_km
      ? Number(settings.maximum_delivery_distance_km)
      : null,
    card_fee_percent: Number(settings.card_fee_percent) || 0,
  };
  const { error } = await supabase.from("app_settings").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

export function imageStoragePath(publicUrl) {
  const marker = `/storage/v1/object/public/${PRODUCTS_BUCKET}/`;
  const index = String(publicUrl || "").indexOf(marker);
  return index >= 0 ? decodeURIComponent(publicUrl.slice(index + marker.length)) : null;
}

export async function uploadProductImage(file) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const path = `${new Date().getFullYear()}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from(PRODUCTS_BUCKET).upload(path, file, {
    cacheControl: "3600",
    contentType: file.type,
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(PRODUCTS_BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, path };
}

export async function removeProductImage(publicUrl) {
  const path = imageStoragePath(publicUrl);
  if (!path) return;
  const { error } = await supabase.storage.from(PRODUCTS_BUCKET).remove([path]);
  if (error) throw error;
}

export async function placeOrder(payload) {
  const { data, error } = await supabase.rpc("place_order", { p_order: payload });
  if (error) throw error;
  return data;
}
