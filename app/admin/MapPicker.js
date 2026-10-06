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
const PH_BBOX = "116.9,4.5,126.7,21.2"; // minLon,minLat,maxLon,maxLat

const inPH = (la, ln) => la >= 4.5 && la <= 21.2 && ln >= 116.9 && ln <= 126.7;

// "14.6567, 121.0300", "14.6567 121.0300", a Google Maps URL (@lat,lng / !3dlat!4dlng / q=lat,lng),
// or degrees-minutes-seconds like 14°39'24.1"N 121°01'48.0"E. Returns [lat, lng] or null.
function parseCoordinates(text) {
  const t = text.trim();
  const pick = (a, b) => {
    const la = parseFloat(a);
    const ln = parseFloat(b);
    return Number.isFinite(la) && Number.isFinite(ln) && inPH(la, ln) ? [la, ln] : null;
  };
  let m = t.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (m) return pick(m[1], m[2]);
  m = t.match(/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if (m) return pick(m[1], m[2]);
  m = t.match(/[?&](?:q|ll|query|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i);
  if (m) return pick(m[1], m[2]);
  m = t.match(/^\(?\s*(-?\d{1,2}\.\d+)\s*[,\s]\s*(-?\d{2,3}\.\d+)\s*\)?$/);
  if (m) return pick(m[1], m[2]);
  const dms = /(\d+)\s*°\s*(\d+)\s*['′]\s*([\d.]+)\s*["″]?\s*([NSEW])/gi;
  const parts = [...t.matchAll(dms)];
  if (parts.length === 2) {
    const val = (p) => {
      const v = Number(p[1]) + Number(p[2]) / 60 + Number(p[3]) / 3600;
      return /[SW]/i.test(p[4]) ? -v : v;
    };
    const a = parts.find((p) => /[NS]/i.test(p[4]));
    const b = parts.find((p) => /[EW]/i.test(p[4]));
    if (a && b) return pick(val(a), val(b));
  }
  return null;
}

async function searchPhoton(text) {
  try {
    const res = await fetch(
      `https://photon.komoot.io/api/?limit=8&bbox=${PH_BBOX}&q=${encodeURIComponent(text)}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.features || [])
      .map((f) => {
        const [lon, lat] = f.geometry?.coordinates || [];
        const p = f.properties || {};
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inPH(lat, lon)) return null;
        const street = [p.housenumber, p.street].filter(Boolean).join(" ");
        const area = [street, p.district || p.locality, p.city || p.county, p.state].filter(Boolean);
        const label = p.name || street || p.city || "Place";
        return {
          id: `p-${p.osm_type}-${p.osm_id}`,
          lat,
          lon,
          label,
          detail: [...new Set(area)].filter((x) => x !== label).join(", "),
          address: [label, ...new Set(area)].filter(Boolean).join(", "),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function searchNominatim(text) {
  try {
    const res = await fetch(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=ph&q=" + encodeURIComponent(text),
      { headers: { "Accept-Language": "en" } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((r) => {
      const [first, ...rest] = String(r.display_name || "").split(", ");
      return {
        id: `n-${r.place_id}`,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        label: r.name || first || "Place",
        detail: rest.filter((x) => x !== "Philippines").slice(0, 3).join(", "),
        address: r.display_name,
      };
    }).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  } catch {
    return [];
  }
}
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
    setError("");
    setResults([]);

    // Pasted coordinates or a Google Maps link: jump straight there.
    const coords = parseCoordinates(text);
    if (coords) {
      onPickRef.current?.({ lat: coords[0], lng: coords[1] });
      mapRef.current?.setView(coords, 17);
      setQuery("");
      return;
    }
    if (/maps\.app\.goo\.gl|goo\.gl\/maps/i.test(text)) {
      setError("Short Google Maps links can't be read here. In Google Maps, right-click (or long-press) the spot and copy the coordinates, then paste them here.");
      return;
    }

    setSearching(true);
    try {
      // Two OpenStreetMap search services: Photon understands partial and
      // misspelled names; Nominatim is better with full addresses.
      const [photon, nominatim] = await Promise.all([searchPhoton(text), searchNominatim(text)]);
      const seen = new Set();
      const merged = [];
      for (const r of [...photon, ...nominatim]) {
        const key = `${r.lat.toFixed(4)},${r.lon.toFixed(4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }
      setResults(merged.slice(0, 8));
      if (!merged.length) {
        setError("No places found. Try a shorter name (e.g. \"SM North\"), the street or city, or paste the coordinates from Google Maps.");
      }
    } catch {
      setError("Search isn't available right now. Paste the coordinates from Google Maps, or tap the map to drop the pin.");
    } finally {
      setSearching(false);
    }
  }

  function choose(r) {
    onPickRef.current?.({ lat: r.lat, lng: r.lon, address: r.address || r.label });
    mapRef.current?.setView([r.lat, r.lon], 17);
    setResults([]);
    setQuery("");
  }

  return (
    <div className="map-picker">
      <div className="map-search">
        <input
          placeholder="Search a place, or paste coordinates from Google Maps"
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
            <button type="button" key={r.id} onClick={() => choose(r)}>
              <b>{r.label}</b>{r.detail ? <span className="muted"> · {r.detail}</span> : null}
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
