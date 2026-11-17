# Clone Army for Google Meet

A personal prototype: summon three or five live versions of yourself, all following the same movements. Includes a private camera studio, a floating Meet panel, size and spacing controls, a keyboard shortcut, and optional local finger-snap detection.

## Try it

1. Load the `extension` folder through Chrome → Extensions → Developer mode → Load unpacked.
2. Disable Meet Vanish or any other extension that replaces your camera stream, then reload existing Meet tabs. Turn off Meet's own backgrounds and effects for the intended appearance.
3. Click the Clone Army toolbar icon → **Open camera studio**. No meeting is created.
4. Enable your camera. Click **Capture empty room** in the floating panel, and step out during the five-second countdown. Keep the camera and lighting still.
5. Return to frame and click **Summon clones**. Choose **3 of me** or **5 of me**, and adjust size and spread.
6. Optional: enable **Snap to summon** and allow microphone access. Snap again to dismiss. Start with medium sensitivity.
7. Open Google Meet, enable your camera, and use the same panel. Retake the room if you move the camera or change its framing.

Shortcut in Meet: **Option/Alt + Shift + C**. Chrome assigns extension shortcuts at `chrome://extensions/shortcuts`. The studio supports this shortcut directly.

The copies reproduce your current movements; they do not perform independent actions or play recorded loops. All foreground copies use the same segmented camera frame so their poses match. The cutout update rate depends on local inference speed; the outgoing canvas track is 30 fps at up to 1280×720. That is not a guarantee of 30 unique segmented frames per second.

## What stays local

The bundled MediaPipe person model runs in an extension offscreen document. No API key, cloud inference, analytics, or runtime CDN is used. The room JPEG and settings are stored in Chrome extension storage; transient camera samples are discarded after segmentation. Google Meet sends the resulting video to your meeting normally. Call audio passes through unchanged. Snap detection may use an extra local microphone stream; disabling it or stopping the camera releases that stream.

The camera studio requests only video until you opt into snap detection. It does not start a call or record you.

## Behavior and limits

- Google Meet in desktop Chrome 116+ only; no Zoom/Teams/system virtual camera.
- Disable other camera-effect extensions before use. Reload Meet after changing enabled extensions.
- Capture a genuinely empty room; anyone in the saved room image will remain there.
- Use steady lighting and a fixed camera. Segmentation can clip hair, fingers, and similar-colored clothing. Faster gestures may show a lower cutout frame rate.
- Speech, claps, or sharp noises can resemble snaps. Lower sensitivity or use the button/shortcut if false triggers occur.
- Browser background throttling and hardware performance affect smoothness. Test with another participant before relying on the effect in a call.
- If segmentation fails, normal live video is retained/restored and the panel offers retry. If the controls are missing, reload Meet and reconnect the camera.
- Keep the unpacked extension folder in place while it is installed. Disabling the in-extension switch restores normal imagery; reconnect the camera for a direct native camera track.

## Source and validation

`extension/` contains the installable Manifest V3 extension. `tests/` contains camera lifecycle, snap detection, background ownership, real-browser renderer, and installed-extension integration checks.

Run with Node.js 22+ from this directory:

```
npm test
```

Browser checks additionally require Playwright with its Chromium browser installed:

```
node tests/browser.cjs
```

Optional environment overrides: `PLAYWRIGHT_MODULE` (absolute package location), `CHROME_EXECUTABLE` (Chromium executable), and `CLONE_TEST_OUTPUT` (artifact directory).

Browser tests use a synthetic camera and an intercepted Meet-origin fixture under Trusted Types. They verify early camera interception, outgoing canvas video, room capture, actual local WASM model loading, 3/5 cutout rendering, shared model lifecycle, and camera cleanup. They do **not** establish real-person segmentation quality or what a remote participant receives in a production Meet call.

See `ATTRIBUTION.md` and `extension/THIRD-PARTY-NOTICES.md` for source provenance and bundled dependency notices.

Implementation references: [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [MediaPipe Image Segmenter](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter).
