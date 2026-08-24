import React, { useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, MapPin, Minus, Plus } from "lucide-react";
import {
  latLngToWorld,
  MAP_PIN_DEFAULT_ZOOM,
  MAP_PIN_MAX_ZOOM,
  MAP_PIN_MIN_ZOOM,
  MAP_TILE_SIZE,
  worldToLatLng,
} from "../lib/mapLocation.js";

function tileSet(center, zoom, viewport) {
  const world = latLngToWorld(center, zoom);
  const columns = Math.ceil(viewport.width / MAP_TILE_SIZE) + 2;
  const rows = Math.ceil(viewport.height / MAP_TILE_SIZE) + 2;
  const startX = Math.floor(world.x / MAP_TILE_SIZE) - Math.ceil(columns / 2);
  const startY = Math.floor(world.y / MAP_TILE_SIZE) - Math.ceil(rows / 2);
  const limit = 2 ** zoom;
  const tiles = [];

  for (let column = 0; column <= columns; column += 1) {
    for (let row = 0; row <= rows; row += 1) {
      const tileX = startX + column;
      const tileY = startY + row;
      if (tileY < 0 || tileY >= limit) continue;
      const wrappedX = ((tileX % limit) + limit) % limit;
      tiles.push({
        key: `${zoom}-${tileX}-${tileY}`,
        url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`,
        left: tileX * MAP_TILE_SIZE - world.x + viewport.width / 2,
        top: tileY * MAP_TILE_SIZE - world.y + viewport.height / 2,
      });
    }
  }
  return tiles;
}

export default function MapLocationPicker({
  initialLocation,
  address,
  onConfirm,
  onReview,
  onUseCurrentLocation,
  locatingCurrentPosition = false,
}) {
  const [center, setCenter] = useState({
    latitude: Number(initialLocation.latitude),
    longitude: Number(initialLocation.longitude),
  });
  const [zoom, setZoom] = useState(MAP_PIN_DEFAULT_ZOOM);
  const [viewport, setViewport] = useState({ width: 390, height: 360 });
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const mapRef = useRef(null);
  const dragRef = useRef(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  useEffect(() => {
    const element = mapRef.current;
    if (!element) return undefined;
    const updateSize = () => setViewport({ width: element.clientWidth || 390, height: element.clientHeight || 360 });
    updateSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSize);
      return () => window.removeEventListener("resize", updateSize);
    }
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const tiles = useMemo(() => tileSet(center, zoom, viewport), [center, zoom, viewport]);

  function startDrag(event) {
    const world = latLngToWorld(center, zoom);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, world };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveMap(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setCenter(worldToLatLng({
      x: drag.world.x - (event.clientX - drag.x),
      y: drag.world.y - (event.clientY - drag.y),
    }, zoom));
  }

  function endDrag(event) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  function nudge(x, y) {
    const world = latLngToWorld(center, zoom);
    setCenter(worldToLatLng({ x: world.x + x, y: world.y + y }, zoom));
  }

  async function confirm() {
    if (confirming) return;
    setConfirming(true);
    setMessage("");
    try {
      await onConfirm(center);
    } catch (error) {
      setMessage(error.message || "Não foi possível confirmar este ponto.");
    } finally {
      setConfirming(false);
    }
  }

  async function useCurrentLocation() {
    setMessage("");
    try {
      await onUseCurrentLocation();
    } catch (error) {
      setMessage(error.message || "Não foi possível obter sua localização atual.");
    }
  }

  return <div className="map-picker-backdrop" role="dialog" aria-modal="true" aria-labelledby="map-picker-title">
    <section className="map-picker-sheet">
      <header className="map-picker-header">
        <div><h2 id="map-picker-title">Confirme o local da entrega</h2><p>Não encontramos o número exato. Ajuste o ponto no mapa para indicar onde o pedido será entregue.</p></div>
      </header>
      <div
        ref={mapRef}
        className="map-canvas"
        role="application"
        aria-label="Mapa para ajustar o ponto de entrega"
        tabIndex="0"
        onPointerDown={startDrag}
        onPointerMove={moveMap}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(event) => {
          const movements = { ArrowUp: [0, -30], ArrowDown: [0, 30], ArrowLeft: [-30, 0], ArrowRight: [30, 0] };
          if (movements[event.key]) { event.preventDefault(); nudge(...movements[event.key]); }
        }}
      >
        {tiles.map((tile) => <img key={tile.key} className="map-tile" src={tile.url} alt="" draggable="false" style={{ left: tile.left, top: tile.top }} />)}
        <div className="map-center-pin" aria-hidden="true"><MapPin size={42} fill="currentColor" /></div>
        <div className="map-zoom-controls">
          <button type="button" onClick={() => setZoom((value) => Math.min(MAP_PIN_MAX_ZOOM, value + 1))} aria-label="Aumentar zoom"><Plus size={18} /></button>
          <button type="button" onClick={() => setZoom((value) => Math.max(MAP_PIN_MIN_ZOOM, value - 1))} aria-label="Diminuir zoom"><Minus size={18} /></button>
        </div>
        <a className="map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>
      </div>
      <div className="map-address-summary"><strong>{address.street}, {address.number}</strong><span>{address.neighborhood}</span></div>
      {message && <p className="map-picker-error">{message}</p>}
      <div className="map-picker-actions">
        <button type="button" className="map-confirm-button" onClick={confirm} disabled={confirming}>{confirming ? "Confirmando..." : "Confirmar este local"}</button>
        <button type="button" className="map-current-button" onClick={useCurrentLocation} disabled={locatingCurrentPosition}><Crosshair size={17} />{locatingCurrentPosition ? "Obtendo localização..." : "Usar minha localização atual"}</button>
        <button type="button" className="map-review-button" onClick={onReview}>Voltar e revisar endereço</button>
      </div>
    </section>
  </div>;
}
