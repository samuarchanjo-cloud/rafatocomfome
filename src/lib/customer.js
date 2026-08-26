const AVAILABLE_STATUS = new Set(["disponivel", "disponível"]);

function normalizedStatus(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

export function isCurrentlyAvailable(product) {
  return product?.visible !== false && AVAILABLE_STATUS.has(normalizedStatus(product?.status));
}

export function recommendProducts(products, cart, { limit = 4, storeOpen = true } = {}) {
  if (!storeOpen) return [];
  const cartIds = new Set((cart || []).map((item) => item.id));
  const cartCategories = new Set(
    (products || []).filter((product) => cartIds.has(product.id)).map((product) => product.category),
  );
  return (products || [])
    .filter((product) => !cartIds.has(product.id) && isCurrentlyAvailable(product))
    .sort((first, second) => {
      const firstDifferent = cartCategories.has(first.category) ? 0 : 1;
      const secondDifferent = cartCategories.has(second.category) ? 0 : 1;
      return secondDifferent - firstDifferent
        || Number(Boolean(second.featured)) - Number(Boolean(first.featured))
        || Number(first.sort_order || 0) - Number(second.sort_order || 0)
        || String(first.name).localeCompare(String(second.name), "pt-BR");
    })
    .slice(0, limit);
}

export function rebuildCartFromOrder(order, products) {
  const availableById = new Map((products || []).filter(isCurrentlyAvailable).map((product) => [String(product.id), product]));
  const cart = [];
  const unavailable = [];
  for (const item of order?.order_items || []) {
    const product = availableById.get(String(item.product_id));
    if (!product) {
      unavailable.push(item.product_name || "Item indisponível");
      continue;
    }
    cart.push({ id: product.id, qty: Math.max(1, Math.min(50, Number(item.quantity) || 1)) });
  }
  return { cart, unavailable };
}

export function savedAddressToCheckout(address) {
  return {
    postalCode: address?.postcode || "",
    street: address?.street || "",
    number: address?.number || "",
    complement: address?.complement || "",
    neighborhood: address?.neighborhood || "",
    city: address?.city || "",
    state: address?.state || "",
    reference: address?.reference || "",
  };
}

export function checkoutDraft(checkout, deliveryLocation, view) {
  const safeCheckout = { ...checkout };
  delete safeCheckout.password;
  delete safeCheckout.accountPassword;
  return { checkout: safeCheckout, deliveryLocation, view: ["cart", "checkout"].includes(view) ? view : "home" };
}
