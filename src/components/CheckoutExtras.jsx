import React, { useState } from "react";
import { ArrowLeft, Plus, ShoppingBag, X } from "lucide-react";

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
}

export function Recommendations({ products, onOpen }) {
  if (!products.length) return null;
  return <section className="recommendations">
    <div><h2>Você também pode gostar</h2><span>Complete seu pedido</span></div>
    <div className="recommendation-row">{products.map((product) => <button type="button" key={product.id} onClick={() => onOpen(product)}>
      <img src={product.image} alt="" /><span><strong>{product.name}</strong><small>{money(product.price)}</small></span><ArrowLeft className="recommendation-arrow" size={17} />
    </button>)}</div>
  </section>;
}

export function ProductDetails({ product, onClose, onAdd }) {
  const [quantity, setQuantity] = useState(1);
  if (!product) return null;
  return <div className="product-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="product-modal" role="dialog" aria-modal="true" aria-label={`Detalhes de ${product.name}`}>
      <button className="product-modal-close" type="button" onClick={onClose} aria-label="Fechar"><X size={20} /></button>
      <img src={product.image} alt={product.name} />
      <h2>{product.name}</h2><p>{product.description}</p><strong>{money(product.price)}</strong>
      <div className="product-modal-qty"><button type="button" onClick={() => setQuantity((value) => Math.max(1, value - 1))}>−</button><b>{quantity}</b><button type="button" onClick={() => setQuantity((value) => Math.min(50, value + 1))}><Plus size={17} /></button></div>
      <button className="primary-action" type="button" onClick={() => onAdd(product, quantity)}><ShoppingBag size={18} />Adicionar ao pedido</button>
    </section>
  </div>;
}
