"use strict";
// Camera lifecycle and snap detector adapted from deniza-png/snap (see ATTRIBUTION.md).
(() => {
  const DEBUG = false;
  const MESSAGE_TYPE = "CLONE_ARMY_BRIDGE_V1";
  const MAX_IMAGE_LENGTH = 7_500_000;
  const SENSITIVITY = { low: 8, medium: 6, high: 4 };
  let nativeGetUserMedia = null, snapGeneration = 0, backgroundGeneration = 0;
  let pendingBackgroundData = "";
  const state = {
    enabled: true, backgroundData: "", backgroundImage: null, hasBackground: false,
    panelPosition: null, sensitivity: "medium", count: 3, size: 0.78, spread: 0.32,
    active: false, snapEnabled: false, snapStarting: false, snapCleanup: null,
    lastAudioTrack: null, pipelines: new Set(), panel: null, collapsed: false,
    captureTimer: null, captureCountdown: 0, captureRawVideo: null,
    personOwned: false, requestId: 0, requests: new Map()
  };
  const log = (...args) => { if (DEBUG) console.debug("[Clone Army]", ...args); };
  const sendBridge = (action, payload = {}) => {
    window.postMessage({ type: MESSAGE_TYPE, action, payload }, location.origin);
  };
  function installCameraWrapper() {
    const devices = navigator.mediaDevices;
    if (!devices || typeof devices.getUserMedia !== "function") return;
    nativeGetUserMedia = devices.getUserMedia.bind(devices);
    try {
      Object.defineProperty(devices, "getUserMedia", {
        configurable: true,
        writable: true,
        value: function (constraints) {
          return nativeGetUserMedia(constraints).then(async (stream) => {
            const videoTracks = stream.getVideoTracks();
            rememberMeetAudio(stream);
            if (!state.enabled || !constraints?.video || videoTracks.length === 0) {
              return stream;
            }

            try {
              return await createCompositeStream(stream, videoTracks[0]);
            } catch (error) {
              console.warn("[Clone Army] Camera compositing failed; using the original stream.", error);
              return stream;
            }
          });
        }
      });
      log("getUserMedia wrapper installed at document_start");
    } catch (error) {
      console.warn("[Clone Army] Could not wrap getUserMedia; camera will remain unchanged.", error);
    }
  }

  function rememberMeetAudio(stream) {
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack || audioTrack === state.lastAudioTrack) return;
    state.lastAudioTrack = audioTrack;
    if (state.enabled && state.snapEnabled) {
      stopSnapDetection();
      startSnapDetection();
    }
  }

  function getCanvasSize(track) {
    const settings = track.getSettings ? track.getSettings() : {};
    let width = Math.round(settings.width || 1280);
    let height = Math.round(settings.height || 720);
    if (!width || !height) {
      width = 1280;
      height = 720;
    }
    const scale = Math.min(1, 1280 / width, 720 / height);
    return {
      width: Math.max(2, Math.round(width * scale)),
      height: Math.max(2, Math.round(height * scale))
    };
  }

  function waitForVideoFrame(video, rawTrack) {
    return new Promise((resolve, reject) => {
      let timeout;
      let settled = false;
      let playing = false;
      const events = ["loadeddata", "canplay", "playing"];
      const finish = (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        for (const name of events) video.removeEventListener(name, check);
        video.removeEventListener("error", failed);
        rawTrack.removeEventListener("ended", failed);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (playing && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            video.videoWidth > 0 && video.videoHeight > 0) finish();
      };
      const failed = () => finish(new Error("Camera source did not produce a frame."));
      for (const name of events) video.addEventListener(name, check);
      video.addEventListener("error", failed);
      rawTrack.addEventListener("ended", failed);
      timeout = window.setTimeout(failed, 2500);
      try {
        Promise.resolve(video.play()).then(() => {
          playing = true;
          check();
        }, (error) => finish(error));
      } catch (error) {
        finish(error);
      }
      check();
    });
  }

  async function createCompositeStream(rawStream, rawTrack) {
    const dimensions = getCanvasSize(rawTrack);
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!context || typeof canvas.captureStream !== "function") {
      throw new Error("Canvas capture is not supported in this browser.");
    }

    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([rawTrack]);
    video.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:2px;height:2px;opacity:0;pointer-events:none";
    let canvasStream = null;
    let pipeline = null;
    try {
      if (document.documentElement) document.documentElement.appendChild(video);
      await waitForVideoFrame(video, rawTrack);
      if (!state.enabled) {
        video.pause();
        video.srcObject = null;
        video.remove();
        return rawStream;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvasStream = canvas.captureStream(30);
      const replacementTracks = canvasStream.getVideoTracks();
      if (!replacementTracks.length) throw new Error("Canvas did not create a video track.");
      const outputTrack = replacementTracks[0];
      const outputStream = new MediaStream([
        outputTrack,
        ...rawStream.getAudioTracks()
      ]);

      pipeline = {
        canvas,
        context,
        video,
        rawStream,
        rawTrack,
        outputTrack,
        outputTracks: new Map(),
        canvasStream,
        timer: 0,
        raf: 0,
        visibilityHandler: null,
        renderer: null, amount: 0, frameAt: 0, generation: 0,
        personMaskPending: false, personMaskSampleAt: -Infinity,
        lastMaskAt: -Infinity, modelFailed: false,
        cleaned: false,
        draw: null
      };
      state.pipelines.add(pipeline);
      updatePanel();
      guardOutputTrack(pipeline, outputTrack);
      guardStreamClones(pipeline, outputStream);
      rawTrack.addEventListener("ended", () => cleanupPipeline(pipeline), { once: true });

      pipeline.draw = () => drawPipeline(pipeline);
      let lastAnimationDraw = -Infinity;
      const animate = () => {
        pipeline.raf = 0;
        if (pipeline.cleaned || document.visibilityState === "hidden") return;
        const now = performance.now();
        // Bound canvas work to the outgoing 30 fps track.
        if (pipeline.forceDraw || now - lastAnimationDraw >= 1000 / 30 - 1 || allOutputTracksEnded(pipeline)) {
          pipeline.forceDraw = false;
          lastAnimationDraw = now;
          pipeline.draw();
        }
        if (!pipeline.cleaned) pipeline.raf = window.requestAnimationFrame(animate);
      };
      pipeline.visibilityHandler = () => {
        if (pipeline.cleaned) return;
        if (document.visibilityState === "hidden") {
          window.cancelAnimationFrame(pipeline.raf);
          pipeline.raf = 0;
          if (!pipeline.timer) pipeline.timer = window.setInterval(pipeline.draw, 33);
        } else {
          window.clearInterval(pipeline.timer);
          pipeline.timer = 0;
          if (!pipeline.raf) pipeline.raf = window.requestAnimationFrame(animate);
        }
      };
      document.addEventListener("visibilitychange", pipeline.visibilityHandler);
      pipeline.draw();
      pipeline.visibilityHandler();
      return outputStream;
    } catch (error) {
      if (pipeline) cleanupPipeline(pipeline, false);
      else if (canvasStream) {
        for (const track of canvasStream.getTracks()) {
          try { track.stop(); } catch {}
        }
      }
      // Roll back only our resources. The fallback raw camera/audio remain owned by Meet.
      video.pause();
      video.srcObject = null;
      video.remove();
      throw error;
    }
  }

  function allOutputTracksEnded(pipeline) {
    return [...pipeline.outputTracks.keys()].every((track) => track.readyState === "ended");
  }

  function guardOutputTrack(pipeline, track) {
    if (pipeline.outputTracks.has(track)) return;
    const nativeStop = track.stop.bind(track);
    const nativeClone = track.clone.bind(track);
    pipeline.outputTracks.set(track, nativeStop);
    const checkStopped = () => {
      if (!pipeline.cleaned && allOutputTracksEnded(pipeline)) cleanupPipeline(pipeline);
    };
    track.addEventListener("ended", checkStopped);
    try {
      Object.defineProperty(track, "stop", {
        configurable: true,
        value: () => {
          nativeStop();
          checkStopped();
        }
      });
      Object.defineProperty(track, "clone", {
        configurable: true,
        value: () => {
          const clone = nativeClone();
          guardOutputTrack(pipeline, clone);
          return clone;
        }
      });
    } catch (error) {
      log("Track lifecycle methods could not be wrapped; polling stopped tracks.", error);
    }
  }

  function guardStreamClones(pipeline, stream) {
    const nativeClone = stream.clone.bind(stream);
    try {
      Object.defineProperty(stream, "clone", {
        configurable: true,
        value: () => {
          const clone = nativeClone();
          for (const track of clone.getVideoTracks()) guardOutputTrack(pipeline, track);
          guardStreamClones(pipeline, clone);
          return clone;
        }
      });
    } catch (error) {
      log("Could not track stream clones.", error);
    }
  }

  function cleanupPipeline(pipeline, releaseRaw = true) {
    if (pipeline.cleaned) return;
    pipeline.cleaned = true;
    pipeline.generation += 1;
    cancelPersonRequests(pipeline);
    pipeline.renderer?.dispose();
    pipeline.renderer = null;
    window.clearInterval(pipeline.timer);
    window.cancelAnimationFrame(pipeline.raf);
    if (pipeline.visibilityHandler) {
      document.removeEventListener("visibilitychange", pipeline.visibilityHandler);
    }
    pipeline.video.pause();
    pipeline.video.srcObject = null;
    pipeline.video.remove();
    if (releaseRaw) {
      for (const track of pipeline.rawStream.getVideoTracks()) {
        if (track.readyState !== "ended") {
          try { track.stop(); } catch {}
        }
      }
    }
    for (const [track, nativeStop] of pipeline.outputTracks) {
      if (track.readyState !== "ended") {
        try { nativeStop(); } catch {}
      }
    }
    state.pipelines.delete(pipeline);
    if (state.pipelines.size === 0) {
      state.active = false;
      window.clearInterval(state.captureTimer); state.captureTimer = null;
    }
    syncPersonOwnership();
    updatePanel();
    if (state.pipelines.size === 0 && state.snapEnabled) {
      state.snapEnabled = false;
      stopSnapDetection();
      updatePanel();
    }
    if (state.captureRawVideo === pipeline.video) state.captureRawVideo = null;
    log("Camera pipeline stopped and raw camera released");
  }


  function cancelPersonRequests(pipeline) {
    for (const [id, request] of state.requests) {
      if (request.pipeline !== pipeline) continue;
      state.requests.delete(id); window.clearTimeout(request.timer); request.resolve(null);
    }
  }
  function syncPersonOwnership() {
    const active = state.enabled && state.hasBackground && [...state.pipelines].some(p =>
      !p.cleaned && (state.active || p.amount > .001));
    if (active === state.personOwned) return;
    state.personOwned = active;
    sendBridge("PERSON_CONTROL", { enabled: active });
  }
  function handlePersonResult(payload) {
    const request = state.requests.get(payload?.requestId);
    if (!request) return;
    state.requests.delete(payload.requestId); window.clearTimeout(request.timer);
    try {
      if (!payload.ok || !Number.isInteger(payload.width) || !Number.isInteger(payload.height) ||
          payload.width < 1 || payload.height < 1 || payload.width > 512 || payload.height > 512 ||
          typeof payload.mask !== "string" || payload.mask.length > 350000) throw new Error("Bad mask");
      const mask = Uint8Array.from(atob(payload.mask), c => c.charCodeAt(0));
      if (mask.length !== payload.width * payload.height) throw new Error("Bad mask length");
      request.resolve({ width: payload.width, height: payload.height, mask });
    } catch { request.resolve(null); }
  }
  async function refreshPerson(pipeline, now) {
    if (pipeline.personMaskPending || (!state.active && pipeline.amount < .001) ||
        !state.enabled || !state.hasBackground || now - pipeline.personMaskSampleAt < 65) return;
    pipeline.personMaskPending = true; pipeline.personMaskSampleAt = now;
    const generation = pipeline.generation;
    const frame = document.createElement("canvas");
    const sample = document.createElement("canvas");
    try {
      frame.width = pipeline.canvas.width; frame.height = pipeline.canvas.height;
      frame.getContext("2d", { alpha: false }).drawImage(pipeline.video, 0, 0, frame.width, frame.height);
      const scale = Math.min(1, 320 / Math.max(frame.width, frame.height));
      sample.width = Math.max(1, Math.round(frame.width * scale));
      sample.height = Math.max(1, Math.round(frame.height * scale));
      sample.getContext("2d", { alpha: false }).drawImage(frame, 0, 0, sample.width, sample.height);
      const image = sample.toDataURL("image/jpeg", .85);
      if (image.length > 250000) throw new Error("Sample too large");
      const mask = await new Promise(resolve => {
        const requestId = ++state.requestId;
        const timer = window.setTimeout(() => { state.requests.delete(requestId); resolve(null); }, 10000);
        state.requests.set(requestId, { pipeline, timer, resolve });
        sendBridge("PERSON_FRAME", { requestId, image });
      });
      if (pipeline.cleaned || generation !== pipeline.generation) return;
      if (!mask) throw new Error("Local model unavailable");
      if (!pipeline.renderer) pipeline.renderer = new CloneArmyRenderer.Renderer(frame.width, frame.height);
      // Match the mask with the EXACT frame it segmented, avoiding halos on fast hands.
      pipeline.renderer.update(frame, mask);
      pipeline.lastMaskAt = performance.now();
      pipeline.modelFailed = false;
      updatePanel();
    } catch (error) {
      if (!pipeline.cleaned && generation === pipeline.generation && state.active) {
        pipeline.modelFailed = true; state.active = false;
        setPanelMessage("Could not load the local cutout model. Click Summon to retry.", true);
        updatePanel();
      }
      log(error);
    } finally {
      frame.width = sample.width = 1;
      pipeline.personMaskPending = false;
    }
  }
  function drawPipeline(pipeline) {
    if (pipeline.cleaned) return;
    if (allOutputTracksEnded(pipeline)) { cleanupPipeline(pipeline); return; }
    const { context, canvas, video } = pipeline;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;
    const now = performance.now();
    const dt = Math.min(100, Math.max(0, now - pipeline.frameAt)); pipeline.frameAt = now;
    syncPersonOwnership();
    refreshPerson(pipeline, now);
    const fresh = pipeline.renderer?.ready && now - pipeline.lastMaskAt < 1000;
    const target = state.active && state.enabled && state.hasBackground && fresh ? 1 : 0;
    pipeline.amount += Math.sign(target - pipeline.amount) * Math.min(Math.abs(target - pipeline.amount), dt / 420);
    try {
      context.globalAlpha = 1; context.globalCompositeOperation = "source-over";
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (pipeline.amount > 0 && state.backgroundImage && fresh) {
        // Crossfade only the edges of summon/dismiss; full effect is an opaque room + live cutouts.
        if (pipeline.amount < 1) {
          if (!pipeline.composite) { pipeline.composite = document.createElement("canvas"); pipeline.composite.width = canvas.width; pipeline.composite.height = canvas.height; }
          pipeline.renderer.render(pipeline.composite.getContext("2d"), state.backgroundImage, state, pipeline.amount);
          context.globalAlpha = pipeline.amount;
          context.drawImage(pipeline.composite, 0, 0);
          context.globalAlpha = 1;
        } else pipeline.renderer.render(context, state.backgroundImage, state, 1);
      }
    } catch (error) {
      pipeline.amount = 0; state.active = false;
      context.globalAlpha = 1; context.globalCompositeOperation = "source-over";
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      setPanelMessage("Effect paused. Your normal camera is still live.", true); updatePanel(); log(error);
    }
  }
  function setArmy(active) {
    if (active && (!state.enabled || !state.hasBackground)) {
      setPanelMessage("Capture the empty room first, then return to frame.", true); return;
    }
    state.active = Boolean(active);
    for (const p of state.pipelines) { p.forceDraw = true; p.modelFailed = false; }
    syncPersonOwnership(); updatePanel();
  }
  function toggleArmy() { setArmy(!state.active); }
  function loadBackground(dataUrl) {
    if (dataUrl === pendingBackgroundData && state.hasBackground) return;
    const generation = ++backgroundGeneration; pendingBackgroundData = dataUrl;
    state.active = false;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/jpeg;base64,") || dataUrl.length > MAX_IMAGE_LENGTH) {
      state.backgroundImage?.close?.(); state.backgroundImage = null;
      state.backgroundData = ""; state.hasBackground = false;
      if (state.snapEnabled) toggleSnap(false);
      syncPersonOwnership(); updatePanel(); return;
    }
    const image = new Image();
    image.onload = async () => {
      let decoded;
      try { decoded = typeof createImageBitmap === "function" ? await createImageBitmap(image) : image; }
      catch { decoded = image; }
      if (generation !== backgroundGeneration) { decoded?.close?.(); return; }
      state.backgroundImage?.close?.(); state.backgroundImage = decoded;
      state.backgroundData = dataUrl; state.hasBackground = true;
      updatePanel();
    };
    image.onerror = () => {
      if (generation !== backgroundGeneration) return;
      state.hasBackground = false; state.active = false;
      state.backgroundImage?.close?.(); state.backgroundImage = null;
      setPanelMessage("Saved room could not be opened. Capture it again.", true); updatePanel();
    };
    image.src = dataUrl;
  }
  function handleBridgeMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.type !== MESSAGE_TYPE) return;
    if (message.action === "PERSON_RESULT") { handlePersonResult(message.payload); return; }
    if (message.action === "NOTICE") { setPanelMessage(String(message.payload?.text || ""), true); return; }
    if (message.action === "COMMAND_TOGGLE") { toggleArmy(); return; }
    if (message.action !== "CONFIG" || !message.payload) return;
    const p = message.payload;
    state.enabled = p.enabled !== false;
    state.count = p.count === 5 ? 5 : 3;
    state.size = Math.min(1, Math.max(.45, Number(p.size) || .78));
    state.spread = Math.min(.43, Math.max(.15, Number(p.spread) || .32));
    state.panelPosition = p.panelPosition;
    state.sensitivity = ["low", "medium", "high"].includes(p.sensitivity) ? p.sensitivity : "medium";
    if (typeof p.background === "string") loadBackground(p.background);
    if (!state.enabled) { state.active = false; state.snapEnabled = false; stopSnapDetection(); }
    ensurePanel(); syncPersonOwnership(); updatePanel();
  }
  window.addEventListener("message", handleBridgeMessage);
  function savePrefs(values) { sendBridge("SAVE_PREFS", values); }

  function toggleSnap(enabled) {
    if (enabled && (!state.enabled || !state.hasBackground)) return;
    state.snapEnabled = enabled;
    if (!enabled) {
      stopSnapDetection();
      updatePanel();
      return;
    }
    startSnapDetection();
  }

  function stopSnapDetection() {
    snapGeneration += 1;
    if (state.snapCleanup) state.snapCleanup();
    state.snapCleanup = null;
    state.snapStarting = false;
    updateMeter(0, false);
  }

  async function startSnapDetection() {
    if (!state.enabled || !state.snapEnabled || state.snapStarting || state.snapCleanup) return;
    const generation = ++snapGeneration;
    state.snapStarting = true;
    updatePanel();
    let inputTrack = null;
    let audioContext = null;
    let source = null;
    let highpass = null;
    let analyser = null;
    let interval = 0;
    const ownedTracks = [];
    const stillActive = () => generation === snapGeneration && state.enabled && state.snapEnabled;
    // This closure remains safe if a pending permission prompt resolves after cancellation.
    const releaseResources = () => {
      window.clearInterval(interval);
      try { source?.disconnect(); highpass?.disconnect(); analyser?.disconnect(); } catch {}
      if (audioContext && audioContext.state !== "closed") {
        audioContext.close().catch(() => {});
      }
      for (const track of ownedTracks) {
        try { track.stop(); } catch {}
      }
    };
    state.snapCleanup = releaseResources;
    try {
      const meetTrack = state.lastAudioTrack;
      if (meetTrack?.readyState === "live" && meetTrack.enabled && !meetTrack.muted) {
        try {
          inputTrack = meetTrack.clone();
          ownedTracks.push(inputTrack);
        } catch (error) {
          log("Meet audio clone unavailable; trying a separate mic.", error);
        }
      }
      if (!inputTrack) {
        if (!nativeGetUserMedia) throw new Error("getUserMedia is unavailable.");
        // Bypass our wrapper: this microphone belongs to the detector, not Meet.
        const micStream = await nativeGetUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          },
          video: false
        });
        ownedTracks.push(...micStream.getTracks());
        inputTrack = micStream.getAudioTracks()[0];
        if (!inputTrack) throw new Error("No microphone track was returned.");
      }
      if (!stillActive()) {
        releaseResources();
        return;
      }

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Web Audio is unavailable.");
      audioContext = new AudioContextClass();
      source = audioContext.createMediaStreamSource(new MediaStream([inputTrack]));
      highpass = audioContext.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 2000;
      highpass.Q.value = 0.7;
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(highpass);
      highpass.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const history = [];
      let candidate = null;
      let armed = true;
      let previousRms = 0;
      let lastTrigger = -Infinity;
      let lastMeterPost = 0;
      const calibrationUntil = performance.now() + 650;
      await audioContext.resume();
      if (!stillActive()) {
        releaseResources();
        return;
      }

      interval = window.setInterval(() => {
        if (!stillActive()) return;
        if (inputTrack.readyState !== "live") {
          state.snapEnabled = false;
          stopSnapDetection();
          setPanelMessage("Snap microphone stopped. Turn detection on to retry.", true);
          updatePanel();
          return;
        }
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        const now = performance.now();
        const recent = history.length ? history.reduce((total, value) => total + value, 0) / history.length : 0.003;
        const baseline = Math.max(0.003, recent);
        const peakFloor = { low: 0.035, medium: 0.025, high: 0.018 }[state.sensitivity] || 0.025;
        const threshold = Math.max(peakFloor * 0.72, baseline * (SENSITIVITY[state.sensitivity] || 6));

        if (!armed && rms < threshold * 0.45) armed = true;
        if (now >= calibrationUntil && armed && !candidate && rms > threshold &&
            previousRms < threshold * 0.7 && now - lastTrigger >= 1000) {
          candidate = { startedAt: now, peak: rms, baseline };
        } else if (candidate) {
          candidate.peak = Math.max(candidate.peak, rms);
          const age = now - candidate.startedAt;
          if (age <= 115 && rms < candidate.peak * 0.42) {
            const strongEnough = candidate.peak > Math.max(peakFloor, candidate.baseline * 5);
            if (strongEnough && now - lastTrigger >= 1000) {
              lastTrigger = now;
              toggleArmy();
              setPanelMessage("Snap detected.", false, 650);
              flashMeter();
            }
            candidate = null;
          } else if (age > 115) {
            candidate = null;
            armed = false;
          }
        }
        history.push(now < calibrationUntil ? rms : Math.min(rms, baseline * 2));
        if (history.length > 50) history.shift();
        previousRms = rms;
        if (now - lastMeterPost > 45) {
          lastMeterPost = now;
          updateMeter(Math.min(1, rms * 11), false);
        }
      }, 20);
      state.snapStarting = false;
      updatePanel();
      log("Snap detection started");
    } catch (error) {
      releaseResources();
      if (generation === snapGeneration) {
        state.snapCleanup = null;
        state.snapStarting = false;
        state.snapEnabled = false;
        setPanelMessage("Microphone unavailable. Check access and try again.", true);
        updatePanel();
      }
      log("Snap detector setup failed.", error);
    }
  }

  function startCaptureCountdown() {
    if (!state.enabled || state.captureTimer || !state.pipelines.size) return;
    state.active = false;
    state.captureCountdown = 5;
    updatePanel();
    state.captureTimer = window.setInterval(() => {
      state.captureCountdown -= 1;
      if (state.captureCountdown > 0) {
        updatePanel();
        return;
      }
      window.clearInterval(state.captureTimer);
      state.captureTimer = null;
      captureEmptyRoom();
    }, 1000);
  }

  function captureEmptyRoom() {
    const pipeline = [...state.pipelines].reverse().find((item) =>
      !item.cleaned && item.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
    if (!pipeline || !pipeline.video.videoWidth) {
      setPanelMessage("Camera frame not ready. Try again in a moment.", true);
      updatePanel();
      return;
    }

    try {
      const output = document.createElement("canvas");
      const size = getCanvasSize(pipeline.rawTrack);
      output.width = size.width;
      output.height = size.height;
      const ctx = output.getContext("2d");
      ctx.drawImage(pipeline.video, 0, 0, output.width, output.height);
      const dataUrl = output.toDataURL("image/jpeg", 0.82);
      if (dataUrl.length > MAX_IMAGE_LENGTH) {
        setPanelMessage("Image too large to save. Try a lower camera resolution.", true);
        return;
      }
      loadBackground(dataUrl);
      sendBridge("SAVE_BACKGROUND", { image: dataUrl });
      setPanelMessage("Empty room captured.", false, 1600);
    } catch (error) {
      console.warn("[Clone Army] Could not capture a camera frame.", error);
      setPanelMessage("Could not capture a frame. Check camera access.", true);
    }
    updatePanel();
  }

  let messageTimer = 0;
  function setPanelMessage(message, isError = false, duration = 0) {
    if (!state.panel) return;
    const root = state.panel.shadowRoot;
    const target = root?.querySelector("#message");
    if (!target) return;
    target.textContent = message;
    target.classList.toggle("error", Boolean(isError));
    window.clearTimeout(messageTimer);
    if (duration) {
      messageTimer = window.setTimeout(() => {
        target.textContent = "";
        target.classList.remove("error");
      }, duration);
    }
  }

  function updateMeter(level, flash) {
    if (!state.panel) return;
    const root = state.panel.shadowRoot;
    const fill = root?.querySelector("#meter-fill");
    const value = root?.querySelector("#meter");
    if (!fill || !value) return;
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, level)) * 100)}%`;
    value.classList.toggle("flash", Boolean(flash));
  }

  function flashMeter() {
    updateMeter(1, true);
    window.setTimeout(() => updateMeter(0.08, false), 220);
  }

  function ensurePanel() {
    if (state.panel || !document.documentElement) return;
    const host = document.createElement("div"); host.id = "clone-army-panel";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:24px;top:100px";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host{all:initial}*{box-sizing:border-box}button,input,select{font:inherit}
      .panel{width:292px;max-height:calc(100vh - 120px);overflow:auto;padding:20px;background:#161c19;color:#edf2e9;border:1px solid #3c493f;border-radius:20px;box-shadow:0 18px 60px #0005;font:13px/1.5 system-ui,sans-serif}
      .top{display:flex;align-items:center;gap:10px;cursor:move;user-select:none;margin-bottom:20px}.mark{font-size:21px;color:#c6f87b}.title{font-weight:750;font-size:16px;letter-spacing:-.5px;flex:1}.collapse{background:none;color:#aab7ac;border:0;font-size:22px;padding:0 4px;cursor:pointer}
      .eyebrow{font-size:10px;letter-spacing:1.5px;color:#a6b3a7;font-weight:650;text-transform:uppercase}.hint{color:#a6b3a7;font-size:12px;margin:5px 0 12px}
      button{border-radius:10px;cursor:pointer}button:disabled{opacity:.45;cursor:default}.capture{width:100%;padding:10px;background:#263029;border:1px solid #455348;color:#edf2e9}.primary{width:100%;padding:13px;margin:14px 0;background:#c6f87b;border:0;color:#172011;font-weight:750;font-size:14px}.primary:hover{background:#d8ffa3}.primary.active{background:#edf2e9}
      .setting{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:12px 0}.setting label{color:#c3cfc4}.setting input[type=range]{width:118px;accent-color:#c6f87b}.setting input[type=checkbox]{accent-color:#c6f87b;width:17px;height:17px}.setting select{border:1px solid #455348;border-radius:7px;background:#263029;color:#edf2e9;padding:5px 9px}
      .divider{border-top:1px solid #344036;margin:17px 0}.status{font-size:11px;color:#c6f87b}.thumb{width:46px;height:30px;object-fit:cover;border-radius:5px}.room{display:flex;align-items:center;gap:10px;margin-top:10px;color:#a6b3a7;font-size:11px}.message{font-size:11px;color:#b9c6ba;min-height:16px;margin-top:9px}.error{color:#ffb6a4}.meter{height:4px;background:#344036;border-radius:9px;overflow:hidden}.meter-fill{height:100%;background:#c6f87b;width:0}.flash .meter-fill{background:#fff}.shortcut{color:#859889;font-size:10px;text-align:center;margin-top:10px}.collapsed{width:48px;height:48px;background:#c6f87b;color:#172011;font-size:24px;border:1px solid #455348;box-shadow:0 8px 30px #0004}.hidden{display:none!important}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #c6f87b;outline-offset:3px}
    `;
    const node = (tag, attrs = {}, ...children) => {
      const el = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      for (const child of children) el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
      return el;
    };
    const row = (label, input) => node("div", { class:"setting" }, node("label", { for:input.id }, label), input);
    root.appendChild(style);
    root.appendChild(node("section", {id:"full",class:"panel","aria-label":"Clone Army controls"},
      node("div", {id:"drag-handle",class:"top"},node("span",{class:"mark"},"♟♟"),node("span",{class:"title"},"Clone Army"),node("button",{id:"collapse",class:"collapse","aria-label":"Collapse Clone Army"},"−")),
      node("div",{class:"eyebrow"},"One you. More of you."),
      node("p",{id:"setup-hint",class:"hint"},"Turn on your camera to get started."),
      node("button",{id:"capture",class:"capture"},"Capture empty room"),
      node("div",{id:"room",class:"room hidden"},node("img",{id:"thumbnail",class:"thumb",alt:"Saved empty room"}),node("span",{},"Room saved · Keep your camera still")),
      node("button",{id:"toggle",class:"primary"},"Summon clones"),
      node("div",{id:"status-label",class:"status",role:"status"},"Just you"),
      row("Army size",node("select",{id:"count","aria-label":"Army size"},node("option",{value:"3"},"3 of me"),node("option",{value:"5"},"5 of me"))),
      row("Clone size",node("input",{id:"size",type:"range",min:".45",max:"1",step:".01",value:".78","aria-label":"Clone size"})),
      row("Spread",node("input",{id:"spread",type:"range",min:".15",max:".43",step:".01",value:".32","aria-label":"Clone spacing"})),
      node("div",{class:"divider"}),
      row("Snap to summon",node("input",{id:"snap",type:"checkbox","aria-label":"Enable snap detection"})),
      row("Snap sensitivity",node("select",{id:"sensitivity","aria-label":"Snap sensitivity"},node("option",{value:"low"},"Low"),node("option",{value:"medium"},"Medium"),node("option",{value:"high"},"High"))),
      node("div",{id:"meter",class:"meter"},node("div",{id:"meter-fill",class:"meter-fill"})),
      node("div",{id:"message",class:"message",role:"status"}),
      node("div",{class:"shortcut"},"⌥ / Alt + Shift + C · Summon / dismiss")
    ));
    root.appendChild(node("button",{id:"expand",class:"collapsed hidden","aria-label":"Expand Clone Army"},"♟♟"));
    (document.body || document.documentElement).appendChild(host); state.panel = host;
    root.querySelector("#capture").addEventListener("click", startCaptureCountdown);
    root.querySelector("#toggle").addEventListener("click", toggleArmy);
    root.querySelector("#collapse").addEventListener("click", () => { state.collapsed = true; updatePanel(); });
    root.querySelector("#expand").addEventListener("click", () => { state.collapsed = false; updatePanel(); });
    root.querySelector("#snap").addEventListener("change", e => toggleSnap(e.target.checked));
    for (const key of ["count","size","spread","sensitivity"]) {
      const input = root.querySelector("#" + key);
      input.addEventListener("input", e => { state[key] = key === "sensitivity" ? e.target.value : Number(e.target.value); });
      input.addEventListener("change", () => savePrefs({ [key]: state[key] }));
    }
    const handle = root.querySelector("#drag-handle"); let drag = null;
    handle.addEventListener("pointerdown", e => {
      if (e.target.closest("button")) return;
      const rect = host.getBoundingClientRect(); drag = { id:e.pointerId, x:e.clientX-rect.left, y:e.clientY-rect.top };
      handle.setPointerCapture(e.pointerId); e.preventDefault();
    });
    handle.addEventListener("pointermove", e => {
      if (!drag || drag.id !== e.pointerId) return;
      applyPosition(host,{left:e.clientX-drag.x,top:e.clientY-drag.y});
    });
    const end = e => { if (!drag || drag.id !== e.pointerId) return; drag = null;
      const r = host.getBoundingClientRect(); savePrefs({panelPosition:{left:r.left,top:r.top}}); };
    handle.addEventListener("pointerup", end); handle.addEventListener("pointercancel", end);
    if (state.panelPosition) applyPosition(host,state.panelPosition);
    updatePanel();
  }
  function applyPosition(host, position) {
    if (!Number.isFinite(position?.left) || !Number.isFinite(position?.top)) return;
    host.style.left = Math.max(4,Math.min(window.innerWidth-70,position.left))+"px";
    host.style.top = Math.max(4,Math.min(window.innerHeight-55,position.top))+"px";
    host.style.right = "auto"; host.style.bottom = "auto";
  }
  function updatePanel() {
    const root = state.panel?.shadowRoot; if (!root) return;
    state.panel.style.display = state.enabled ? "block" : "none";
    root.querySelector("#full").classList.toggle("hidden",state.collapsed);
    root.querySelector("#expand").classList.toggle("hidden",!state.collapsed);
    const camera = state.pipelines.size > 0;
    const capture = root.querySelector("#capture");
    capture.textContent = state.captureTimer ? `Step out of frame · ${state.captureCountdown}` : state.hasBackground ? "Retake empty room" : "Capture empty room";
    capture.disabled = !camera || !!state.captureTimer;
    root.querySelector("#setup-hint").textContent = !camera ? "Turn on your camera to get started." : state.captureTimer ? "Leave the frame. Stay out until the countdown ends." : state.hasBackground ? "Back in position? Bring in your backup." : "Capture once. Step out for 5 seconds, then return.";
    root.querySelector("#room").classList.toggle("hidden",!state.hasBackground);
    if (state.backgroundData) root.querySelector("#thumbnail").src = state.backgroundData;
    const toggle = root.querySelector("#toggle"); toggle.disabled = !camera || !state.hasBackground || !!state.captureTimer;
    toggle.textContent = state.active ? "Dismiss clones" : "Summon clones"; toggle.classList.toggle("active",state.active);
    const ready = [...state.pipelines].some(p => p.renderer?.ready);
    root.querySelector("#status-label").textContent = state.snapStarting ? "Starting microphone…" : state.active ? ready ? `${state.count} of you · Moving together` : "Preparing your clones…" : "Just you";
    root.querySelector("#snap").checked = state.snapEnabled;
    root.querySelector("#snap").disabled = !state.hasBackground || !camera;
    for (const key of ["count","size","spread","sensitivity"]) root.querySelector("#"+key).value = String(state[key]);
  }
  installCameraWrapper();
  window.addEventListener("pagehide", () => {
    state.active = false; state.snapEnabled = false; stopSnapDetection();
    window.clearInterval(state.captureTimer); state.captureTimer = null;
    for (const p of [...state.pipelines]) cleanupPipeline(p);
  });
  if (document.documentElement) ensurePanel();
  else document.addEventListener("DOMContentLoaded", ensurePanel, {once:true});
})();
