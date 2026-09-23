"use client";
import { useEffect, useRef, useState } from "react";

// Leaflet + OpenStreetMap, loaded from a CDN only when an admin opens a map
// (keeps it out of the coordinators' app entirely).
let leafletPromise = null;
function loadLeaflet() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(css);
      const script = document.createElement("script");
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.onload = () => resolve(window.L);
      script.onerror = () => {
        leafletPromise = null;
        reject(new Error("The map couldn't load. You can still type the latitude and longitude."));
      };
      document.head.appendChild(script);
    });
  }
  return leafletPromise;
}

const MANILA = [14.5995, 120.9842];
const num = (v) => (v === "" || v == null ? NaN : parseFloat(v));

// Props: lat, lng, radius (meters), onPick({ lat, lng, address? })
export default function MapPicker({ lat, lng, radius = 200, onPick }) {
  const boxRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const circleRef = useRef(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const hasPin = Number.isFinite(num(lat)) && Number.isFinite(num(lng));

  // create the map once
  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then((L) => {
        if (cancelled || !boxRef.current || mapRef.current) return;
        const start = hasPin ? [num(lat), num(lng)] : MANILA;
        const map = L.map(boxRef.current, { scrollWheelZoom: false }).setView(start, hasPin ? 17 : 12);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "&copy; OpenStreetMap contributors",
        }).addTo(map);
        map.on("click", (e) => onPickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
        mapRef.current = map;
        setReady(true);
        setTimeout(() => map.invalidateSize(), 150);
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
        circleRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep the pin and radius circle in sync with the form
  useEffect(() => {
    const L = typeof window !== "undefined" ? window.L : null;
    const map = mapRef.current;
    if (!L || !map) return;
    if (!hasPin) {
      markerRef.current?.remove();
      circleRef.current?.remove();
      markerRef.current = null;
      circleRef.current = null;
      return;
    }
    const pos = [num(lat), num(lng)];
    const r = Math.max(10, num(radius) || 200);
    if (!markerRef.current) {
      markerRef.current = L.marker(pos, { draggable: true, autoPan: true }).addTo(map);
      markerRef.current.on("dragend", (ev) => {
        const p = ev.target.getLatLng();
        onPickRef.current?.({ lat: p.lat, lng: p.lng });
      });
    } else {
      markerRef.current.setLatLng(pos);
    }
    if (!circleRef.current) {
      circleRef.current = L.circle(pos, { radius: r, color: "#1A6BA3", weight: 1, fillOpacity: 0.12 }).addTo(map);
    } else {
      circleRef.current.setLatLng(pos);
      circleRef.current.setRadius(r);
    }
    if (!map.getBounds().contains(pos)) map.setView(pos, Math.max(map.getZoom(), 16));
  }, [lat, lng, radius, hasPin, ready]);

  async function search() {
    const text = query.trim();
    if (!text) return;
    setSearching(true);
    setError("");
    setResults([]);
    try {
      const url =
        "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=ph&q=" +
        encodeURIComponent(text);
      const res = await fetch(url, { headers: { "Accept-Language": "en" } });
      const data = await res.json();
      setResults(Array.isArray(data) ? data : []);
      if (!data?.length) setError("No places found. Try another name, or tap the map to drop the pin.");
    } catch {
      setError("Search isn't available right now. Tap the map to drop the pin instead.");
    } finally {
      setSearching(false);
    }
  }

  function choose(r) {
    const la = parseFloat(r.lat);
    const ln = parseFloat(r.lon);
    onPickRef.current?.({ lat: la, lng: ln, address: r.display_name });
    mapRef.current?.setView([la, ln], 17);
    setResults([]);
    setQuery("");
  }

  return (
    <div className="map-picker">
      <div className="map-search">
        <input
          placeholder="Search a place or address (e.g. SM North EDSA)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault(); // don't submit the surrounding form
              search();
            }
          }}
        />
        <button type="button" className="secondary" onClick={search} disabled={searching}>
          {searching ? "Searching..." : "Search"}
        </button>
      </div>
      {results.length > 0 && (
        <div className="map-results">
          {results.map((r) => (
            <button type="button" key={r.place_id} onClick={() => choose(r)}>
              {r.display_name}
            </button>
          ))}
        </div>
      )}
      {error && <p className="muted" style={{ margin: "4px 0 8px" }}>{error}</p>}
      <div ref={boxRef} className="map-box" />
      <p className="muted" style={{ margin: "6px 0 10px", fontSize: "0.8rem" }}>
        {hasPin
          ? "Drag the pin or tap the map to adjust. The circle is the check-in radius."
          : "Search above, or tap the map to drop the pin on the site's entrance."}
      </p>
    </div>
  );
}
