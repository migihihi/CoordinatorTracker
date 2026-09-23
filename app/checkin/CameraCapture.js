"use client";
import { useEffect, useRef, useState } from "react";
import { compressImageToDataUrl } from "../../lib/geo";

// Full-screen in-app camera. Takes one photo per step, in order, e.g.
//   [{ facing: "user", ... }, { facing: "environment", ... }]
// Live camera only (no gallery), so photos are taken on the spot. Works offline.
// Calls onDone([dataUrl, ...]) after the last step, or onCancel().
export default function CameraCapture({ steps, onDone, onCancel }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileRef = useRef(null);
  const [index, setIndex] = useState(0);
  const [shots, setShots] = useState([]);
  const [preview, setPreview] = useState(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0); // bump to reopen the camera
  const step = steps[index];
  const mirrored = step.facing === "user";

  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  // open the right camera for this step (again after a retake)
  useEffect(() => {
    if (preview) return undefined;
    let cancelled = false;
    (async () => {
      setReady(false);
      setError("");
      stopStream();
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("This phone's browser can't open the camera inside the app.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: step.facing }, width: { ideal: 1280 }, height: { ideal: 1280 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
        }
        setReady(true);
      } catch (e) {
        setError(
          e?.name === "NotAllowedError"
            ? "Camera access is blocked. Allow the camera for this app in your phone's settings, then try again."
            : "Couldn't open the camera. Close other apps using it and try again."
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [index, preview, step.facing, attempt]);

  // always release the camera when closing
  useEffect(() => () => stopStream(), []);

  function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const maxDim = step.maxDim || 900;
    const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    setPreview(canvas.toDataURL("image/jpeg", step.quality || 0.65));
    stopStream();
  }

  // Last resort if the in-app camera can't open: the phone's camera app.
  async function onFallbackFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setPreview(await compressImageToDataUrl(file, step.maxDim || 900, step.quality || 0.65));
      setError("");
    } catch {
      setError("Couldn't read that photo. Try again.");
    }
  }

  function usePhoto() {
    const next = [...shots, preview];
    setPreview(null);
    if (index + 1 < steps.length) {
      setShots(next);
      setIndex(index + 1);
    } else {
      stopStream();
      onDone(next);
    }
  }

  function cancel() {
    stopStream();
    onCancel();
  }

  const isLast = index + 1 === steps.length;

  return (
    <div className="camera-overlay">
      <div className="camera-top">
        <button className="link camera-cancel" onClick={cancel}>Cancel</button>
        <div className="camera-step">
          {steps.length > 1 && <span>Step {index + 1} of {steps.length}</span>}
          <strong>{step.title}</strong>
        </div>
        <span style={{ width: 60 }} />
      </div>

      <div className="camera-stage">
        {preview ? (
          <img src={preview} alt="" className="camera-view" style={{ transform: mirrored ? "scaleX(-1)" : undefined }} />
        ) : (
          <video
            ref={videoRef}
            className="camera-view"
            playsInline
            muted
            autoPlay
            style={{ transform: mirrored ? "scaleX(-1)" : undefined }}
          />
        )}
        {!preview && !ready && !error && <div className="camera-msg">Opening camera...</div>}
        {error && !preview && (
          <div className="camera-msg">
            <p>{error}</p>
            <button className="secondary" style={{ width: "auto" }} onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </button>
            <button className="link" style={{ color: "#fff", marginTop: 8 }} onClick={() => fileRef.current?.click()}>
              Use the phone&apos;s camera app instead
            </button>
            <input ref={fileRef} type="file" accept="image/*" capture={step.facing} style={{ display: "none" }} onChange={onFallbackFile} />
          </div>
        )}
      </div>

      <div className="camera-bottom">
        <p className="camera-hint">{step.hint}</p>
        {preview ? (
          <div className="camera-actions">
            <button className="secondary" onClick={() => setPreview(null)}>Retake</button>
            <button className="primary" onClick={usePhoto}>{isLast ? "Use photo" : "Next"}</button>
          </div>
        ) : (
          <button className="shutter" aria-label="Take photo" disabled={!ready} onClick={capture} />
        )}
      </div>
    </div>
  );
}
