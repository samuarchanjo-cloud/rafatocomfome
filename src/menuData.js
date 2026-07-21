// Valores públicos usados apenas enquanto a migração do Supabase ainda não foi aplicada.
// Após a migração, app_settings, categories e business_hours são a fonte oficial.
export const PUBLIC_FALLBACKS = {
  store_name: "Rafa, tô com fome",
  whatsapp_number: "5521981720710",
  pix_key: "43577769000180",
  pix_name: "Rafaela Sardinha Ferreira",
  pix_qr_code_url:
    "https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/qrcode-pix_1_rilq1x",
  brand_logo_url: "https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/logo_fih38z",
  brand_hero_url:
    "https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/banner_principal_ubjelk",
  timezone: "America/Sao_Paulo",
  store_latitude: -22.943800658459434,
  store_longitude: -43.582438704219854,
  below_one_km_behavior: "blocked",
  below_one_km_fee: null,
  maximum_delivery_distance_km: null,
  card_fee_percent: 5,
};

export const FALLBACK_CATEGORIES = [
  {
    id: "combos",
    name: "Combos",
    banner_url: "https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/banner_combos_opyqqk",
    description: "As melhores combinações para matar a fome.",
    sort_order: 1,
    active: true,
  },
  {
    id: "hamburgueres",
    name: "Hambúrgueres",
    banner_url:
      "https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/banne_hamburguer_oev7ts",
    description: "Montados do jeito que a fome merece.",
    sort_order: 2,
    active: true,
  },
  {
    id: "pasteis",
    name: "Pastéis",
    banner_url: "https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/banner_pasteis_svicgt",
    description: "Crocantes por fora, recheados por dentro.",
    sort_order: 3,
    active: true,
  },
  {
    id: "porcoes",
    name: "Porções",
    banner_url:
      "https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/banner_por%C3%A7%C3%B5es_ultb2k",
    description: "Perfeitas para compartilhar.",
    sort_order: 4,
    active: true,
  },
  {
    id: "bebidas",
    name: "Bebidas",
    banner_url: "https://res.cloudinary.com/ddc8f5ani/image/upload/f_auto,q_auto/BANNER_BEBIDAS_gxdtxj",
    description: "A companhia perfeita para seu pedido.",
    sort_order: 5,
    active: true,
  },
];

export const FALLBACK_BUSINESS_HOURS = [
  { day_of_week: 0, is_open: true, opening_time: "19:00", closing_time: "23:00" },
  { day_of_week: 1, is_open: false, opening_time: null, closing_time: null },
  { day_of_week: 2, is_open: false, opening_time: null, closing_time: null },
  { day_of_week: 3, is_open: true, opening_time: "19:00", closing_time: "23:00" },
  { day_of_week: 4, is_open: true, opening_time: "19:00", closing_time: "23:00" },
  { day_of_week: 5, is_open: true, opening_time: "19:00", closing_time: "23:00" },
  { day_of_week: 6, is_open: true, opening_time: "19:00", closing_time: "23:00" },
];
