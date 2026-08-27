import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appUrl = new URL("../src/App.jsx", import.meta.url);
const stylesUrl = new URL("../src/styles.css", import.meta.url);

test("card Pix apresenta os quatro passos na ordem correta somente para Pix", async () => {
  const app = await readFile(appUrl, "utf8");
  const pixCard = app.slice(app.indexOf("function PixPaymentCard"), app.indexOf("function PaymentButton"));
  const labels = [
    "Copie a chave Pix",
    "Envie seu pedido para o WhatsApp",
    "Realize o pagamento",
    "Envie o comprovante",
  ];

  assert.match(app, /checkout\.payment === "pix" && <PixPaymentCard/);
  assert.match(pixCard, /Primeiro envie o pedido\. Depois realize o pagamento\./);
  labels.reduce((lastIndex, label) => {
    const index = pixCard.indexOf(label);
    assert.ok(index > lastIndex, `${label} deve aparecer na sequência correta`);
    return index;
  }, -1);
  assert.match(app, /Enviar pedido para WhatsApp/);
  assert.doesNotMatch(pixCard, /Pagar agora/);
});

test("botão Pix copia a chave e anuncia confirmação visual", async () => {
  const app = await readFile(appUrl, "utf8");
  assert.match(app, /navigator\.clipboard\.writeText\(store\.settings\.pix_key\)/);
  assert.match(app, /setPixCopyStatus\("Chave copiada ✓"\)/);
  assert.match(app, /className="copy-pix-button" onClick=\{onCopy\}>Copiar chave Pix/);
  assert.match(app, /role="status" aria-live="polite"/);
});

test("alerta do carrinho é recorrente, depende de itens e limpa os timers", async () => {
  const app = await readFile(appUrl, "utf8");
  const timerEffect = app.slice(app.indexOf("useEffect(() => {\n    let attentionTimeout"), app.indexOf("const subtotal"));

  assert.match(timerEffect, /if \(cartCount <= 0\)/);
  assert.match(timerEffect, /window\.setInterval\([\s\S]*, 3000\)/);
  assert.match(timerEffect, /window\.setTimeout\(\(\) => setCartAttentionActive\(false\), 680\)/);
  assert.match(timerEffect, /window\.clearInterval\(attentionInterval\)/);
  assert.match(timerEffect, /window\.clearTimeout\(attentionTimeout\)/);
  assert.match(app, /cartCount > 0 && cartAttentionActive \? " cart-attention" : ""/);
  assert.match(app, /className=\{`cart-button/);
  assert.match(app, /onClick=\{\(\) => setView\("cart"\)\}/);
  assert.match(app, /cartCount > 0 && <span>\{cartCount\}<\/span>/);
});

test("animação é breve, não bloqueia o clique e respeita redução de movimento", async () => {
  const styles = await readFile(stylesUrl, "utf8");
  assert.match(styles, /\.cart-button\.cart-attention\s*\{[\s\S]*animation: cart-attention-nudge 680ms/);
  assert.match(styles, /@keyframes cart-attention-nudge/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.cart-button\.cart-attention\s*\{[\s\S]*animation: none/);
  assert.doesNotMatch(styles, /\.cart-button\.cart-attention[^{]*\{[^}]*pointer-events:\s*none/);
});

test("adicionar produto mantém o usuário no fluxo atual", async () => {
  const app = await readFile(appUrl, "utf8");
  const addToCart = app.slice(app.indexOf("function addToCart"), app.indexOf("function updateQty"));
  assert.match(addToCart, /setCart/);
  assert.doesNotMatch(addToCart, /setView\("(?:cart|checkout)"\)/);
});
